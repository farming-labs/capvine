import { createCapvineClient } from "@farming-labs/capvine/client";
import { createAuthClient } from "better-auth/client";

const client = createCapvineClient({ baseURL: location.origin });
const auth = createAuthClient({ baseURL: location.origin });
const $ = (id) => document.getElementById(id);
let choices = [];
let current = null;

async function command(name, body = {}) {
  const response = await fetch(`/api/starter/${name}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-starter-request": "1" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}

function renderJob() {
  const job = current?.job;
  const renewable =
    !!job?.workflowId &&
    !job.disabled &&
    job.workflowExpiresAt * 1000 > Date.now();
  $("read").disabled = !current?.worker;
  $("probe").disabled = !current?.worker;
  $("revoke").disabled = !job || job.revoked || job.disabled;
  $("renew").disabled = !renewable || !current?.worker;
  $("disable").disabled = !job || job.disabled;
  $("approve").disabled =
    renewable ||
    (!!job &&
      !job.workflowId &&
      !job.disabled &&
      !job.revoked &&
      job.expiresAt * 1000 > Date.now());
  const state = !job
    ? ""
    : job.disabled
      ? "Ended — approval disabled and worker stopped."
      : !current.worker
        ? "Worker unavailable — end this workflow before approving another."
        : job.revoked
          ? "Current grant revoked — read to test denial. A saved approval can still authorize renewal."
          : "Issued — the server checks validity on every read.";
  $("permission").textContent = job
    ? `Resource: ${job.resource}\nWorker: ${current.worker ?? "Not running"}\nWorker process: ${current.workerPid ?? "None"}\nGrant expires: ${new Date(job.expiresAt * 1000).toLocaleString()}\n${job.workflowId ? `Approval ends: ${new Date(job.workflowExpiresAt * 1000).toLocaleString()}` : "Legacy one-time grant — renewal requires a new explicit approval."}\n${state}`
    : "No worker has permission yet. Selecting a file does not grant access.";
}

async function refresh() {
  const session = await auth.getSession();
  if (session.error) throw new Error("Unable to check your session");
  const signedIn = !!session.data;
  $("login").hidden = signedIn;
  $("workspace").hidden = !signedIn;
  if (!signedIn) {
    current = null;
    $("result").textContent = "";
    return;
  }
  const discovered = await client.resources.discover({ plugin: "reports" });
  choices = discovered.items;
  $("file").replaceChildren(
    ...choices.map((choice, index) => new Option(choice.label, String(index))),
  );
  current = await command("status");
  renderJob();
}

async function run(action) {
  $("status").textContent = "Working…";
  for (const button of document.querySelectorAll("button"))
    button.disabled = true;
  try {
    await action();
    $("status").textContent = "Ready.";
  } catch (error) {
    $("status").textContent = error.message || "Request failed";
  } finally {
    for (const button of document.querySelectorAll("button"))
      button.disabled = false;
    renderJob();
  }
}

async function selectedResource() {
  const choice = choices[Number($("file").value)];
  if (!choice) throw new Error("Select a file first");
  return client.resources.register({
    type: "fs.file",
    plugin: "reports",
    target: choice.target,
  });
}

$("sign-in").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(async () => {
    const { error } = await auth.signIn.email({
      email: $("email").value,
      password: $("password").value,
    });
    $("password").value = "";
    if (error)
      throw new Error("Sign-in failed. Check your email and password.");
    await refresh();
  });
});
$("sign-out").addEventListener(
  "click",
  () =>
    void run(async () => {
      const { error } = await auth.signOut();
      if (error) throw new Error("Sign-out failed");
      await refresh();
    }),
);
$("approval").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(async () => {
    const resource = await selectedResource();
    current = await command("approve", { resource: resource.id });
    $("confirm").checked = false;
    $("result").textContent =
      "Permission issued to the coordinator and delegated to a separate worker. Click Read approved file.";
  });
});
$("read").addEventListener(
  "click",
  () =>
    void run(async () => {
      $("result").textContent = JSON.stringify(await command("read"), null, 2);
    }),
);
$("probe").addEventListener(
  "click",
  () =>
    void run(async () => {
      const resource = await selectedResource();
      $("result").textContent = JSON.stringify(
        await command("probe", { resource: resource.id }),
        null,
        2,
      );
    }),
);
$("revoke").addEventListener(
  "click",
  () =>
    void run(async () => {
      current = await command("revoke");
      $("result").textContent =
        "Current grant revoked. Read to confirm denial. The saved approval remains active, so Renew can issue a new grant. End workflow stops both.";
    }),
);
$("renew").addEventListener(
  "click",
  () =>
    void run(async () => {
      current = await command("renew");
      $("result").textContent =
        "Permission renewed under your saved approval. The worker keeps the same identity and process. The previous grant is revoked.";
    }),
);
$("disable").addEventListener(
  "click",
  () =>
    void run(async () => {
      current = await command("disable");
      $("result").textContent =
        "Workflow ended. Existing proofs and future renewal are denied by Capvine. The worker process has stopped.";
    }),
);
void run(refresh);
