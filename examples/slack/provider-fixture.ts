import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { createSlackProvider } from "../../src/slack.ts";

export async function startSlackFixture(
  options: { redirectUri?: string } = {},
) {
  const redirectUri =
    options.redirectUri ?? "http://127.0.0.1:8765/slack/callback";
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  const secrets = new Set<string>();
  const controls = {
    shortAccess: true,
    tokenType: "user",
    appId: "AFIXTURE",
    teamId: "TFIXTURE",
    scope: "channels:history",
    enterpriseInstall: false,
    omitRefresh: false,
    authTeamId: "TFIXTURE",
    authUserId: "UFIXTURE",
    authBot: false,
    authStatus: 200,
    tokenStatus: 200,
    historyStatus: 200,
    authError: "",
    tokenError: "",
    historyError: "",
    wrongTimestamp: false,
    extraMessage: false,
    emptyMessages: false,
    oversized: false,
    redirect: false,
    beforeRefresh: async () => {},
    beforeAuth: async () => {},
  };
  const counts = { exchanges: 0, refreshes: 0, auth: 0, reads: 0 };
  const reads: Record<string, string>[] = [];
  let origin = "";
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(body));
  };
  const tokens = (initial: boolean) => {
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    access.add(accessToken);
    refresh.add(refreshToken);
    secrets.add(accessToken);
    secrets.add(refreshToken);
    const user = {
      access_token: accessToken,
      ...(controls.omitRefresh ? {} : { refresh_token: refreshToken }),
      expires_in: initial && controls.shortAccess ? 1 : 3600,
      token_type: controls.tokenType,
      scope: controls.scope,
    };
    return {
      ok: true,
      app_id: controls.appId,
      team: { id: controls.teamId },
      is_enterprise_install: controls.enterpriseInstall,
      enterprise: null,
      ...(initial ? { authed_user: { ...user, id: "UFIXTURE" } } : user),
    };
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, origin);
      if (url.pathname === "/oauth/v2/authorize") {
        const p = url.searchParams;
        if (
          p.get("client_id") !== "123.456" ||
          p.get("redirect_uri") !== redirectUri ||
          p.get("scope") !== "" ||
          p.get("user_scope") !== "channels:history" ||
          p.get("code_challenge_method") !== "S256" ||
          !p.get("code_challenge") ||
          !p.get("state")
        ) {
          json(response, 400, { ok: false });
          return;
        }
        const code = randomBytes(32).toString("base64url");
        codes.set(code, {
          challenge: p.get("code_challenge")!,
          redirect: redirectUri,
        });
        const callback = new URL(redirectUri);
        callback.search = new URLSearchParams({
          code,
          state: p.get("state")!,
        }).toString();
        response.writeHead(302, { location: callback.href });
        response.end();
        return;
      }
      const history = url.pathname === "/api/conversations.history";
      if (request.method !== (history ? "GET" : "POST")) {
        json(response, 405, { ok: false });
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 32_768) throw new Error();
      }
      const p = history ? url.searchParams : new URLSearchParams(body);
      if (controls.redirect) {
        response.writeHead(307, { location: origin + "/unexpected" });
        response.end();
        return;
      }
      if (url.pathname === "/api/oauth.v2.access") {
        if (controls.tokenStatus !== 200) {
          json(response, controls.tokenStatus, {});
          return;
        }
        if (controls.tokenError) {
          json(response, 200, { ok: false, error: controls.tokenError });
          return;
        }
        if (p.get("client_id") !== "123.456" || p.has("client_secret")) {
          json(response, 200, { ok: false, error: "invalid_client_id" });
          return;
        }
        if (p.get("grant_type") === "refresh_token") {
          counts.refreshes++;
          await controls.beforeRefresh();
          const old = p.get("refresh_token") ?? "";
          if (!refresh.delete(old)) {
            json(response, 200, { ok: false, error: "invalid_refresh_token" });
            return;
          }
          json(response, 200, tokens(false));
          return;
        }
        const code = p.get("code") ?? "";
        const saved = codes.get(code);
        if (
          !saved ||
          p.get("redirect_uri") !== saved.redirect ||
          createHash("sha256")
            .update(p.get("code_verifier") ?? "")
            .digest("base64url") !== saved.challenge
        ) {
          json(response, 200, { ok: false, error: "invalid_grant" });
          return;
        }
        codes.delete(code);
        counts.exchanges++;
        json(response, 200, tokens(true));
        return;
      }
      if (url.pathname === "/api/auth.test") {
        counts.auth++;
        await controls.beforeAuth();
        if (controls.authStatus !== 200) {
          json(response, controls.authStatus, {});
          return;
        }
        if (controls.authError) {
          json(response, 200, { ok: false, error: controls.authError });
          return;
        }
      }
      if (
        !access.has(
          request.headers.authorization?.replace(/^Bearer /, "") ?? "",
        )
      ) {
        json(response, 200, { ok: false, error: "token_revoked" });
        return;
      }
      if (url.pathname === "/api/auth.test") {
        json(response, 200, {
          ok: true,
          team_id: controls.authTeamId,
          user_id: controls.authUserId,
          ...(controls.authBot ? { bot_id: "BFIXTURE" } : {}),
        });
        return;
      }
      if (url.pathname === "/api/conversations.history") {
        counts.reads++;
        reads.push(Object.fromEntries(p));
        if (controls.historyStatus !== 200) {
          json(response, controls.historyStatus, {});
          return;
        }
        if (controls.historyError) {
          json(response, 200, { ok: false, error: controls.historyError });
          return;
        }
        if (
          p.get("channel") !== "CFIXTURE" ||
          p.get("oldest") !== "1700000000.000042" ||
          p.get("latest") !== "1700000000.000042" ||
          p.get("inclusive") !== "true" ||
          p.get("limit") !== "1"
        ) {
          json(response, 200, { ok: false, error: "channel_not_found" });
          return;
        }
        const message = {
          type: "message",
          ts: controls.wrongTimestamp
            ? "1700000000.000043"
            : "1700000000.000042",
          text: controls.oversized
            ? "x".repeat(140_000)
            : "The fixture report is ready.",
          attachments: [{ secret: "not projected" }],
        };
        json(response, 200, {
          ok: true,
          messages: controls.emptyMessages
            ? []
            : controls.extraMessage
              ? [message, message]
              : [message],
        });
        return;
      }
      json(response, 404, { ok: false });
    } catch {
      if (!response.headersSent) json(response, 500, { ok: false });
      else response.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  origin = `http://127.0.0.1:${address.port}`;
  const fixtureFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (
      url.origin !== "https://slack.com" ||
      (url.search && url.pathname !== "/api/conversations.history") ||
      ![
        "/api/oauth.v2.access",
        "/api/auth.test",
        "/api/conversations.history",
      ].includes(url.pathname)
    )
      throw new Error("Unexpected Slack destination");
    return fetch(origin + url.pathname + url.search, init);
  };
  return {
    controls,
    counts,
    reads,
    redirectUri,
    fetch: fixtureFetch,
    secrets: () => [...secrets],
    revoke() {
      access.clear();
      refresh.clear();
    },
    provider: () =>
      createSlackProvider({
        clientId: "123.456",
        appId: "AFIXTURE",
        redirectUri,
        scopes: ["channels:history"],
        fetch: fixtureFetch,
      }),
    async authorize(input: string) {
      const url = new URL(input);
      if (
        url.origin !== "https://slack.com" ||
        url.pathname !== "/oauth/v2/authorize"
      )
        throw new Error("Unexpected authorization destination");
      const response = await fetch(origin + url.pathname + url.search, {
        redirect: "manual",
      });
      await response.body?.cancel();
      if (response.status !== 302)
        throw new Error("Fixture authorization failed");
      return new URL(response.headers.get("location")!);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
