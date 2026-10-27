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
  $("read").disabled = !job;
  $("probe").disabled = !job;
  $("revoke").disabled = !job || job.revoked;
  $("approve").disabled =
    !!job && !job.revoked && job.expiresAt * 1000 > Date.now();
  $("permission").textContent = job
    ? `Resource: ${job.resource}\nWorker: ${current.worker}\nWorker process: ${current.workerPid}\nExpires: ${new Date(job.expiresAt * 1000).toLocaleString()}\n${job.revoked ? "Revoked — the worker still holds its old proof, so you can test denial." : "Issued — the server checks validity on every read."}`
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
        "Permission revoked. Click Read approved file to confirm the worker is denied.";
    }),
);
void run(refresh);
