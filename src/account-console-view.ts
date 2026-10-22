import type { AccountManager } from "./accounts.ts";

type Connection = ReturnType<AccountManager["inspect"]>;
export type ConsoleProvider = {
  id: string;
  label: string;
  authorizationOrigin: string;
};
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
export const form = (action: string, csrf: string, content: string) =>
  `<form method="post" action="${action}">${hidden("csrf", csrf)}${content}</form>`;
const statuses = {
  connecting: "Awaiting connection",
  connected: "Connected",
  disconnected: "Disconnected",
  reconnect_required: "Reconnect required",
};
export const styles = `
:root { color-scheme: light; --bg: #f6f7f4; --ink: #17231e; --muted: #59665e; --line: #d3dbd4; --accent: #245b40; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.6 system-ui, sans-serif; }
a { color: var(--accent); text-underline-offset: 4px; }
header, main, footer { width: min(960px, calc(100% - 40px)); margin-inline: auto; }
header { padding: 24px 0; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.brand { text-decoration: none; color: var(--ink); font-weight: 750; letter-spacing: -.04em; font-size: 24px; }
header span, .eyebrow { font: 12px/1.5 ui-monospace, monospace; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
main { padding-block: 40px; min-height: 65vh; }
h1 { margin: 8px 0 12px; font-size: clamp(28px, 4vw, 40px); line-height: 1.2; letter-spacing: -.04em; }
h2 { font-size: 20px; margin: 0 0 12px; line-height: 1.3; }
p { margin: 0 0 20px; }
.intro { max-width: 640px; color: var(--muted); }
.panel { padding: 24px; border: 1px solid var(--line); background: #fff; margin-top: 24px; }
.login { max-width: 480px; }
label { display: block; margin: 12px 0 6px; font-weight: 600; }
input, select, button { font: inherit; min-height: 44px; border-radius: 4px; }
input, select { border: 1px solid #859589; background: #fff; color: var(--ink); padding: 9px 12px; width: 100%; }
button { cursor: pointer; background: var(--accent); color: white; border: 1px solid var(--accent); padding: 9px 16px; font-weight: 600; }
button:hover { background: #18412c; }
button:active { transform: translateY(1px); }
.secondary { background: #fff; color: var(--ink); border-color: var(--line); }
.secondary:hover { background: #edf1ec; }
.danger { background: #fff; color: #9b2929; border-color: #d7b0b0; }
.danger:hover { background: #fff0f0; }
:focus-visible { outline: 3px solid #3976bc; outline-offset: 3px; }
form p, .muted, small { color: var(--muted); }
.login button { margin-top: 20px; width: 100%; }
.connect form { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; }
.connect label { margin: 0; min-width: 180px; flex: 1; }
.connect select { margin-top: 6px; }
.notice { padding: 16px 20px; border-left: 3px solid var(--accent); background: #e8f0e9; margin: 24px 0; }
.error { border-color: #9b2929; background: #fff0f0; }
.list { list-style: none; padding: 0; margin: 0; }
.row { padding: 20px 0; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; gap: 20px; }
.row:last-child { border-bottom: 0; }
.row h2 { font-size: 17px; margin-bottom: 4px; }
.row p { margin: 6px 0 0; }
code { font: 13px/1.6 ui-monospace, monospace; overflow-wrap: anywhere; }
.status { display: inline-block; border: 1px solid var(--line); padding: 2px 8px; font-size: 12px; color: var(--muted); }
.status.connected { color: #1e5135; background: #e8f0e9; }
dt { color: var(--muted); font-size: 13px; margin-top: 16px; }
dd { margin: 4px 0 0; overflow-wrap: anywhere; }
.actions { display: flex; gap: 12px; flex-wrap: wrap; }
.spaced { margin-top: 24px; }
.message-preview { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.7 ui-monospace, monospace; background: var(--bg); padding: 16px; }
button:disabled { opacity: .5; cursor: not-allowed; }
footer { padding: 20px 0 32px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
@media(max-width: 540px) { header, main, footer { width: calc(100% - 32px); } main { padding-block: 28px; } .panel { padding: 18px; } header span { display: none; } .row { align-items: start; flex-direction: column; gap: 10px; } .connect form, .connect button, .actions form, .actions button { width: 100%; } }
`;
export function page(title: string, content: string, csrf?: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Capvine</title><link rel="stylesheet" href="/style.css"></head><body><header><a class="brand" href="/">capvine</a>${csrf ? form("/logout", csrf, '<button class="secondary">Sign out</button>') : "<span>Owner console</span>"}</header><main>${content}</main><footer>Capvine · Local account connections</footer></body></html>`;
}
export function login(csrf: string, error = "") {
  return page(
    "Sign in",
    `<div class="login"><div class="eyebrow">Owner access</div><h1>Your connections,<br>under your control.</h1><p class="intro">Sign in to connect and manage the accounts available to your Capvine backend.</p>${error ? `<p class="notice error" role="alert">${escapeHtml(error)}</p>` : ""}<section class="panel">${form("/login", csrf, '<label for="key">Console access key</label><input id="key" name="key" type="password" autocomplete="current-password" required maxlength="43" minlength="43" aria-describedby="key-help"><small id="key-help">Use the key from your local console configuration.</small><button>Sign in</button>')}</section></div>`,
  );
}
const status = (c: Connection) =>
  `<span class="status ${c.status}">${statuses[c.status]}</span>`;
export function dashboard(input: {
  csrf: string;
  providers: ConsoleProvider[];
  connections: Connection[];
  nextCursor: string | null;
  notice: string;
  after: boolean;
  gmail?: boolean;
}) {
  const { csrf, providers, connections, nextCursor, notice } = input;
  return page(
    "Connections",
    `<div class="eyebrow">Account management</div><h1>Connections</h1><p class="intro">Connect an account here. ${input.gmail ? "Use Test Gmail delegation to select an email and grant a worker read access." : "Choose which resources a client may use separately through Capvine’s grant API."}</p>${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ""}<section class="panel connect"><h2>Connect an account</h2>${form("/connections/connect", csrf, `<label for="provider">Service<select id="provider" name="provider">${providers.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`).join("")}</select></label><button>Continue to provider</button>`)}</section><section class="panel"><h2>Saved connections</h2>${connections.length ? `<ul class="list">${connections.map((c) => `<li class="row"><div><h2>${escapeHtml(providers.find((p) => p.id === c.provider)?.label ?? c.provider)} ${status(c)}</h2><code>${escapeHtml(c.id)}</code><p class="muted">${c.subject ? `Account: ${escapeHtml(c.subject)}` : "No account linked yet"}</p></div><div class="actions"><a href="/connection?id=${encodeURIComponent(c.id)}">Manage connection</a>${input.gmail && c.provider === "google" && c.status === "connected" ? `<a href="/gmail?connection=${encodeURIComponent(c.id)}">Test Gmail delegation</a>` : ""}</div></li>`).join("")}</ul>` : `<p class="muted">${input.after ? "No connections on this page." : "No connections yet. Choose a service above to get started."}</p>`}<nav aria-label="Connection pages">${input.after ? '<a href="/">First page</a> ' : ""}${nextCursor ? `<a href="/?after=${encodeURIComponent(nextCursor)}">Next page</a>` : ""}</nav></section>`,
    csrf,
  );
}
export function detail(c: Connection, csrf: string, gmail = false) {
  const id = hidden("id", c.id);
  return page(
    "Manage connection",
    `<a href="/">← All connections</a><h1>Manage connection</h1>${status(c)}${gmail && c.provider === "google" && c.status === "connected" ? `<p><a href="/gmail?connection=${encodeURIComponent(c.id)}">Test Gmail delegation →</a></p>` : ""}<section class="panel"><h2>Account details</h2><dl><dt>Connection ID</dt><dd><code>${escapeHtml(c.id)}</code></dd><dt>Provider</dt><dd>${escapeHtml(c.provider)}</dd><dt>Account identity</dt><dd>${escapeHtml(c.subject ?? "Not connected")}</dd><dt>Provider permissions</dt><dd>${c.scopes.map((s) => `<code>${escapeHtml(s)}</code>`).join("<br>") || "Not available"}</dd></dl></section><section class="panel"><h2>Disconnect or reconnect</h2><p>Disconnecting stops future use through this connection. To remove the provider’s consent too, use its account settings.</p><p>Reconnecting disconnects this entry and creates a new connection ID. Existing resource bindings keep the old ID and will stop working. Register the new connection before granting access again.</p><div class="actions">${c.status !== "disconnected" ? form("/connections/disconnect", csrf, `${id}<button class="danger">Disconnect this connection</button>`) : ""}${form("/connections/reconnect", csrf, `${id}<button>Reconnect as a new connection</button>`)}</div></section>`,
    csrf,
  );
}
