import { createHash } from "node:crypto";
import * as oauth from "oauth4webapi";
import {
  ReconnectionRequired,
  type AccountProvider,
  type AccountTokens,
} from "./accounts.ts";
import { checkedUrl } from "./oauth.ts";
import { slackObject, slackRequest, slackSubject } from "./slack-internal.ts";

export type SlackHistoryScope =
  | "channels:history"
  | "groups:history"
  | "im:history"
  | "mpim:history";

export function createSlackProvider(options: {
  clientId: string;
  appId: string;
  redirectUri: string;
  scopes: SlackHistoryScope[];
  fetch?: typeof fetch;
}): AccountProvider {
  const config = { ...options, scopes: [...options.scopes].sort() };
  if (
    !/^[0-9]+\.[0-9]+$/.test(config.clientId) ||
    config.clientId.length > 200 ||
    !/^A[A-Z0-9]{1,63}$/.test(config.appId) ||
    config.scopes.length < 1 ||
    config.scopes.length > 4 ||
    new Set(config.scopes).size !== config.scopes.length ||
    config.scopes.some(
      (scope) =>
        ![
          "channels:history",
          "groups:history",
          "im:history",
          "mpim:history",
        ].includes(scope),
    )
  )
    throw new Error("Invalid Slack provider");
  const redirect = checkedUrl(config.redirectUri, true);
  if (redirect.search) throw new Error("Callback URL must not contain a query");
  const as: oauth.AuthorizationServer = {
    issuer: "https://slack.com",
    authorization_endpoint: "https://slack.com/oauth/v2/authorize",
  };
  const client: oauth.Client = { client_id: config.clientId };
  function tokens(
    value: Record<string, unknown>,
    previous?: AccountTokens,
  ): AccountTokens {
    const team = slackObject(value.team);
    const source = previous ? value : slackObject(value.authed_user);
    const subject = slackSubject(
      team.id,
      previous ? previous.subject.split(":")[2] : source.id,
    );
    const scopes =
      typeof source.scope === "string" ? source.scope.split(",") : [];
    if (
      value.app_id !== config.appId ||
      value.is_enterprise_install !== false ||
      source.token_type !== "user" ||
      typeof source.access_token !== "string" ||
      typeof source.refresh_token !== "string" ||
      !/^[\x21-\x7e]{1,16384}$/.test(source.access_token) ||
      !/^[\x21-\x7e]{1,16384}$/.test(source.refresh_token) ||
      typeof source.expires_in !== "number" ||
      !Number.isSafeInteger(source.expires_in) ||
      source.expires_in <= 0 ||
      source.expires_in > 86_400 ||
      scopes.length !== config.scopes.length ||
      new Set(scopes).size !== scopes.length ||
      config.scopes.some((scope) => !scopes.includes(scope)) ||
      (previous && subject !== previous.subject)
    )
      throw new ReconnectionRequired(
        "Slack identity, scopes, or rotating credentials changed",
      );
    return {
      subject,
      scopes,
      accessToken: source.access_token,
      refreshToken: source.refresh_token,
      expiresAt: Date.now() + source.expires_in * 1000,
    };
  }
  return {
    id: "slack",
    binding: createHash("sha256")
      .update(
        JSON.stringify({
          clientId: config.clientId,
          appId: config.appId,
          redirect: redirect.href,
          scopes: config.scopes,
          flow: "slack-v2-pkce-user",
        }),
      )
      .digest("hex"),
    async authorizationUrl(input) {
      const url = new URL(as.authorization_endpoint!);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirect.href,
        scope: "",
        user_scope: config.scopes.join(","),
        state: input.state,
        code_challenge: await oauth.calculatePKCECodeChallenge(input.verifier),
        code_challenge_method: "S256",
      }).toString();
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
      const code = params.get("code");
      if (!code || code.length > 4096)
        throw new Error("Invalid Slack authorization code");
      return tokens(
        await slackRequest("oauth.v2.access", {
          fields: {
            client_id: config.clientId,
            code,
            redirect_uri: redirect.href,
            code_verifier: input.verifier,
          },
          ...(config.fetch ? { fetch: config.fetch } : {}),
        }),
      );
    },
    async refresh(previous) {
      return tokens(
        await slackRequest("oauth.v2.access", {
          fields: {
            client_id: config.clientId,
            grant_type: "refresh_token",
            refresh_token: previous.refreshToken,
          },
          ...(config.fetch ? { fetch: config.fetch } : {}),
        }),
        previous,
      );
    },
    async verify(accessToken, subject) {
      const value = await slackRequest("auth.test", {
        token: accessToken,
        ...(config.fetch ? { fetch: config.fetch } : {}),
      });
      if (
        value.bot_id !== undefined ||
        value.is_enterprise_install === true ||
        slackSubject(value.team_id, value.user_id) !== subject
      )
        throw new ReconnectionRequired("Slack account identity changed");
    },
  };
}
