import type { loadWorker } from "../../src/worker.ts";

export async function checkDeployment(options: {
  worker: Awaited<ReturnType<typeof loadWorker>>;
  allowLoopbackHttp?: boolean;
}) {
  const endpoint = new URL(options.worker.assignment.url);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["/invoke", "/api/capvine/invoke"].includes(endpoint.pathname) ||
    (endpoint.protocol !== "https:" &&
      !(
        options.allowLoopbackHttp &&
        endpoint.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
      ))
  )
    throw new Error("A fixed HTTPS invocation endpoint is required");
  async function status(path: string, init: RequestInit, expected: number[]) {
    const response = await fetch(new URL(path, endpoint.origin), {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    await response.body?.cancel();
    if (!expected.includes(response.status))
      throw new Error("Ingress boundary check failed");
  }
  await status("/__capvine_acceptance_not_found__", {}, [404]);
  await status(endpoint.pathname, {}, [404, 405]);
  await status(
    endpoint.pathname,
    {
      method: "POST",
      headers: { "content-type": "application/vnd.ipld.car" },
      body: new Uint8Array([0]),
    },
    [400, 403],
  );
  await status(
    endpoint.pathname,
    {
      method: "POST",
      headers: { "content-type": "application/vnd.ipld.car" },
      body: new Uint8Array(65537),
    },
    [413],
  );
  await status(
    endpoint.pathname,
    {
      method: "POST",
      headers: {
        "content-type": "application/vnd.ipld.car",
        origin: "https://untrusted.example",
      },
      body: new Uint8Array([0]),
    },
    [400, 403],
  );
  for (const path of [
    "/admin",
    "/api/capvine/connections/list",
    "/api/capvine/resources/discover",
    "/api/capvine/workflows/approve",
  ])
    await status(
      path,
      {
        method: "POST",
        headers: {
          origin: endpoint.origin,
          "content-type": "application/json",
          "x-capvine-request": "1",
        },
        body: "{}",
      },
      [401, 403, 404],
    );
  await status("/capvine", {}, [401, 403, 404]);
  await options.worker.invoke();
  return {
    transport: endpoint.protocol === "https:" ? "https" : "loopback-test-only",
    unknownRouteRejected: true,
    wrongMethodRejected: true,
    unsignedInvocationRejected: true,
    oversizedInvocationRejected: true,
    malformedBrowserRequestRejected: true,
    unauthenticatedAdministrationRejected: true,
    assignedReadSucceeded: true,
  };
}
