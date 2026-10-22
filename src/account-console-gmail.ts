import { randomUUID } from "node:crypto";
import { invoke } from "@ucanto/client";
import type { AccountManager } from "./accounts.ts";
import { createGmailAdapter } from "./gmail.ts";
import { boundedFetch } from "./oauth.ts";
import { createAuthority } from "./server.ts";
import { createClient } from "./client.ts";
import { generate } from "@ucanto/principal/ed25519";
import { MemoryStore } from "./memory.ts";
import { encodeGrant } from "./profile.ts";
import {
  PermissionDenied,
  type Grant,
  type Json,
  type ResourceId,
} from "./types.ts";

export type GmailConsoleOptions = {
  source: "google" | "fixture";
  fetch?: typeof fetch;
};
type Selection = {
  id: string;
  connectionId: string;
  subject: string;
  messages: string[];
};
type Event = {
  action: string;
  outcome: "allowed" | "denied" | "done";
  providerCalls: number;
  expected: boolean;
};
export type GmailDemoView = {
  selection: Selection | null;
  run: {
    id: string;
    messageId: string;
    root: string | null;
    child: string | null;
    expiresAt: string | null;
    revoked: boolean;
    active: boolean;
    coordinator: string;
    worker: string;
    providerCalls: number;
    events: Event[];
    result: Json;
  } | null;
};
const actions = [
  "approve",
  "delegate",
  "read",
  "other-resource",
  "write",
  "other-worker",
  "expired",
  "revoke",
  "end-task",
];

export function createGmailDemo(options: {
  accounts: AccountManager;
  ownerId: string;
  sessionExpiresAt: number;
  fetch?: typeof fetch;
}) {
  const { accounts, ownerId } = options;
  let selection: Selection | null = null;
  let run: Awaited<ReturnType<typeof startRun>> | undefined;
  let closed = false;
  function check() {
    if (closed || Date.now() >= options.sessionExpiresAt)
      throw new Error("Session ended");
  }
  function account(id: string) {
    const value = accounts.inspect(ownerId, id);
    if (
      value.status !== "connected" ||
      value.provider !== "google" ||
      !value.subject
    )
      throw new Error("Connected Google account required");
    return { ...value, subject: value.subject };
  }
  async function startRun(selected: Selection, messageId: string) {
    const connected = account(selected.connectionId);
    if (connected.subject !== selected.subject)
      throw new Error("Account changed");
    const [signer, coordinator, worker, otherWorker] = await Promise.all([
      generate(),
      generate(),
      generate(),
      generate(),
    ]);
    const store = new MemoryStore();
    const id = randomUUID();
    const resourceId: ResourceId = `urn:capvine:resource:${id}:selected`;
    const otherId: ResourceId = `urn:capvine:resource:${id}:other`;
    store.addTask({ id, ownerId, active: true });
    let providerCalls = 0;
    const adapter = createGmailAdapter({
      accounts,
      ownerId,
      messages: [
        {
          id: resourceId,
          connectionId: selected.connectionId,
          subject: selected.subject,
          messageId,
        },
        {
          id: otherId,
          connectionId: selected.connectionId,
          subject: selected.subject,
          messageId:
            selected.messages.find((candidate) => candidate !== messageId) ??
            "0",
        },
      ],
      fetch: (input, init) => {
        providerCalls++;
        return (options.fetch ?? fetch)(input, init);
      },
    });
    for (const resource of adapter.resources) store.addResource(resource);
    const authority = createAuthority({
      signer,
      store,
      authorizeGrant: ({ actor, resource, task }) =>
        actor === ownerId &&
        resource.ownerId === ownerId &&
        task.ownerId === ownerId,
    });
    for (const operation of adapter.operations)
      authority.registerOperation(operation);
    const client = (identity: typeof signer) =>
      createClient({
        signer: identity,
        service: authority.principal,
        transport: authority.execute,
      });
    let parent: Grant | undefined;
    let child: Grant | undefined;
    let revoked = false;
    let active = true;
    const events: Event[] = [];
    let result: Json = null;
    const end = () => {
      store.endTask(id);
      active = false;
      result = null;
    };
    return {
      id,
      end,
      view: () => ({
        id,
        messageId,
        root: parent?.cid.toString() ?? null,
        child: child?.cid.toString() ?? null,
        expiresAt:
          child || parent
            ? new Date((child ?? parent)!.expiration * 1000).toISOString()
            : null,
        revoked,
        active,
        coordinator: coordinator.did(),
        worker: worker.did(),
        providerCalls,
        events: structuredClone(events),
        result: structuredClone(result),
      }),
      async act(action: string) {
        check();
        if (!actions.includes(action) || events.length >= 50)
          throw new Error("Invalid action or action limit reached");
        const connected = account(selected.connectionId);
        if (connected.subject !== selected.subject)
          throw new Error("Account changed");
        const before = providerCalls;
        const beforeAudit = store.audit().length;
        let outcome: Event["outcome"] = "done";
        let expected = true;
        result = null;
        if (action === "approve") {
          if (parent || !active)
            throw new Error("Choose a new email before approving again");
          parent = await authority.issue({
            actor: ownerId,
            audience: coordinator,
            taskId: id,
            resource: resourceId,
            action: "gmail/message.read",
            expiresAt: new Date(
              Math.min(Date.now() + 600_000, options.sessionExpiresAt),
            ),
          });
        } else if (action === "delegate") {
          if (!parent || child || revoked || !active)
            throw new Error("Approve before delegating");
          child = await client(coordinator).delegate({
            grant: parent,
            audience: worker,
            expiresAt: new Date(
              Math.min(Date.now() + 300_000, parent.expiration * 1000),
            ),
          });
        } else if (action === "revoke") {
          if (!parent || revoked) throw new Error("No active parent grant");
          store.revoke(parent.cid.toString());
          revoked = true;
        } else if (action === "end-task") {
          end();
        } else {
          if (!child) throw new Error("Delegate before reading or testing");
          const permitted =
            action === "read" &&
            active &&
            !revoked &&
            child.expiration * 1000 > Date.now();
          try {
            if (action === "read") result = await client(worker).invoke(child);
            else {
              const capability = {
                ...child.capabilities[0]!,
                nb: { ...(child.capabilities[0]!.nb as Record<string, Json>) },
              };
              if (action === "other-resource") capability.with = otherId;
              if (action === "write")
                capability.nb.action = "gmail/message.delete";
              const request = await invoke({
                issuer: action === "other-worker" ? otherWorker : worker,
                audience: authority.principal,
                capability,
                proofs: [child],
                expiration: Math.min(
                  child.expiration,
                  Math.floor(Date.now() / 1000) +
                    (action === "expired" ? -60 : 60),
                ),
                nonce: randomUUID(),
              }).delegate();
              result = await authority.execute(await encodeGrant(request));
            }
            outcome = "allowed";
          } catch (error) {
            if (!(error instanceof PermissionDenied)) throw error;
            outcome = "denied";
          }
          const decisions = store.audit().slice(beforeAudit);
          expected =
            outcome === (permitted ? "allowed" : "denied") &&
            decisions.length === 1 &&
            decisions[0]!.outcome === outcome &&
            providerCalls - before === (outcome === "allowed" ? 1 : 0);
        }
        check();
        events.push({
          action,
          outcome,
          expected,
          providerCalls: providerCalls - before,
        });
      },
    };
  }
  return {
    view: (): GmailDemoView => ({
      selection: structuredClone(selection),
      run: run?.view() ?? null,
    }),
    reset() {
      check();
      run?.end();
      run = undefined;
    },
    close() {
      closed = true;
      run?.end();
      run = undefined;
      selection = null;
    },
    async load(connectionId: string) {
      check();
      const connected = account(connectionId);
      const messages = await accounts.withAccessToken(
        {
          ownerId,
          connectionId,
          provider: "google",
          subject: connected.subject,
        },
        async (token) => {
          const response = await boundedFetch(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=5",
            { headers: { authorization: `Bearer ${token}` } },
            options.fetch,
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error("Could not list Gmail messages");
          }
          const data = await response.json();
          if (
            !data ||
            typeof data !== "object" ||
            (data.messages !== undefined && !Array.isArray(data.messages))
          )
            throw new Error("Invalid message list");
          const entries: unknown[] = data.messages ?? [];
          if (entries.length > 5) throw new Error("Unexpected message count");
          return entries.map((entry) => {
            if (
              !entry ||
              typeof entry !== "object" ||
              !("id" in entry) ||
              typeof entry.id !== "string" ||
              !/^[a-fA-F0-9]{1,128}$/.test(entry.id)
            )
              throw new Error("Invalid message ID");
            return entry.id;
          });
        },
      );
      check();
      run?.end();
      run = undefined;
      selection = {
        id: randomUUID(),
        connectionId,
        subject: connected.subject,
        messages: [...new Set(messages)],
      };
    },
    async select(selectionId: string, messageId: string) {
      check();
      if (
        !selection ||
        selection.id !== selectionId ||
        !selection.messages.includes(messageId)
      )
        throw new Error("Select a listed message");
      const next = await startRun(selection, messageId);
      if (closed || Date.now() >= options.sessionExpiresAt) {
        next.end();
        throw new Error("Session ended");
      }
      run?.end();
      run = next;
    },
    async act(id: string, action: string) {
      check();
      if (!run || run.id !== id) throw new Error("Unknown session run");
      await run.act(action);
    },
  };
}
