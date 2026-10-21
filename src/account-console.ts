import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AccountManager } from "./accounts.ts";
import { readRequest, RequestError } from "./http-internal.ts";
import {
  dashboard,
  detail,
  login,
  page,
  styles,
  type ConsoleProvider,
} from "./account-console-view.ts";

interface Session {
  authenticated: boolean;
  csrf: string;
  nonce: string;
  expiresAt: number;
}
const random = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest();
const notices: Record<string, string> = {
  connected:
    "Account connected. You can now register its resources with your backend.",
  disconnected:
    "Connection disconnected. Future reads through this connection are blocked.",
  callback_failed:
    "The account could not be connected. Open its entry and reconnect to try again.",
  request_failed:
    "The change could not be completed. Check the connection’s status before trying again.",
};

export async function startAccountConsole(options: {
  accounts: AccountManager;
  ownerId: string;
  loginKey: string;
  providers: ConsoleProvider[];
  port?: number;
}) {
  const { accounts, ownerId } = options;
  const port = options.port ?? 8787;
  const providers = options.providers.map((provider) => ({ ...provider }));
  for (const provider of providers) {
    const url = new URL(provider.authorizationOrigin);
    if (
      url.origin !== provider.authorizationOrigin ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
    )
      throw new Error("Invalid provider authorization origin");
  }
  if (
    !ownerId ||
    ownerId.length > 256 ||
    !/^[A-Za-z0-9_-]{43}$/.test(options.loginKey) ||
    !Number.isSafeInteger(port) ||
    port < 0 ||
    port > 65535 ||
    !providers.length ||
    providers.length > 32 ||
    new Set(providers.map((p) => p.id)).size !== providers.length ||
    providers.some(
      (p) =>
        !/^[a-z][a-z0-9_-]{0,63}$/.test(p.id) ||
        !p.label ||
        p.label.length > 128,
    )
  )
    throw new Error("Invalid console configuration");
  const keyHash = digest(options.loginKey);
  const sessions = new Map<string, Session>();
  const jobs = new Set<Promise<void>>();
  let origin = "";
  let cookieName = "";
  let closing: Promise<void> | undefined;
  let failures = 0;
  let failureWindow = Date.now();
  function cookie(response: ServerResponse, token: string, seconds: number) {
    response.setHeader(
      "set-cookie",
      `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}`,
    );
  }
  function current(request: IncomingMessage) {
    const values = (request.headers.cookie ?? "")
      .split(";")
      .map((value) => value.trim())
      .filter((value) => value.startsWith(`${cookieName}=`));
    if (values.length !== 1) return undefined;
    const token = values[0]!.slice(cookieName.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const id = digest(token).toString("hex");
    const session = sessions.get(id);
    return session && session.expiresAt > Date.now()
      ? { id, session }
      : undefined;
  }
  function newSession(response: ServerResponse, authenticated: boolean) {
    if (sessions.size >= 128) throw new RequestError(429, "Session limit");
    const token = random();
    const seconds = authenticated ? 1800 : 300;
    const session: Session = {
      authenticated,
      csrf: random(),
      nonce: random(),
      expiresAt: Date.now() + seconds * 1000,
    };
    sessions.set(digest(token).toString("hex"), session);
    cookie(response, token, seconds);
    return session;
  }
  function html(response: ServerResponse, status: number, body: string) {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  }
  function redirect(response: ServerResponse, location: string) {
    response.writeHead(303, { location });
    response.end();
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "same-origin");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader(
      "content-security-policy",
      `default-src 'none'; style-src 'self'; form-action 'self' ${providers.map((p) => p.authorizationOrigin).join(" ")}; frame-ancestors 'none'; base-uri 'none'`,
    );
    response.setHeader("cross-origin-opener-policy", "same-origin");
    response.setHeader("connection", "close");
    try {
      for (const [id, session] of sessions)
        if (session.expiresAt <= Date.now()) sessions.delete(id);
      if (closing || jobs.size >= 16)
        throw new RequestError(503, "Unavailable");
      if (request.headers.host !== new URL(origin).host)
        throw new RequestError(403, "Invalid host");
      const raw = request.url ?? "";
      if (
        raw.length > 8192 ||
        !raw.startsWith("/") ||
        raw.startsWith("//") ||
        raw.includes("\\")
      )
        throw new RequestError(400, "Invalid URL");
      const url = new URL(raw, origin);
      if (url.origin !== origin) throw new RequestError(400, "Invalid URL");
      if (request.method !== "GET" && request.method !== "POST") {
        response.setHeader("allow", "GET, POST");
        throw new RequestError(405, "Method not allowed");
      }
      const found = current(request);
      if (request.method === "GET") {
        if (url.pathname === "/style.css") {
          response.writeHead(200, {
            "content-type": "text/css; charset=utf-8",
          });
          response.end(styles);
          return;
        }
        if (url.pathname === "/login") {
          if (found?.session.authenticated) return redirect(response, "/");
          return html(
            response,
            200,
            login((found?.session ?? newSession(response, false)).csrf),
          );
        }
        if (!found?.session.authenticated) return redirect(response, "/login");
        const { session } = found;
        if (url.pathname === "/") {
          const after = url.searchParams.get("after") ?? "";
          const listing = accounts.list(ownerId, { after });
          const notice = url.searchParams.get("notice") ?? "";
          return html(
            response,
            200,
            dashboard({
              ...listing,
              csrf: session.csrf,
              providers,
              after: !!after,
              notice: Object.hasOwn(notices, notice) ? notices[notice]! : "",
            }),
          );
        }
        if (url.pathname === "/connection") {
          const connection = accounts.inspect(
            ownerId,
            url.searchParams.get("id") ?? "",
          );
          return html(response, 200, detail(connection, session.csrf));
        }
        if (url.pathname === "/oauth/callback") {
          response.setHeader("referrer-policy", "no-referrer");
          try {
            await accounts.complete({
              ownerId,
              sessionId: session.nonce,
              callback: url,
            });
            redirect(response, "/?notice=connected");
          } catch {
            redirect(response, "/?notice=callback_failed");
          }
          return;
        }
        throw new RequestError(404, "Not found");
      }
      if (
        request.headers.origin !== origin ||
        request.headers["sec-fetch-site"] === "cross-site"
      )
        throw new RequestError(403, "Invalid origin");
      if (
        request.headers["content-type"]?.split(";")[0] !==
        "application/x-www-form-urlencoded"
      )
        throw new RequestError(415, "Invalid content type");
      if (!found) throw new RequestError(403, "Missing session");
      const fields = new URLSearchParams(
        Buffer.from(await readRequest(request)).toString("utf8"),
      );
      const value = (name: string) => {
        const values = fields.getAll(name);
        if (values.length !== 1) throw new RequestError(400, "Invalid field");
        return values[0]!;
      };
      if (
        current(request)?.session !== found.session ||
        value("csrf") !== found.session.csrf
      )
        throw new RequestError(403, "Invalid session or form");
      const { session } = found;
      if (url.pathname === "/login" && !session.authenticated) {
        if (Date.now() - failureWindow >= 60_000) {
          failureWindow = Date.now();
          failures = 0;
        }
        if (failures >= 10) {
          response.setHeader("retry-after", "60");
          throw new RequestError(429, "Try again later");
        }
        const key = value("key");
        session.csrf = random();
        if (!timingSafeEqual(digest(key), keyHash)) {
          failures++;
          return html(
            response,
            401,
            login(session.csrf, "The access key was not accepted. Try again."),
          );
        }
        sessions.delete(found.id);
        newSession(response, true);
        return redirect(response, "/");
      }
      if (!session.authenticated)
        throw new RequestError(403, "Sign in required");
      session.csrf = random();
      if (url.pathname === "/logout") {
        sessions.delete(found.id);
        cookie(response, "", 0);
        return redirect(response, "/login");
      }
      if (url.pathname === "/connections/disconnect") {
        accounts.disconnect(ownerId, value("id"));
        return redirect(response, "/?notice=disconnected");
      }
      if (
        url.pathname === "/connections/connect" ||
        url.pathname === "/connections/reconnect"
      ) {
        const old =
          url.pathname === "/connections/reconnect"
            ? accounts.inspect(ownerId, value("id"))
            : undefined;
        const provider = old?.provider ?? value("provider");
        if (!providers.some((p) => p.id === provider))
          throw new RequestError(400, "Unknown provider");
        if (old) accounts.disconnect(ownerId, old.id);
        try {
          const started = await accounts.begin({
            ownerId,
            sessionId: session.nonce,
            connectionId: randomUUID(),
            provider,
          });
          if (
            new URL(started.url).origin !==
            providers.find((p) => p.id === provider)!.authorizationOrigin
          )
            throw new Error("Unexpected authorization destination");
          return redirect(response, started.url);
        } catch {
          return redirect(response, "/?notice=request_failed");
        }
      }
      throw new RequestError(404, "Not found");
    } catch (error) {
      html(
        response,
        error instanceof RequestError ? error.status : 400,
        page(
          "Request unavailable",
          '<h1>Request unavailable</h1><p>The request was rejected or could not be completed. Reload the connections page to check its current status.</p><a href="/">Return to connections</a>',
        ),
      );
    } finally {
      request.resume();
    }
  }
  const server = createServer(
    { maxHeaderSize: 16_384, requestTimeout: 15_000, headersTimeout: 10_000 },
    (request, response) => {
      const job = handle(request, response);
      jobs.add(job);
      void job.finally(() => jobs.delete(job));
    },
  );
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Console failed to listen");
  origin = `http://127.0.0.1:${address.port}`;
  cookieName = `capvine_console_${address.port}`;
  return {
    url: origin,
    callbackUrl: origin + "/oauth/callback",
    close() {
      return (closing ??= (async () => {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await Promise.allSettled([...jobs]);
        sessions.clear();
        keyHash.fill(0);
      })());
    },
  };
}
