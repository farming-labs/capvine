import { ReconnectionRequired } from "./accounts.ts";
import { boundedFetch } from "./oauth.ts";

export function slackObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Slack response");
  return value as Record<string, unknown>;
}

export function slackSubject(team: unknown, user: unknown) {
  if (
    typeof team !== "string" ||
    !/^T[A-Z0-9]{1,63}$/.test(team) ||
    typeof user !== "string" ||
    !/^[UW][A-Z0-9]{1,63}$/.test(user)
  )
    throw new Error("Invalid Slack identity");
  return `slack:${team}:${user}`;
}

export async function slackRequest(
  method: "oauth.v2.access" | "auth.test" | "conversations.history",
  options: {
    fields?: Record<string, string>;
    token?: string;
    fetch?: typeof fetch;
  },
) {
  const history = method === "conversations.history";
  const url = new URL(`https://slack.com/api/${method}`);
  const fields = new URLSearchParams(options.fields);
  if (history) url.search = fields.toString();
  const response = await boundedFetch(
    url.href,
    {
      method: history ? "GET" : "POST",
      headers: {
        ...(!history
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      ...(!history ? { body: fields } : {}),
    },
    options.fetch,
  );
  if (response.status === 401) {
    await response.body?.cancel();
    throw new ReconnectionRequired("Slack rejected account access");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Slack request failed");
  }
  const value = slackObject(await response.json());
  if (value.ok !== true) {
    if (
      typeof value.error === "string" &&
      [
        "invalid_auth",
        "token_revoked",
        "token_expired",
        "account_inactive",
        "invalid_refresh_token",
        "invalid_grant",
      ].includes(value.error)
    )
      throw new ReconnectionRequired("Slack rejected account access");
    throw new Error("Slack request failed");
  }
  return value;
}
