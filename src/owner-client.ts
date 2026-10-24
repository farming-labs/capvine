import {
  applicationURL,
  basePath,
  CapvineAPIError,
  readBody,
  type Command,
  type CommandInput,
  type CommandOutput,
} from "./application-contract.ts";

export { CapvineAPIError } from "./application-contract.ts";
export type {
  ConnectedAccount,
  RegisteredResource,
  RegisterResourceInput,
  IssuedGrant,
} from "./application-contract.ts";

export function createCapvineClient(options: {
  baseURL: string;
  fetch?: typeof fetch;
  navigate?: (url: string) => void;
}) {
  const origin = applicationURL(options.baseURL).origin;
  if (typeof window !== "undefined" && window.location.origin !== origin)
    throw new Error("The owner client must use the application's origin");
  const request = options.fetch ?? fetch;
  const navigate =
    options.navigate ??
    (typeof window === "undefined"
      ? undefined
      : (url: string) => window.location.assign(url));
  async function call<K extends Command>(
    name: K,
    input: CommandInput<K>,
  ): Promise<CommandOutput<K>> {
    const result = await request(`${origin}${basePath}/${name}`, {
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        "content-type": "application/json",
        "x-capvine-request": "1",
        origin,
      },
      body: JSON.stringify(input),
    });
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readBody(result.body, 1048576),
      ),
    );
    if (!result.ok)
      throw new CapvineAPIError(
        result.status,
        typeof value?.error?.code === "string"
          ? value.error.code
          : "request_failed",
      );
    if (!value || typeof value !== "object" || !("data" in value))
      throw new Error("Invalid Capvine response");
    return value.data as CommandOutput<K>;
  }
  return {
    connections: {
      async connect(input: CommandInput<"connections/connect">) {
        const result = await call("connections/connect", input);
        navigate?.(result.url);
        return result;
      },
      list: (input: CommandInput<"connections/list"> = {}) =>
        call("connections/list", input),
      disconnect: (input: CommandInput<"connections/disconnect">) =>
        call("connections/disconnect", input),
    },
    resources: {
      register: (input: CommandInput<"resources/register">) =>
        call("resources/register", input),
      list: (input: CommandInput<"resources/list"> = {}) =>
        call("resources/list", input),
    },
    grants: {
      issue: (input: CommandInput<"grants/issue">) =>
        call("grants/issue", input),
      revoke: (input: CommandInput<"grants/revoke">) =>
        call("grants/revoke", input),
    },
  };
}
