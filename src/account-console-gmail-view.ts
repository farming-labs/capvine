import { escapeHtml as e, form, page } from "./account-console-view.ts";
import type { GmailDemoView } from "./account-console-gmail.ts";

export function gmailPage(options: {
  csrf: string;
  state: GmailDemoView;
  connectionId: string;
  source: "google" | "fixture";
  error?: boolean;
}) {
  const { csrf, state, connectionId } = options;
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${e(value)}">`;
  const { run, selection } = state;
  const active =
    !!run &&
    run.active &&
    !run.revoked &&
    (!run.expiresAt || Date.parse(run.expiresAt) > Date.now());
  const action = (
    name: string,
    label: string,
    enabled: boolean,
    style = "secondary",
  ) =>
    form(
      "/gmail/action",
      csrf,
      `${hidden("run", run?.id ?? "")}${hidden("action", name)}<button class="${style}" ${enabled && (run?.events.length ?? 0) < 50 ? "" : "disabled"}>${label}</button>`,
    );
  const latest = options.error ? undefined : run?.events.at(-1);
  const status = !run
    ? "Select an email"
    : !run.active
      ? "Task ended"
      : run.revoked
        ? "Parent revoked"
        : run.child
          ? "Delegated to worker"
          : run.root
            ? "Approved for coordinator"
            : "Awaiting your approval";
  return page(
    "Gmail delegation",
    `<a href="/">← Connections</a><div class="eyebrow">${options.source === "google" ? "Live Google / Gmail" : "Local provider fixture"}</div><h1>Delegate access to one email.</h1><p class="intro">${options.source === "google" ? "This screen uses your saved Google connection and calls the Gmail API." : "This screen uses the local OAuth fixture, not a real account."} Select an email, approve a read, and test exactly where that permission stops.</p>
${options.error ? '<p class="notice error" role="alert">The action could not complete. Check your connection, refresh the email list, or start a new selection. No success has been recorded for this attempt.</p>' : ""}
${latest ? `<p class="notice ${latest.expected ? "" : "error"}" role="status"><strong>${e(latest.action)}: ${e(latest.outcome.toUpperCase())}</strong> · Gmail message requests: +${latest.providerCalls}. ${latest.expected ? "Matches the expected permission boundary." : "Unexpected result: the boundary check failed."}</p>` : ""}
<section class="panel"><h2>1. Choose one email</h2><p>Loading the list fetches up to five inbox message IDs. Email contents are fetched only when you run an authorized read below.</p>${connectionId ? form("/gmail/load", csrf, `${hidden("connection", connectionId)}<button class="secondary">${selection ? "Refresh email list" : "Load recent email IDs"}</button>`) : '<p><a href="/">Choose a connected Google account first.</a></p>'}
${selection && !run ? (selection.messages.length ? form("/gmail/select", csrf, `${hidden("selection", selection.id)}<label for="message">Inbox email</label><select id="message" name="message">${selection.messages.map((id, index) => `<option value="${e(id)}">Inbox result ${index + 1} · ${e(id)}</option>`).join("")}</select><p><small>The IDs identify exact messages. Selecting one does not grant a worker access.</small></p><button>Select this email</button>`) : '<p class="notice">No inbox messages were returned. Try refreshing after an email arrives.</p>') : ""}
${run ? `<dl><dt>Selected message</dt><dd><code>${e(run.messageId)}</code></dd><dt>Permission</dt><dd>Read subject and snippet · <code>gmail/message.read</code></dd><dt>Status</dt><dd>${status}</dd>${run.expiresAt ? `<dt>Grant expiry</dt><dd>${e(run.expiresAt)}</dd>` : ""}</dl>${form("/gmail/reset", csrf, '<button class="secondary">Choose another email</button>')}` : ""}</section>
${
  run
    ? `<section class="panel"><h2>2. Approve, delegate, and read</h2><p>Approve the coordinator for at most ten minutes. It can give the worker the same read permission for at most five minutes. Subsequent permitted reads need no new approval.</p><div class="actions">${action("approve", "Approve this email", !run.root && active, "")}${action("delegate", "Delegate to worker", !!run.root && !run.child && active)}${action("read", "Read selected email", !!run.child)}</div></section>
<section class="panel"><h2>Last successful Gmail read</h2><p><strong>${run.providerCalls}</strong> message request${run.providerCalls === 1 ? "" : "s"} reached Gmail through this run. Owner message-list requests are counted separately from this figure.</p>${run.result !== null ? `<p>This is the selected email’s subject and preview text returned by Gmail. Forbidden-request tests keep this successful read visible without fetching the email again.</p><pre class="message-preview">${e(JSON.stringify(run.result, null, 2))}</pre>` : '<p class="muted">No email preview is stored. Approve, delegate, then press Read selected email. Revoking access or ending the task clears this preview.</p>'}
</section>
<section class="panel"><h2>3. Test forbidden requests</h2><p>These requests are signed and verified by the server. They try a different resource, a delete action, another worker identity, or an expired request. No delete operation is implemented.</p><div class="actions">${action("other-resource", "Change resource", !!run.child)}${action("write", "Try delete action", !!run.child)}${action("other-worker", "Try another worker", !!run.child)}${action("expired", "Try expired request", !!run.child)}</div><h2 class="spaced">4. Stop access</h2><p>Revoke the parent, then press Read selected email again. The child must be denied before another Gmail request.</p><div class="actions">${action("revoke", "Revoke parent", !!run.root && !run.revoked, "danger")}${action("end-task", "End task", run.active)}</div></section>
<section class="panel"><h2>Request history</h2>
${
  run.events.length
    ? `<ul class="list">${run.events
        .slice()
        .reverse()
        .map(
          (event) =>
            `<li class="row"><span>${e(event.action)} · <strong>${e(event.outcome.toUpperCase())}</strong></span><span>Gmail requests +${event.providerCalls}${event.expected ? "" : " · CHECK FAILED"}</span></li>`,
        )
        .join("")}</ul>`
    : ""
}</section>
<details class="panel"><summary>Inspect public grant and identity details</summary><dl><dt>Coordinator</dt><dd><code>${e(run.coordinator)}</code></dd><dt>Worker</dt><dd><code>${e(run.worker)}</code></dd><dt>Parent grant</dt><dd><code>${e(run.root ?? "Not issued")}</code></dd><dt>Child grant</dt><dd><code>${e(run.child ?? "Not issued")}</code></dd></dl></details>`
    : ""
}
<p class="notice">This console drives separate signing identities inside the trusted backend process. It tests capability enforcement; it does not isolate an untrusted agent or its operating system. Email content is kept in this browser session's backend state until the next read attempt, revocation, task end, selection change, sign-out, session expiry, or shutdown. Returned data cannot be taken back by revocation.</p>`,
    csrf,
  );
}
