import {
  escapeHtml,
  styles as consoleStyles,
} from "../../src/account-console-view.ts";

export const styles = `${consoleStyles}
header, main, footer { width: min(1120px, calc(100% - 48px)); }
header .brand { font-size: 23px; }
main { padding-block: 36px 48px; }
.hero { display: flex; gap: 24px; justify-content: space-between; align-items: start; }
.hero h1 { font-size: clamp(32px, 4vw, 44px); }
.hero .intro { max-width: 680px; margin-bottom: 0; }
.pill { border: 1px solid var(--line); border-radius: 20px; padding: 5px 12px; font: 12px/1.5 ui-monospace, monospace; white-space: nowrap; }
.limits { margin-block: 20px 24px; font-size: 13px; color: var(--muted); }
.scope { display: flex; gap: 12px 32px; flex-wrap: wrap; padding: 18px 0; border-block: 1px solid var(--line); }
.scope div { display: grid; gap: 2px; }
.scope span, .small-label { font: 11px/1.5 ui-monospace, monospace; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.scope strong { font-size: 14px; }
.layout { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 28px; margin-top: 28px; }
.section-title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.section-title h2 { font-size: 18px; }
.steps { list-style: none; padding: 0; margin: 0; }
.step { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 12px; padding: 18px 0; border-top: 1px solid var(--line); }
.number { width: 28px; height: 28px; border: 1px solid var(--line); border-radius: 50%; display: grid; place-items: center; font: 12px ui-monospace, monospace; }
.step h3 { font-size: 15px; margin: 0 0 4px; }
.step p { font-size: 13px; color: var(--muted); margin: 0 0 10px; }
button { font-size: 13px; min-height: 44px; }
button:disabled { cursor: not-allowed; opacity: .5; transform: none; }
.small-status { font-size: 12px; color: var(--muted); margin-left: 10px; }
.tests { border-top: 1px solid var(--line); padding-top: 20px; }
.tests p { font-size: 13px; color: var(--muted); }
.test-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
.proof { background: #fff; border: 1px solid var(--line); padding: 22px; align-self: start; min-width: 0; }
.count { font: 36px/1.2 ui-monospace, monospace; letter-spacing: -.05em; }
.metrics { display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--line); padding-bottom: 18px; }
.metrics p { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
.feedback-bar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 16px; background: var(--bg); border-bottom: 1px solid var(--line); }
.feedback { flex: 1; min-height: 48px; font-size: 13px; padding: 12px 0; color: var(--muted); }
.jump-result { display: none; white-space: nowrap; font-size: 13px; padding: 12px 0; }
#proof-title { scroll-margin-top: 84px; }
.feedback.error { color: #9b2929; padding: 12px; }
.history { list-style: none; padding: 0; margin: 0; max-height: 515px; overflow-y: auto; }
.event { border-top: 1px solid var(--line); padding: 16px 0; }
.event-head { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; font-weight: 600; }
.event p { font-size: 13px; margin: 7px 0; color: var(--muted); }
.badge { font: 11px/1.5 ui-monospace, monospace; color: var(--accent); background: #e8f0e9; padding: 2px 7px; white-space: nowrap; }
.badge.denied { color: #80501a; background: #fff3df; }
.badge.unexpected { color: #9b2929; background: #fff0f0; }
.evidence { font: 11px/1.7 ui-monospace, monospace; }
pre { font: 12px/1.7 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; background: #f6f7f4; padding: 12px; }
details { margin-top: 20px; border-top: 1px solid var(--line); padding-top: 16px; }
summary { cursor: pointer; font-size: 13px; min-height: 32px; }
.identities { font-size: 12px; }
.identities code { font-size: 11px; }
.empty { padding: 26px 0; font-size: 14px; color: var(--muted); }
.explanation { margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--line); max-width: 740px; }
.explanation h2 { font-size: 18px; }
.explanation p { font-size: 14px; color: var(--muted); }
@media(max-width: 760px) { .jump-result { display: block; } header, main, footer { width: calc(100% - 32px); } .layout { grid-template-columns: 1fr; gap: 24px; } .hero { flex-direction: column; gap: 16px; } .scope { gap: 12px 24px; } .proof { padding: 18px; } .small-status { display: block; margin: 6px 0 0; } }
`;

export function page(csrf: string) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="csrf" content="${escapeHtml(csrf)}"><title>Delegation playground · Capvine</title><link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script></head>
<body><header><a class="brand" href="/">capvine</a><span>Delegation playground</span><button id="reset" class="secondary" data-action="reset" disabled>Reset demo</button></header>
<main><div class="hero"><div><div class="eyebrow">A permission you can put to the test</div><h1>One issue. One allowed action.</h1><p class="intro">Give a coordinator a key to read issue 42. Let it pass a narrower key to a worker. Then try opening the wrong door.</p></div><div class="pill">Local demo · Sample data</div></div>
<p class="limits">Real signatures and server checks. A simulated provider. Your connected accounts are not used. Separate processes are not an OS sandbox.</p>
<div class="scope" aria-label="Fixed permission scope"><div><span>Resource</span><strong>Issue 42</strong></div><div><span>Operation</span><strong>Read only</strong></div><div><span>Delegation</span><strong>Owner → Coordinator → Worker A</strong></div><div><span>Task</span><strong id="task-status">Loading…</strong></div></div>
<div class="feedback-bar"><div id="feedback" class="feedback" role="status" aria-live="polite">Starting the demo…</div><a class="jump-result" href="#proof-title">View results ↓</a></div>
<div class="layout"><section aria-labelledby="steps-title"><div class="section-title"><h2 id="steps-title">Follow the key</h2><span class="small-label">You are the owner</span></div><ol class="steps">
<li class="step"><span class="number" aria-hidden="true">1</span><div><h3>Approve the coordinator</h3><p>Choose the permission once: read this issue for ten minutes. Approval does not read any data.</p><button data-action="approve" disabled>Approve issue 42</button><span class="small-status" id="root-status">No key issued</span></div></li>
<li class="step"><span class="number" aria-hidden="true">2</span><div><h3>Delegate to Worker A</h3><p>The coordinator signs a child key lasting at most five minutes. It cannot add a different issue or a write permission. No new owner approval is needed.</p><button data-action="delegate" disabled>Delegate to Worker A</button><span class="small-status" id="child-status">Waiting for approval</span></div></li>
<li class="step"><span class="number" aria-hidden="true">3</span><div><h3>Use the key</h3><p>Worker A signs a request. The server verifies its identity, proof chain, scope, task, expiry, and revocation before using the provider credential.</p><button data-action="read" disabled>Read issue 42</button><span class="small-status" id="read-status">Waiting for delegation</span></div></li>
<li class="step"><span class="number" aria-hidden="true">4</span><div><h3>Take the permission back</h3><p>Revoke the parent's key, then press Read again. The child must fail too. Ending the task stops all its grants.</p><div class="actions"><button data-action="revoke" class="danger" disabled>Revoke parent</button><button data-action="end-task" class="secondary" disabled>End task</button></div></div></li>
</ol><section class="tests" aria-labelledby="tests-title"><h2 id="tests-title">Try to break the boundary</h2><p>Try these after delegating, while the grant is active. The first four bypass client-side validation and send raw signed requests. Every attempt should be denied.</p><div class="test-buttons"><button data-action="other-resource" class="secondary" disabled>Read issue 43</button><button data-action="write" class="secondary" disabled>Post a comment</button><button data-action="other-worker" class="secondary" disabled>Try as Worker B</button><button data-action="expired" class="secondary" disabled>Send expired request</button><button data-action="direct-provider" class="secondary" disabled>Bypass Capvine</button></div></section></section>
<aside class="proof" aria-labelledby="proof-title"><h2 id="proof-title">What actually happened</h2><div class="metrics"><div><div class="count" id="provider-count">0</div><p>Successful provider reads</p></div><div><div class="count" id="denied-count">0</div><p>Denied attempts</p></div></div><p class="empty" id="empty">Approve a key to begin. Results from the server will appear here.</p><ol class="history" id="history" aria-label="Requests, newest first"></ol><details><summary>Inspect identities and grants</summary><dl class="identities" id="identities"></dl><p class="muted"><small>These are public IDs. Signing keys and provider credentials remain in their respective backend processes.</small></p></details></aside></div>
<section class="explanation"><h2>Where does your approval fit?</h2><p>You approve a scope, not every read. The coordinator can delegate within that scope and Worker A can read repeatedly until the key expires, the parent is revoked, or the task ends. A different resource or operation needs authority that the worker does not have.</p><p>In your application, protected backend code creates grants from authenticated owner choices or a saved approval. Workers receive scoped grants and their own signing identities. The resource server verifies each call and uses the account credential only after approval checks pass.</p><p>This exercises the application permission path. Protecting real accounts also requires isolating the credential store and blocking alternate access through browsers, shells, networks, or account tokens. Returned data can still be disclosed by an authorized reader.</p></section>
<noscript><p class="notice error">Enable JavaScript to use this local playground.</p></noscript></main><footer>Capvine · Experimental authorization library · Temporary fixture state is cleared on reset or shutdown.</footer></body></html>`;
}
