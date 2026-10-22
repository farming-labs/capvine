const $ = (id) => document.getElementById(id);
const buttons = [...document.querySelectorAll("button[data-action]")];
const csrf = document.querySelector('meta[name="csrf"]').content;
let state;
let busy = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function availability() {
  for (const button of buttons) {
    const action = button.dataset.action;
    let enabled = action === "reset";
    if (state && state.events.length < 100) {
      if (action === "approve") enabled = !state.root && state.taskActive;
      else if (action === "delegate")
        enabled =
          !!state.root &&
          !state.child &&
          !state.revoked &&
          state.taskActive &&
          Date.parse(state.root.expiresAt) > Date.now();
      else if (action === "revoke") enabled = !!state.root && !state.revoked;
      else if (action === "end-task") enabled = state.taskActive;
      else if (action === "direct-provider") enabled = true;
      else if (action !== "reset") enabled = !!state.child;
    }
    button.disabled = busy || !enabled;
  }
}
function timing(grant) {
  const seconds = Math.ceil((Date.parse(grant.expiresAt) - Date.now()) / 1000);
  return seconds > 0
    ? `Expires in ${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : "Expired — reset to start again";
}
function clocks() {
  if (!state) return;
  $("root-status").textContent = !state.root
    ? "No key issued"
    : state.revoked
      ? "Revoked"
      : !state.taskActive
        ? "Task ended"
        : timing(state.root);
  $("child-status").textContent = !state.child
    ? state.root
      ? "Ready to delegate"
      : "Waiting for approval"
    : state.revoked
      ? "Blocked by parent revocation"
      : !state.taskActive
        ? "Task ended"
        : timing(state.child);
  $("read-status").textContent = !state.child
    ? "Waiting for delegation"
    : state.revoked ||
        !state.taskActive ||
        Date.parse(state.child.expiresAt) <= Date.now()
      ? "Try again — it should be denied"
      : "Ready — repeated reads are allowed";
  availability();
}
function render() {
  $("provider-count").textContent = state.providerReads;
  $("denied-count").textContent = state.events.filter(
    (event) => event.outcome === "denied",
  ).length;
  $("task-status").textContent = state.taskActive ? "Active" : "Ended";
  $("empty").hidden = state.events.length > 0;
  $("history").replaceChildren(
    ...state.events.toReversed().map((event) => {
      const item = element("li", "", "event");
      const heading = element("div", "", "event-head");
      heading.append(
        element(
          "span",
          `${event.sequence.toString().padStart(2, "0")} / ${event.action.replaceAll("-", " ")}`,
        ),
        element(
          "span",
          event.expected ? event.outcome.toUpperCase() : "UNEXPECTED RESULT",
          `badge ${event.expected ? event.outcome : "unexpected"}`,
        ),
      );
      item.append(
        heading,
        element("p", event.detail),
        element(
          "div",
          `Provider reads: +${event.providerDelta} · ${event.expected ? "Matches expected boundary" : "Boundary check FAILED"}`,
          "evidence",
        ),
      );
      if (event.authorization.length)
        item.append(
          element(
            "div",
            `Server decision: ${event.authorization.join(", ")}`,
            "evidence",
          ),
        );
      if (event.result !== null)
        item.append(element("pre", JSON.stringify(event.result, null, 2)));
      return item;
    }),
  );
  const identities = $("identities");
  identities.replaceChildren();
  const rows = [
    ["Authority process", `PID ${state.authorityPid}`],
    ...[
      ["Coordinator", state.coordinator],
      ["Worker A", state.worker],
      ["Worker B", state.otherWorker],
    ].map(([label, identity]) => [
      label,
      `PID ${identity.pid} · ${identity.did}`,
    ]),
    [
      "Parent grant",
      state.root ? `${state.root.id} · ${state.root.expiresAt}` : "Not issued",
    ],
    [
      "Child grant",
      state.child
        ? `${state.child.id} · ${state.child.expiresAt}`
        : "Not issued",
    ],
  ];
  for (const [label, value] of rows) {
    const detail = element("dd", "");
    detail.append(element("code", value));
    identities.append(element("dt", label), detail);
  }
  clocks();
}
async function request(action) {
  busy = true;
  availability();
  $("feedback").classList.remove("error");
  $("feedback").textContent =
    action === "reset"
      ? "Starting fresh processes and keys…"
      : action
        ? "Waiting for the server…"
        : "Connecting to the local demo…";
  try {
    const response = await fetch(
      action ? "/api/action" : "/api/state",
      action
        ? {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-playground-csrf": csrf,
            },
            body: JSON.stringify({ action }),
          }
        : {},
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The request failed");
    state = data;
    render();
    const latest = state.events.at(-1);
    $("feedback").textContent =
      action === "reset"
        ? "Reset complete. Approve a new key to begin."
        : latest
          ? `${latest.expected ? "Expected result" : "Boundary check FAILED"}: ${latest.outcome}. Provider reads +${latest.providerDelta}.`
          : "Ready. Start with Approve issue 42.";
    if (latest && !latest.expected) $("feedback").classList.add("error");
  } catch (error) {
    $("feedback").classList.add("error");
    $("feedback").textContent =
      error.message ||
      "The server is unavailable. Restart the playground and reload.";
  } finally {
    busy = false;
    availability();
  }
}
for (const button of buttons)
  button.addEventListener("click", () => request(button.dataset.action));
setInterval(clocks, 1000);
request();
