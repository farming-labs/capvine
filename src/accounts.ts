import { createHash, randomBytes } from "node:crypto";
import { openAccountDatabase } from "./account-store.ts";

export interface AccountTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  subject: string;
  scopes: string[];
}

export interface AccountProvider {
  id: string;
  binding: string;
  authorizationUrl(input: {
    state: string;
    verifier: string;
    nonce: string;
  }): Promise<string>;
  exchange(input: {
    callback: URL;
    state: string;
    verifier: string;
    nonce: string;
  }): Promise<AccountTokens>;
  refresh(tokens: AccountTokens): Promise<AccountTokens>;
  verify(accessToken: string, subject: string): Promise<void>;
}

export class ReconnectionRequired extends Error {
  override name = "ReconnectionRequired";
}

interface Connection {
  id: string;
  ownerId: string;
  provider: string;
  binding: string;
  status: "connecting" | "connected" | "disconnected" | "reconnect_required";
  subject: string | null;
  scopes: string[];
  tokens: AccountTokens | null;
}
interface Pending {
  connectionId: string;
  ownerId: string;
  session: string;
  verifier: string;
  nonce: string;
  expiresAt: number;
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function validTokens(tokens: AccountTokens) {
  if (
    !/^[\x21-\x7e]{1,16384}$/.test(tokens.accessToken) ||
    !/^[\x21-\x7e]{1,16384}$/.test(tokens.refreshToken) ||
    !Number.isSafeInteger(tokens.expiresAt) ||
    tokens.expiresAt <= Date.now() ||
    !tokens.subject ||
    tokens.subject.length > 200 ||
    !Array.isArray(tokens.scopes) ||
    tokens.scopes.length > 128 ||
    tokens.scopes.some(
      (scope) => typeof scope !== "string" || !scope || scope.length > 2048,
    )
  )
    throw new Error("Invalid provider credentials");
}

export async function openAccountManager(options: {
  directory: string;
  key: Uint8Array;
  providers: AccountProvider[];
}) {
  const providers = new Map(
    options.providers.map((provider) => [provider.id, { ...provider }]),
  );
  if (!providers.size || providers.size !== options.providers.length)
    throw new Error("Invalid providers");
  const store = await openAccountDatabase(options.directory, options.key);
  const jobs = new Set<Promise<unknown>>();
  const queues = new Map<string, Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  function track<T>(run: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error("Account manager is closed"));
    const job = run();
    jobs.add(job);
    void job.then(
      () => jobs.delete(job),
      () => jobs.delete(job),
    );
    return job;
  }
  function owned(ownerId: string, id: string) {
    const record = store.get<Connection>("connection", id);
    if (!record || record.value.ownerId !== ownerId)
      throw new Error("Unknown owned connection");
    return record;
  }
  function providerFor(connection: Connection) {
    const provider = providers.get(connection.provider);
    if (!provider || provider.binding !== connection.binding)
      throw new Error("Provider configuration changed");
    return provider;
  }
  function metadata(connection: Connection) {
    return {
      id: connection.id,
      ownerId: connection.ownerId,
      provider: connection.provider,
      status: connection.status,
      subject: connection.subject,
      scopes: [...connection.scopes],
    };
  }
  return {
    begin(input: {
      ownerId: string;
      sessionId: string;
      connectionId: string;
      provider: string;
    }) {
      return track(async () => {
        if (
          !input.ownerId ||
          input.ownerId.length > 256 ||
          input.sessionId.length < 32 ||
          input.sessionId.length > 1024 ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.connectionId)
        )
          throw new Error("Invalid connection request");
        const provider = providers.get(input.provider);
        if (!provider) throw new Error("Unknown provider");
        const state = randomBytes(32).toString("base64url");
        const verifier = randomBytes(32).toString("base64url");
        const nonce = randomBytes(32).toString("base64url");
        const url = await provider.authorizationUrl({ state, verifier, nonce });
        const connection: Connection = {
          id: input.connectionId,
          ownerId: input.ownerId,
          provider: provider.id,
          binding: provider.binding,
          status: "connecting",
          subject: null,
          scopes: [],
          tokens: null,
        };
        const pending: Pending = {
          connectionId: input.connectionId,
          ownerId: input.ownerId,
          session: digest(input.sessionId),
          verifier,
          nonce,
          expiresAt: Date.now() + 600_000,
        };
        store.insert([
          { kind: "connection", id: connection.id, value: connection },
          { kind: "pending", id: digest(state), value: pending },
        ]);
        return { connectionId: connection.id, url };
      });
    },
    complete(input: { ownerId: string; sessionId: string; callback: URL }) {
      return track(async () => {
        const states = input.callback.searchParams.getAll("state");
        if (states.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(states[0]!))
          throw new Error("Invalid connection response");
        const state = states[0]!;
        const pending = store.get<Pending>("pending", digest(state))?.value;
        if (
          !pending ||
          pending.ownerId !== input.ownerId ||
          pending.session !== digest(input.sessionId) ||
          pending.expiresAt <= Date.now()
        )
          throw new Error("Invalid or expired connection response");
        const record = owned(input.ownerId, pending.connectionId);
        if (record.value.status !== "connecting")
          throw new Error("Connection is not pending");
        store.remove("pending", digest(state));
        try {
          const provider = providerFor(record.value);
          const tokens = await provider.exchange({
            callback: input.callback,
            state,
            verifier: pending.verifier,
            nonce: pending.nonce,
          });
          validTokens(tokens);
          await provider.verify(tokens.accessToken, tokens.subject);
          const value: Connection = {
            ...record.value,
            status: "connected",
            subject: tokens.subject,
            scopes: tokens.scopes,
            tokens,
          };
          store.replace("connection", value.id, record.revision, value);
          return metadata(value);
        } catch {
          throw new Error("Account connection failed; start a new connection");
        }
      });
    },
    inspect(ownerId: string, id: string) {
      if (closed) throw new Error("Account manager is closed");
      return metadata(owned(ownerId, id).value);
    },
    list(ownerId: string, options: { after?: string; limit?: number } = {}) {
      if (closed) throw new Error("Account manager is closed");
      const after = options.after ?? "";
      const limit = options.limit ?? 25;
      if (
        !ownerId ||
        ownerId.length > 256 ||
        !/^[0-9]{0,16}$/.test(after) ||
        !Number.isSafeInteger(Number(after)) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new Error("Invalid account listing");
      const rows = store.scan<Connection>("connection", Number(after), limit);
      return {
        connections: rows
          .filter((row) => row.value.ownerId === ownerId)
          .map((row) => metadata(row.value)),
        nextCursor: rows.length === limit ? rows.at(-1)!.cursor : null,
      };
    },
    disconnect(ownerId: string, id: string) {
      if (closed) throw new Error("Account manager is closed");
      const record = owned(ownerId, id);
      store.replace("connection", id, record.revision, {
        ...record.value,
        status: "disconnected",
        tokens: null,
      });
    },
    withAccessToken<T>(
      input: {
        ownerId: string;
        connectionId: string;
        provider: string;
        subject: string;
      },
      use: (token: string) => Promise<T>,
    ): Promise<T> {
      return track(async () => {
        const previous = queues.get(input.connectionId) ?? Promise.resolve();
        const job = previous
          .catch(() => {})
          .then(async () => {
            let record = owned(input.ownerId, input.connectionId);
            const { value } = record;
            if (
              value.status !== "connected" ||
              !value.tokens ||
              value.provider !== input.provider ||
              value.subject !== input.subject
            )
              throw new ReconnectionRequired(
                "Connection unavailable or mismatched",
              );
            const provider = providerFor(value);
            let tokens = value.tokens;
            const refreshing = tokens.expiresAt <= Date.now() + 30_000;
            try {
              if (refreshing) {
                tokens = await provider.refresh(structuredClone(tokens));
                validTokens(tokens);
                if (
                  tokens.subject !== value.subject ||
                  value.scopes.some((scope) => !tokens.scopes.includes(scope))
                )
                  throw new ReconnectionRequired(
                    "Provider identity or permissions changed",
                  );
                await provider.verify(tokens.accessToken, tokens.subject);
                store.replace("connection", value.id, record.revision, {
                  ...value,
                  tokens,
                });
                record = owned(input.ownerId, input.connectionId);
              } else {
                await provider.verify(tokens.accessToken, input.subject);
              }
            } catch (error) {
              if (error instanceof ReconnectionRequired) {
                const current = owned(input.ownerId, input.connectionId);
                if (current.revision === record.revision)
                  store.replace("connection", value.id, record.revision, {
                    ...value,
                    status: "reconnect_required",
                    tokens: null,
                  });
              }
              throw new Error(
                refreshing
                  ? "Account refresh failed"
                  : "Account verification failed",
              );
            }
            if (
              owned(input.ownerId, input.connectionId).revision !==
              record.revision
            )
              throw new Error("Connection changed during request");
            return use(tokens.accessToken);
          });
        queues.set(input.connectionId, job);
        try {
          return await job;
        } finally {
          if (queues.get(input.connectionId) === job)
            queues.delete(input.connectionId);
        }
      });
    },
    close() {
      return (closing ??= (async () => {
        closed = true;
        await Promise.allSettled([...jobs]);
        await store.close();
      })());
    },
  };
}

export type AccountManager = Awaited<ReturnType<typeof openAccountManager>>;
