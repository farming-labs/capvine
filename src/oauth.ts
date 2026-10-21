import { createHash } from "node:crypto";
import * as oauth from "oauth4webapi";
import {
  ReconnectionRequired,
  type AccountProvider,
  type AccountTokens,
} from "./accounts.ts";

export function checkedUrl(value: string, allowLoopbackHttp = false): URL {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(
        allowLoopbackHttp &&
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error(
      "Endpoint requires HTTPS or explicitly enabled loopback HTTP",
    );
  return url;
}

export async function boundedFetch(
  url: string,
  init: RequestInit,
  request: typeof fetch = fetch,
): Promise<Response> {
  const response = await request(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.any([
      ...(init.signal ? [init.signal] : []),
      AbortSignal.timeout(10_000),
    ]),
  });
  if (!response.body) return response;
  let size = 0;
  const body = response.body.pipeThrough(
    new TransformStream({
      transform(chunk: Uint8Array, controller) {
        size += chunk.length;
        if (size > 131_072) throw new Error("Provider response too large");
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createOidcProvider(options: {
  id: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userInfoEndpoint: string;
  jwksUri: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  authorizationParams?: Record<string, string>;
  allowLoopbackHttp?: boolean;
  fetch?: typeof fetch;
}): AccountProvider {
  const config = {
    ...options,
    scopes: [...options.scopes],
    authorizationParams: { ...options.authorizationParams },
  };
  if (
    !/^[A-Za-z0-9._-]{1,128}$/.test(config.id) ||
    !config.clientId ||
    !config.clientSecret ||
    !config.scopes.includes("openid") ||
    config.scopes.length > 128 ||
    config.scopes.some((scope) => !scope || /\s/.test(scope))
  )
    throw new Error("Invalid OIDC provider");
  for (const value of [
    config.issuer,
    config.authorizationEndpoint,
    config.tokenEndpoint,
    config.userInfoEndpoint,
    config.jwksUri,
  ])
    checkedUrl(value, config.allowLoopbackHttp);
  const redirect = checkedUrl(config.redirectUri, true);
  if (redirect.search) throw new Error("Callback URL must not contain a query");
  const reserved = [
    "client_id",
    "redirect_uri",
    "response_type",
    "scope",
    "state",
    "nonce",
    "code_challenge",
    "code_challenge_method",
  ];
  if (
    Object.keys(config.authorizationParams).some((key) =>
      reserved.includes(key),
    )
  )
    throw new Error("Reserved authorization parameter");
  const as: oauth.AuthorizationServer = {
    issuer: config.issuer,
    authorization_endpoint: config.authorizationEndpoint,
    token_endpoint: config.tokenEndpoint,
    userinfo_endpoint: config.userInfoEndpoint,
    jwks_uri: config.jwksUri,
  };
  const client: oauth.Client = {
    client_id: config.clientId,
    id_token_signed_response_alg: "RS256",
  };
  const auth = oauth.ClientSecretPost(config.clientSecret);
  const allowed = new Set(
    [config.tokenEndpoint, config.userInfoEndpoint, config.jwksUri].map(
      (url) => new URL(url).href,
    ),
  );
  const requestOptions = {
    [oauth.allowInsecureRequests]: config.allowLoopbackHttp === true,
    [oauth.customFetch]: (
      url: string,
      init: oauth.CustomFetchOptions<string, URLSearchParams | undefined>,
    ) => {
      if (!allowed.has(new URL(url).href))
        throw new Error("Unexpected OAuth destination");
      return boundedFetch(
        url,
        {
          method: init.method,
          headers: init.headers,
          ...(init.body === undefined ? {} : { body: init.body }),
          ...(init.signal === undefined ? {} : { signal: init.signal }),
        },
        config.fetch,
      );
    },
  };
  function tokens(
    result: oauth.TokenEndpointResponse,
    subject: string,
    previous?: AccountTokens,
  ): AccountTokens {
    const scopes =
      result.scope?.split(" ").filter(Boolean) ??
      previous?.scopes ??
      config.scopes;
    if (
      config.scopes.some((scope) => !scopes.includes(scope)) ||
      !Number.isFinite(result.expires_in) ||
      result.expires_in! <= 0 ||
      result.token_type.toLowerCase() !== "bearer"
    )
      throw new ReconnectionRequired(
        "Provider permissions or token lifetime invalid",
      );
    const refreshToken = result.refresh_token ?? previous?.refreshToken;
    if (!refreshToken)
      throw new ReconnectionRequired("Offline access was not granted");
    return {
      accessToken: result.access_token,
      refreshToken,
      subject,
      scopes,
      expiresAt: Date.now() + Math.floor(result.expires_in! * 1000),
    };
  }
  return {
    id: config.id,
    binding: createHash("sha256")
      .update(
        JSON.stringify({
          as,
          client,
          redirect: redirect.href,
          scopes: config.scopes,
        }),
      )
      .digest("hex"),
    async authorizationUrl(input) {
      const url = new URL(config.authorizationEndpoint);
      for (const [key, value] of Object.entries(config.authorizationParams))
        url.searchParams.set(key, value);
      for (const [key, value] of Object.entries({
        client_id: config.clientId,
        redirect_uri: redirect.href,
        response_type: "code",
        scope: config.scopes.join(" "),
        state: input.state,
        nonce: input.nonce,
        code_challenge: await oauth.calculatePKCECodeChallenge(input.verifier),
        code_challenge_method: "S256",
      }))
        url.searchParams.set(key, value);
      return url.href;
    },
    async exchange(input) {
      if (
        input.callback.origin !== redirect.origin ||
        input.callback.pathname !== redirect.pathname ||
        input.callback.hash
      )
        throw new Error("Wrong callback destination");
      const params = oauth.validateAuthResponse(
        as,
        client,
        input.callback,
        input.state,
      );
      const response = await oauth.authorizationCodeGrantRequest(
        as,
        client,
        auth,
        params,
        redirect.href,
        input.verifier,
        requestOptions,
      );
      const result = await oauth.processAuthorizationCodeResponse(
        as,
        client,
        response,
        { expectedNonce: input.nonce, requireIdToken: true },
      );
      await oauth.validateApplicationLevelSignature(
        as,
        response,
        requestOptions,
      );
      return tokens(result, oauth.getValidatedIdTokenClaims(result)!.sub);
    },
    async refresh(previous) {
      try {
        const response = await oauth.refreshTokenGrantRequest(
          as,
          client,
          auth,
          previous.refreshToken,
          requestOptions,
        );
        const result = await oauth.processRefreshTokenResponse(
          as,
          client,
          response,
        );
        if (result.id_token) {
          await oauth.validateApplicationLevelSignature(
            as,
            response,
            requestOptions,
          );
          if (oauth.getValidatedIdTokenClaims(result)!.sub !== previous.subject)
            throw new ReconnectionRequired("Provider identity changed");
        }
        return tokens(result, previous.subject, previous);
      } catch (error) {
        if (
          error instanceof oauth.ResponseBodyError &&
          error.error === "invalid_grant"
        )
          throw new ReconnectionRequired("Provider requires reconnection");
        throw error;
      }
    },
    async verify(accessToken, subject) {
      const response = await oauth.userInfoRequest(
        as,
        client,
        accessToken,
        requestOptions,
      );
      await oauth.processUserInfoResponse(as, client, subject, response);
    },
  };
}

export function createGoogleProvider(options: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): AccountProvider {
  return createOidcProvider({
    ...options,
    id: "google",
    issuer: "https://accounts.google.com",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    userInfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
    jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
    scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
    authorizationParams: { access_type: "offline", prompt: "consent" },
  });
}
