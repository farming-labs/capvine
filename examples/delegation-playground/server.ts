import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { readRequest, RequestError, respond } from "../../src/http-internal.ts";
import {
  actions,
  ScenarioError,
  startScenario,
  type Action,
} from "./scenario.ts";
import { page, styles } from "./view.ts";

export async function startPlayground({ port = 8788 }: { port?: number } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid port");
  const script = await readFile(new URL("./app.js", import.meta.url), "utf8");
  let scenario = await startScenario();
  let state = scenario.state();
  const csrf = randomBytes(32).toString("base64url");
  let origin = "";
  let host = "";
  let pending: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  function asset(response: ServerResponse, content: string, type: string) {
    response.writeHead(200, {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": "no-store",
    });
    response.end(content);
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    if (closing) throw new RequestError(503, "The playground is closing");
    if (
      request.headers.host !== host ||
      request.headers["sec-fetch-site"] === "cross-site" ||
      (request.headers.origin && request.headers.origin !== origin)
    )
      throw new RequestError(403, "Use the local playground address");
    if (request.method === "GET") {
      switch (request.url) {
        case "/":
          return asset(response, page(csrf), "text/html");
        case "/style.css":
          return asset(response, styles, "text/css");
        case "/app.js":
          return asset(response, script, "text/javascript");
        case "/api/state":
          return respond(response, 200, state);
      }
    }
    if (request.method !== "POST" || request.url !== "/api/action")
      throw new RequestError(404, "Not found");
    if (
      request.headers.origin !== origin ||
      request.headers["x-playground-csrf"] !== csrf
    )
      throw new RequestError(403, "Reload the local page before trying again");
    if (request.headers["content-type"] !== "application/json")
      throw new RequestError(415, "Expected JSON");
    let body: unknown;
    try {
      body = JSON.parse(
        Buffer.from(await readRequest(request)).toString("utf8"),
      );
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(400, "Invalid JSON");
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("action" in body) ||
      typeof body.action !== "string" ||
      (body.action !== "reset" && !actions.includes(body.action as Action))
    )
      throw new RequestError(400, "Choose a supported playground action");
    if (pending || closing)
      throw new RequestError(409, "An action is already running");
    const action = body.action;
    pending = (async () => {
      if (action === "reset") {
        await scenario.close();
        scenario = await startScenario();
        state = scenario.state();
      } else state = await scenario.run(action as Action);
    })();
    try {
      await pending;
      respond(response, 200, state);
    } finally {
      pending = undefined;
    }
  }
  const server = createServer(
    { headersTimeout: 5_000, requestTimeout: 10_000 },
    (request, response) => {
      void handle(request, response).catch((error: unknown) => {
        const known =
          error instanceof RequestError || error instanceof ScenarioError;
        respond(
          response,
          error instanceof RequestError
            ? error.status
            : error instanceof ScenarioError
              ? 409
              : 500,
          {
            error: known
              ? error.message
              : "The action could not complete. Reset the playground and try again.",
          },
        );
      });
    },
  );
  server.maxConnections = 32;
  const close = () =>
    (closing ??= (async () => {
      await pending?.catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await scenario.close();
    })());
  try {
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing address");
    host = `127.0.0.1:${address.port}`;
    origin = `http://${host}`;
    return { url: origin, close };
  } catch (error) {
    await close();
    throw error;
  }
}
