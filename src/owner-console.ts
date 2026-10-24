import { readFile } from "node:fs/promises";
import { ed25519 } from "@ucanto/principal";
import type { createApplication } from "./application.ts";
import {
  applicationURL,
  CapvineAPIError,
  string,
} from "./application-contract.ts";
import { escapeHtml, styles } from "./account-console-view.ts";

export interface OwnerConsoleOptions {
  app: Awaited<ReturnType<typeof createApplication>>;
  baseURL: string;
  path?: string;
  providers: { id: string; label: string }[];
  plugins: { id: string; label: string; type: string; provider?: string }[];
  recipients: { label: string; audience: `did:key:${string}` }[];
}

export function createOwnerConsole(options: OwnerConsoleOptions) {
  const origin = applicationURL(options.baseURL).origin;
  if (new URL(options.app.service.invocationURL).origin !== origin)
    throw new Error("Console and application must share an origin");
  const path = options.path ?? "/capvine";
  if (!/^\/[a-z][a-z0-9-]{0,63}$/.test(path) || path === "/api")
    throw new Error("Console requires a single application-relative path");
  const settings = structuredClone({
    providers: options.providers,
    plugins: options.plugins,
    recipients: options.recipients,
  });
  for (const items of [
    settings.providers,
    settings.plugins,
    settings.recipients,
  ]) {
    if (items.length > 32) throw new Error("Console option limit exceeded");
    for (const item of items) string(item.label, 128);
  }
  for (const items of [settings.providers, settings.plugins]) {
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw new Error("Duplicate console option");
    for (const item of items)
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(item.id))
        throw new Error("Invalid console option");
  }
  for (const plugin of settings.plugins) {
    string(plugin.type, 128);
    if (
      plugin.provider &&
      !settings.providers.some((p) => p.id === plugin.provider)
    )
      throw new Error("Unknown console provider");
  }
  for (const recipient of settings.recipients)
    ed25519.Verifier.parse(recipient.audience);
  const app = options.app;
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  function response(content: string, type: string, status = 200) {
    return new Response(content, {
      status,
      headers: { ...headers, "content-type": type },
    });
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Permissions · Capvine</title><link rel="stylesheet" href="${path}/style.css"></head><body><header><a class="brand" href="${path}">capvine</a><span>Permission workspace</span></header><main data-config="${escapeHtml(JSON.stringify(settings))}"><div class="eyebrow">Owner access</div><h1>Choose what can be used.</h1><p class="intro">Connect an account, select one resource, then approve a limited workflow. Your applications receive only the permission you approve.</p><p id="status" role="status" aria-live="polite">Loading your workspace…</p><section class="panel"><h2>1. Connect a service</h2><div id="providers" class="actions"></div><ul id="connections" class="list"></ul><button id="more-connections" class="secondary" hidden>More connections</button></section><section class="panel"><h2>2. Choose a resource</h2><form id="browse"><label for="plugin">Resource type</label><select id="plugin" required></select><label for="connection">Account</label><select id="connection"></select><button class="spaced" type="submit">Browse resources</button></form><div id="choices" class="spaced"></div><button id="more-choices" class="secondary" hidden>More resources</button></section><section class="panel" id="review" hidden aria-labelledby="review-title"><h2 id="review-title" tabindex="-1">3. Review this permission</h2><p id="selection"></p><form id="approve"><label for="recipient">Recipient</label><select id="recipient" required></select><label for="action">Allowed action</label><select id="action" required></select><label for="duration">Approval duration</label><select id="duration"><option value="3600">1 hour</option><option value="86400">1 day</option><option value="604800">7 days</option></select><p class="muted spaced">Each proof lasts at most 5 minutes. The selected recipient can delegate within the same permission. Disable the workflow to stop existing and future use.</p><label class="confirm"><input id="confirm" type="checkbox" required> I approve this resource, action, recipient and duration.</label><button class="spaced" type="submit">Approve workflow</button></form></section><section class="panel"><h2>Saved workflows</h2><p class="muted">Approvals persist after restart. Grant delivery and renewal run through your application's protected assignment channel.</p><div id="workflows"></div><button id="more-workflows" class="secondary" hidden>More workflows</button></section></main><footer>Capvine · Owner permission workspace</footer><script type="module" src="${path}/assets/owner-console-browser.js"></script></body></html>`;
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (
      url.origin !== origin ||
      (url.pathname !== path && !url.pathname.startsWith(`${path}/`))
    )
      return null;
    if (request.method !== "GET" || url.search)
      return response("Not found", "text/plain", 404);
    try {
      const sessionHeaders = new Headers(request.headers);
      sessionHeaders.set("origin", origin);
      await app.api.resources.list({ headers: sessionHeaders });
      if (url.pathname === path)
        return response(html, "text/html; charset=utf-8");
      if (url.pathname === `${path}/style.css`)
        return response(
          styles +
            "\n[hidden]{display:none!important}button:disabled{cursor:wait}.choice{display:block;text-align:left;width:100%;margin:8px 0;background:white;color:var(--ink);border-color:var(--line);overflow-wrap:anywhere}.choice:hover{background:#edf1ec}.choice small{display:block}#status{min-height:28px}.row>div{min-width:0}.row form{flex-shrink:0}",
          "text/css",
        );
      const name = url.pathname.slice(`${path}/assets/`.length);
      if (
        url.pathname.startsWith(`${path}/assets/`) &&
        [
          "owner-console-browser.js",
          "owner-client.js",
          "application-contract.js",
        ].includes(name)
      )
        return response(
          await readFile(
            new URL(
              import.meta.url.endsWith(".ts") ? `../dist/${name}` : name,
              import.meta.url,
            ),
            "utf8",
          ),
          "text/javascript",
        );
      return response("Not found", "text/plain", 404);
    } catch (error) {
      const status = error instanceof CapvineAPIError ? error.status : 503;
      return response(
        status === 401
          ? "Sign into your application to open the permission workspace."
          : "Permission workspace unavailable.",
        "text/plain",
        status,
      );
    }
  };
}
