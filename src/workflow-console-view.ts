import { escapeHtml as e, form, page } from "./account-console-view.ts";
import type { WorkflowManager } from "./workflows.ts";

type Listing = Awaited<ReturnType<WorkflowManager["list"]>>;
const notices: Record<string, string> = {
  approve: "Workflow approved. You can now provision its workers.",
  provision:
    "Worker provisioned. Use its MCP configuration below to connect your runtime.",
  renew: "Worker grant renewed within the saved approval.",
  disable:
    "Workflow disabled. Later reads and new grants through this approval are blocked.",
  failed:
    "The action could not be completed. Check the current workflow state before trying again.",
};
const hidden = (id: string) =>
  `<input type="hidden" name="id" value="${e(id)}">`;
const date = (seconds: number) => new Date(seconds * 1000).toISOString();
export function workflowsPage(
  input: Listing & {
    csrf: string;
    accounts: boolean;
    after: boolean;
    notice: string;
  },
) {
  const notice = Object.hasOwn(notices, input.notice)
    ? notices[input.notice]!
    : "";
  return page(
    "Workflows",
    `
    ${input.accounts ? '<a href="/">← Connections</a>' : ""}
    <div class="eyebrow">Delegated access</div><h1>Workflows</h1>
    <p class="intro">Approve a specific permission once. Give each worker its own key, renew within your approval, and disable the workflow when it is finished.</p>
    ${notice ? `<p role="${input.notice === "failed" ? "alert" : "status"}" class="notice ${input.notice === "failed" ? "error" : ""}">${e(notice)}</p>` : ""}
    ${input.renewalFailed ? '<p class="notice error" role="alert">Automatic renewal could not complete. Workers keep their current expiry; check the authority connection and assignment storage.</p>' : ""}
    ${input.unavailableWorkers.length ? '<p class="notice error" role="alert">A worker assignment could not be read. Its renewal is unavailable. Inspect protected storage or disable its saved approval below.</p>' : ""}
    <section class="panel"><h2>Available permissions</h2><p class="muted">These choices come from protected server configuration.</p><ul class="list">
    ${input.definitions.map((item) => `<li class="row"><div><h2>${e(item.label)}</h2><p><code>${e(item.action)}</code> on <code>${e(item.resource)}</code></p><p class="muted">Approve for ${item.approvalSeconds / 60} minutes. Worker grants last up to ${item.workerSeconds} seconds and can be renewed while approval is active.</p></div>${form("/workflows/approve", input.csrf, `${hidden(item.id)}<button>Approve ${e(item.label)}</button>`)}</li>`).join("")}
    </ul></section>
    <section class="panel"><h2>Saved approvals</h2>
    ${
      input.approvals.length
        ? input.approvals
            .map((approval) => {
              const rows = input.workers.filter(
                (worker) => worker.assignment.task === approval.taskId,
              );
              const active = approval.active && approval.configured;
              const status = !approval.active
                ? "Inactive"
                : approval.configured
                  ? "Active"
                  : "Configuration changed";
              return `<article class="approval"><h3>${e(input.definitions.find((item) => approval.id.startsWith("wf." + item.id + "."))?.label ?? "Saved workflow")} <span class="status ${active ? "connected" : ""}">${status}</span></h3><p><code>${e(approval.id)}</code></p><p><code>${e(approval.action)}</code> on <code>${e(approval.resource)}</code><br><small>Approval expires ${date(approval.expiresAt)}</small></p>
      <div class="actions">${active ? form("/workflows/provision", input.csrf, `${hidden(approval.id)}<button>Provision worker</button>`) : ""}${approval.active ? form("/workflows/disable", input.csrf, `${hidden(approval.id)}<label class="confirm"><input type="checkbox" required> Stop reads and renewal for every worker in this approval</label><button class="danger">Disable workflow</button>`) : ""}</div>
      ${rows.length ? `<ul class="list">${rows.map((worker) => `<li class="worker-row"><h4>Worker <code>${e(worker.id)}</code></h4><p><span class="status">${!active ? "Blocked by workflow" : new Date(worker.assignment.expiresAt).getTime() <= Date.now() ? "Grant expired" : "Grant unexpired"}</span> <small>Grant expires ${e(worker.assignment.expiresAt)}</small></p><details><summary>Connect this worker to your runtime</summary><p>Use this configuration on the machine that can read the worker assignment. Keep the assignment private.</p><pre class="message-preview">${e(JSON.stringify({ mcpServers: { [worker.assignment.toolName]: { command: input.workerCommand.command, args: [...input.workerCommand.args, "worker", worker.path] } } }, null, 2))}</pre><p><small>Worker identity</small><br><code>${e(worker.assignment.worker)}</code></p></details>${active ? form("/workflows/renew", input.csrf, `${hidden(worker.id)}<button class="secondary">Renew worker grant</button>`) : ""}</li>`).join("")}</ul>` : '<p class="muted spaced">No workers yet. Provision one to create a separate signing identity and scoped assignment.</p>'}</article>`;
            })
            .join("")
        : '<p class="muted">No approvals on this page. Choose an available permission above.</p>'
    }
    <nav aria-label="Approval pages">${input.after ? '<a href="/workflows">First page</a> ' : ""}${input.nextCursor ? `<a href="/workflows?after=${encodeURIComponent(input.nextCursor)}">Next page</a>` : ""}</nav></section>
    <p class="muted spaced">Disabling stops later authorization decisions. It cannot erase data a worker has already read.</p>`,
    input.csrf,
  );
}
