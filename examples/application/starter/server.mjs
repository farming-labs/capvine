import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toNodeHandler } from "better-auth/node";
import { createCapvine } from "@farming-labs/capvine/setup";
import { filesystem } from "@farming-labs/capvine/plugins";
import { decodeGrant } from "@farming-labs/capvine";
import { CapvineAPIError } from "@farming-labs/capvine/client";
import {
  loadIdentity,
  readPrivateFile,
} from "@farming-labs/capvine/identity-file";
import { provisionWorker, renewWorker } from "@farming-labs/capvine/worker";
import { openAuth } from "./auth.mjs";
import {
  assignmentPath,
  dataDirectory,
  readJob,
  readSettings,
  saveJob,
} from "./state.mjs";
import { startWorker } from "./worker-process.mjs";

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function jsonBody(request) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new RequestError(415, "JSON required");
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, "Request body required");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 32_768) {
      reader.releaseLock();
      throw new RequestError(413, "Request too large");
    }
    chunks.push(value);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new RequestError(400, "Invalid JSON object");
  }
}

export async function startApplication(directory) {
  process.umask(0o077);
  const settings = await readSettings(directory);
  const { baseURL, ownerId } = settings;
  const login = openAuth({
    directory,
    baseURL,
    secret: await readPrivateFile(join(directory, "auth-secret")),
  });
  const authenticate = async (request) => {
    const session = await login.auth.api.getSession({
      headers: request.headers,
    });
    return session
      ? { ownerId: session.user.id, sessionId: session.session.id }
      : null;
  };
  const coordinator = await loadIdentity(join(directory, "coordinator.key"));
  let app;
  let worker;
  let job;
  let server;
  let busy = false;
  const close = async () => {
    if (server?.listening) {
      const closed = new Promise((resolve) => server.close(resolve));
      await closed;
    }
    await worker?.close();
    await app?.close();
    login.close();
  };
  try {
    app = await createCapvine({
      baseURL,
      ownerId,
      storage: { directory: join(directory, "capvine") },
      authenticate,
      providers: [],
      plugins: [
        filesystem({ id: "reports", root: join(directory, "reports") }),
      ],
    });
    job = await readJob(directory);
    if (job && !job.disabled) {
      try {
        worker = await startWorker(assignmentPath(directory, job));
      } catch {
        // Owner controls must remain available to disable a damaged assignment.
      }
    }

    const info = () => ({
      job,
      worker: worker?.info.worker ?? null,
      workerPid: worker?.info.pid ?? null,
    });
    async function jobRequest(request, route) {
      if (request.method !== "POST")
        throw new RequestError(405, "POST required");
      if (
        request.headers.get("origin") !== baseURL ||
        request.headers.get("x-starter-request") !== "1"
      )
        throw new RequestError(403, "Same-origin request required");
      const actor = await authenticate(request);
      if (!actor) throw new RequestError(401, "Sign in first");
      if (actor.ownerId !== ownerId)
        throw new RequestError(403, "Owner access required");
      if (busy)
        throw new RequestError(429, "Another worker request is in progress");
      busy = true;
      try {
        const body = await jsonBody(request);
        const headers = request.headers;
        if (route === "status") return info();
        if (route === "approve") {
          if (
            job &&
            !job.disabled &&
            (job.workflowId
              ? job.workflowExpiresAt > Date.now() / 1000
              : !job.revoked && job.expiresAt > Date.now() / 1000)
          )
            throw new RequestError(
              409,
              "End the current workflow before approving another",
            );
          const workflow = await app.api.workflows.approve({
            headers,
            body: {
              resource: body.resource,
              action: "fs/read",
              audience: coordinator.did(),
              expiresIn: 3600,
              maxGrantSeconds: 300,
            },
          });
          let nextWorker;
          try {
            const grant = await app.api.workflows.issue({
              headers,
              body: { id: workflow.id },
            });
            const next = {
              id: randomUUID(),
              workflowId: workflow.id,
              workflowExpiresAt: workflow.expiresAt,
              disabled: false,
              grantId: grant.id,
              resource: grant.resource,
              expiresAt: grant.expiresAt,
              revoked: false,
            };
            const path = assignmentPath(directory, next);
            await mkdir(dirname(path), { mode: 0o700 });
            await provisionWorker({
              path,
              coordinator,
              grant: await decodeGrant(Buffer.from(grant.grant, "base64")),
              url: grant.invocationURL,
              toolName: "read_report",
              expiresAt: new Date(grant.expiresAt * 1000),
            });
            nextWorker = await startWorker(path);
            await saveJob(directory, next);
            await worker?.close();
            worker = nextWorker;
            job = next;
          } catch (error) {
            try {
              await app.api.workflows.disable({
                headers,
                body: { id: workflow.id },
              });
            } finally {
              await nextWorker?.close();
            }
            throw error;
          }
          return info();
        }
        if (!job) throw new RequestError(409, "Approve a file first");
        if (route === "disable") {
          if (job.workflowId)
            await app.api.workflows.disable({
              headers,
              body: { id: job.workflowId },
            });
          else
            await app.api.grants.revoke({ headers, body: { id: job.grantId } });
          job = { ...job, disabled: true };
          await worker?.close();
          worker = undefined;
          await saveJob(directory, job);
          return info();
        }
        if (route === "renew") {
          if (Object.keys(body).length)
            throw new RequestError(
              400,
              "Renewal uses the saved workflow; no options are accepted",
            );
          if (!job.workflowId || job.disabled)
            throw new RequestError(
              409,
              "No renewable workflow; explicitly approve a new job",
            );
          if (!worker)
            throw new RequestError(
              409,
              "Worker unavailable; end the workflow before starting another",
            );
          const grant = await app.api.workflows.issue({
            headers,
            body: { id: job.workflowId },
          });
          try {
            await renewWorker({
              path: assignmentPath(directory, job),
              coordinator,
              grant: await decodeGrant(Buffer.from(grant.grant, "base64")),
              expiresAt: new Date(grant.expiresAt * 1000),
            });
            await app.api.grants.revoke({ headers, body: { id: job.grantId } });
            const next = {
              ...job,
              grantId: grant.id,
              expiresAt: grant.expiresAt,
              revoked: false,
            };
            await saveJob(directory, next);
            job = next;
          } catch (error) {
            await app.api.grants.revoke({ headers, body: { id: grant.id } });
            throw error;
          }
          return info();
        }
        if (route === "revoke") {
          await app.api.grants.revoke({ headers, body: { id: job.grantId } });
          job = { ...job, revoked: true };
          await saveJob(directory, job);
          return info();
        }
        if (!worker)
          throw new RequestError(409, "Worker stopped or unavailable");
        if (route === "read") return await worker.request("read");
        if (route === "probe") {
          if (
            typeof body.resource !== "string" ||
            !body.resource.startsWith("urn:capvine:resource:") ||
            body.resource.length > 256
          )
            throw new RequestError(400, "Choose a registered resource");
          return await worker.request("probe", body.resource);
        }
        throw new RequestError(404, "Unknown operation");
      } finally {
        busy = false;
      }
    }

    const assets = new Map([
      ["/", ["public/index.html", "text/html; charset=utf-8"]],
      ["/app.js", ["public/app.js", "text/javascript"]],
      ["/style.css", ["public/style.css", "text/css"]],
    ]);
    async function handle(request) {
      try {
        const url = new URL(request.url);
        if (
          url.origin !== baseURL ||
          request.headers.get("host") !== new URL(baseURL).host
        )
          throw new RequestError(400, "Invalid host");
        if (url.search) throw new RequestError(400, "Unexpected query");
        if (url.pathname.startsWith("/api/capvine/"))
          return app.handler(request);
        if (url.pathname.startsWith("/api/starter/"))
          return Response.json(
            await jobRequest(
              request,
              url.pathname.slice("/api/starter/".length),
            ),
          );
        if (
          ["/api/auth/sign-in/email", "/api/auth/sign-out"].includes(
            url.pathname,
          ) &&
          request.method === "POST"
        ) {
          if (request.headers.get("origin") !== baseURL)
            throw new RequestError(403, "Same-origin request required");
          const body = await jsonBody(request);
          return login.auth.handler(
            new Request(request, { body: JSON.stringify(body) }),
          );
        }
        if (
          url.pathname === "/api/auth/get-session" &&
          request.method === "GET"
        )
          return login.auth.handler(request);
        if (request.method === "GET" && assets.has(url.pathname)) {
          const [path, contentType] = assets.get(url.pathname);
          return new Response(await readFile(new URL(path, import.meta.url)), {
            headers: { "content-type": contentType },
          });
        }
        throw new RequestError(404, "Not found");
      } catch (error) {
        const status =
          error instanceof RequestError || error instanceof CapvineAPIError
            ? error.status
            : 503;
        return Response.json(
          {
            error:
              error instanceof RequestError
                ? error.message
                : error instanceof CapvineAPIError
                  ? error.code
                  : "Application unavailable; inspect local configuration",
          },
          {
            status,
            ...(status === 413 ? { headers: { connection: "close" } } : {}),
          },
        );
      }
    }
    const listener = toNodeHandler(async (request) => {
      const response = await handle(request);
      response.headers.set("cache-control", "no-store");
      response.headers.set("x-content-type-options", "nosniff");
      response.headers.set("referrer-policy", "no-referrer");
      response.headers.set(
        "content-security-policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      return response;
    });
    server = createServer(
      { headersTimeout: 5000, requestTimeout: 10000, maxHeaderSize: 8192 },
      (request, response) => {
        request.headers["x-starter-client-ip"] = request.socket.remoteAddress;
        void listener(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      },
    );
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(new URL(baseURL).port), "127.0.0.1", resolve);
    });
    return { baseURL, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await startApplication(dataDirectory());
  console.log(`Capvine application starter: ${app.baseURL}`);
  process.send?.({ ready: true, url: app.baseURL });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.disconnect?.();
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  process.on("disconnect", close);
}
