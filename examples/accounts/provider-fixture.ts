import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { createOidcProvider } from "../../src/oauth.ts";

export async function startProviderFixture(
  options: { redirectUri?: string } = {},
) {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = {
    ...keys.publicKey.export({ format: "jwk" }),
    kid: "fixture-key",
    alg: "RS256",
    use: "sig",
  };
  const clientSecret = randomBytes(32).toString("base64url");
  const redirectUri = options.redirectUri ?? "http://127.0.0.1:8765/callback";
  const scopes = ["openid", "https://www.googleapis.com/auth/gmail.readonly"];
  const codes = new Map<
    string,
    { challenge: string; nonce: string; redirect: string }
  >();
  const access = new Map<string, string>();
  const refresh = new Map<string, string>();
  const controls = {
    invalidGrant: false,
    badNonce: false,
    badAudience: false,
    badIssuer: false,
    badSignature: false,
    wrongSubject: false,
    reducedScope: false,
    omitRefresh: false,
    redirectToken: false,
    oversized: false,
    wrongMessage: false,
    oversizedMessage: false,
    redirectMessage: false,
    shortAccess: true,
    beforeRefresh: async () => {},
    beforeProfile: async () => {},
  };
  const counts = { exchanges: 0, refreshes: 0, reads: 0 };
  let issuer = "";
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(value));
  };
  function jwt(nonce: string) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: "fixture-key" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: controls.badIssuer ? "https://other.example" : issuer,
        aud: controls.badAudience ? "other" : "fixture-client",
        sub: "fixture-subject",
        nonce: controls.badNonce ? "other" : nonce,
        iat: now,
        exp: now + 300,
      }),
    ).toString("base64url");
    const input = `${header}.${payload}`;
    const signature = sign("RSA-SHA256", Buffer.from(input), keys.privateKey);
    if (controls.badSignature) signature[0] = signature[0]! ^ 1;
    return `${input}.${signature.toString("base64url")}`;
  }
  function tokens(initial: boolean, nonce = "") {
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    access.set(accessToken, "fixture-subject");
    refresh.set(refreshToken, "fixture-subject");
    return {
      access_token: accessToken,
      ...(controls.omitRefresh ? {} : { refresh_token: refreshToken }),
      token_type: "Bearer",
      expires_in: initial && controls.shortAccess ? 1 : 3600,
      scope: (controls.reducedScope ? ["openid"] : scopes).join(" "),
      ...(initial ? { id_token: jwt(nonce) } : {}),
    };
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, issuer);
      if (url.pathname === "/authorize") {
        const p = url.searchParams;
        if (
          p.get("client_id") !== "fixture-client" ||
          p.get("redirect_uri") !== redirectUri ||
          p.get("response_type") !== "code" ||
          p.get("code_challenge_method") !== "S256" ||
          !p.get("code_challenge") ||
          !p.get("nonce")
        ) {
          json(response, 400, { error: "invalid_request" });
          return;
        }
        const code = randomBytes(32).toString("base64url");
        codes.set(code, {
          challenge: p.get("code_challenge")!,
          nonce: p.get("nonce")!,
          redirect: redirectUri,
        });
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", p.get("state")!);
        response.writeHead(302, { location: callback.href });
        response.end();
        return;
      }
      if (url.pathname === "/token") {
        if (controls.redirectToken) {
          response.writeHead(302, { location: issuer + "/unexpected" });
          response.end();
          return;
        }
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 32_768) throw new Error();
        }
        const p = new URLSearchParams(body);
        if (
          p.get("client_id") !== "fixture-client" ||
          p.get("client_secret") !== clientSecret
        ) {
          json(response, 401, { error: "invalid_client" });
          return;
        }
        if (p.get("grant_type") === "authorization_code") {
          const code = p.get("code") ?? "";
          const saved = codes.get(code);
          if (
            !saved ||
            saved.redirect !== p.get("redirect_uri") ||
            createHash("sha256")
              .update(p.get("code_verifier") ?? "")
              .digest("base64url") !== saved.challenge
          ) {
            json(response, 400, { error: "invalid_grant" });
            return;
          }
          codes.delete(code);
          counts.exchanges++;
          json(response, 200, tokens(true, saved.nonce));
          return;
        }
        if (p.get("grant_type") === "refresh_token") {
          counts.refreshes++;
          await controls.beforeRefresh();
          const token = p.get("refresh_token") ?? "";
          if (controls.invalidGrant || !refresh.has(token)) {
            json(response, 400, { error: "invalid_grant" });
            return;
          }
          if (!controls.omitRefresh) refresh.delete(token);
          json(response, 200, tokens(false));
          return;
        }
        json(response, 400, { error: "unsupported_grant_type" });
        return;
      }
      if (url.pathname === "/jwks") {
        json(response, 200, { keys: [jwk] });
        return;
      }
      const subject = access.get(
        request.headers.authorization?.replace(/^Bearer /, "") ?? "",
      );
      if (!subject) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      if (url.pathname === "/userinfo") {
        await controls.beforeProfile();
        json(response, 200, {
          sub: controls.wrongSubject ? "other-subject" : subject,
          ...(controls.oversized ? { extra: "x".repeat(140_000) } : {}),
        });
        return;
      }
      if (url.pathname === "/messages/a42") {
        counts.reads++;
        if (controls.redirectMessage) {
          response.writeHead(302, { location: issuer + "/unexpected" });
          response.end();
          return;
        }
        json(response, 200, {
          id: controls.wrongMessage ? "b43" : "a42",
          snippet: controls.oversizedMessage
            ? "x".repeat(140_000)
            : "The report is ready.",
          payload: {
            headers: [{ name: "Subject", value: "Quarterly report" }],
          },
        });
        return;
      }
      json(response, 404, { error: "not_found" });
    } catch {
      if (!response.headersSent)
        json(response, 500, { error: "fixture_error" });
      else response.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  issuer = `http://127.0.0.1:${address.port}`;
  return {
    controls,
    counts,
    issuer,
    redirectUri,
    secrets: () => [clientSecret, ...access.keys(), ...refresh.keys()],
    provider: () =>
      createOidcProvider({
        id: "google",
        issuer,
        clientId: "fixture-client",
        clientSecret,
        redirectUri,
        scopes,
        authorizationEndpoint: issuer + "/authorize",
        tokenEndpoint: issuer + "/token",
        userInfoEndpoint: issuer + "/userinfo",
        jwksUri: issuer + "/jwks",
        allowLoopbackHttp: true,
      }),
    async authorize(url: string) {
      const response = await fetch(url, { redirect: "manual" });
      await response.body?.cancel();
      if (response.status !== 302)
        throw new Error("Fixture authorization failed");
      return new URL(response.headers.get("location")!);
    },
    gmailFetch: (async (input, init) => {
      const url = new URL(String(input));
      if (
        url.origin !== "https://gmail.googleapis.com" ||
        !url.pathname.startsWith("/gmail/v1/users/me/messages/")
      )
        throw new Error("Unexpected Gmail route");
      return fetch(
        `${issuer}${url.pathname.replace("/gmail/v1/users/me", "")}${url.search}`,
        init,
      );
    }) as typeof fetch,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
