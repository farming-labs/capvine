import {
  createCapvineClient,
  CapvineAPIError,
  type ConnectedAccount,
  type RegisteredResource,
  type SavedWorkflow,
} from "./owner-client.ts";
import type { OwnerConsoleOptions } from "./owner-console.ts";

const node = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const settings = JSON.parse(
  document.querySelector("main")!.dataset.config!,
) as Pick<OwnerConsoleOptions, "providers" | "plugins" | "recipients">;
const client = createCapvineClient({ baseURL: window.location.origin });
let accounts: ConnectedAccount[] = [];
let selected: RegisteredResource | undefined;
let busy = false;
let connectionCursor: string | null = null;
let choiceCursor: string | null = null;
let workflowCursor: string | null = null;
function text(tag: string, value: string) {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
}
function option(value: string, label: string) {
  const el = new Option(label, value);
  return el;
}
function button(
  label: string,
  action: () => Promise<void>,
  className = "secondary",
) {
  const el = text("button", label) as HTMLButtonElement;
  el.type = "button";
  el.className = className;
  el.onclick = () => {
    void run(action);
  };
  return el;
}
function message(value: string, error = false) {
  const status = node("status");
  status.textContent = value;
  status.className = error ? "notice error" : "notice";
  status.setAttribute("role", error ? "alert" : "status");
}
async function run(action: () => Promise<void>) {
  if (busy) return;
  busy = true;
  for (const el of document.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLSelectElement
  >("button,input,select"))
    el.disabled = true;
  message("Working…");
  try {
    await action();
  } catch (error) {
    const signedOut = error instanceof CapvineAPIError && error.status === 401;
    message(
      signedOut
        ? "Your session ended. Sign into your application, then reload this page."
        : "This request did not complete. Check the connection and permission, then try again.",
      true,
    );
  } finally {
    busy = false;
    for (const el of document.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLSelectElement
    >("button,input,select"))
      el.disabled = false;
  }
}
function clearSelection() {
  selected = undefined;
  node("review").hidden = true;
  node<HTMLInputElement>("confirm").checked = false;
}
function accountOptions() {
  const plugin = settings.plugins.find(
    (p) => p.id === node<HTMLSelectElement>("plugin").value,
  );
  const select = node<HTMLSelectElement>("connection");
  select.replaceChildren();
  if (!plugin?.provider) select.append(option("", "No account required"));
  else
    for (const account of accounts.filter(
      (a) => a.provider === plugin.provider && a.status === "connected",
    ))
      select.append(
        option(
          account.id,
          `${account.subject ?? account.id} · ${account.provider}`,
        ),
      );
}
function resetChoices() {
  clearSelection();
  node("choices").replaceChildren();
  choiceCursor = null;
  node("more-choices").hidden = true;
}
async function connections(after?: string) {
  const page = await client.connections.list(after ? { after } : {});
  accounts = after ? [...accounts, ...page.connections] : page.connections;
  const list = node("connections");
  list.replaceChildren();
  for (const account of accounts) {
    const row = text("li", "");
    row.className = "row";
    const info = text("div", "");
    info.append(
      text("strong", account.provider),
      text("p", account.subject ?? "Awaiting account connection"),
      text("small", account.status.replaceAll("_", " ")),
    );
    row.append(info);
    if (account.status !== "disconnected")
      row.append(
        button(
          "Disconnect",
          async () => {
            if (
              !window.confirm(
                "Disconnect this account? Existing resource permissions using it will stop working.",
              )
            ) {
              message("Connection unchanged.");
              return;
            }
            await client.connections.disconnect({ connectionId: account.id });
            resetChoices();
            await connections();
            message(
              "Disconnected. Provider consent can be removed in the provider's account settings.",
            );
          },
          "danger",
        ),
      );
    list.append(row);
  }
  if (!accounts.length)
    list.append(
      text(
        "p",
        "No connected accounts yet. Files can be selected without connecting a service.",
      ),
    );
  connectionCursor = page.nextCursor;
  node("more-connections").hidden = !connectionCursor;
  accountOptions();
}
async function browse(after?: string) {
  const plugin = settings.plugins.find(
    (p) => p.id === node<HTMLSelectElement>("plugin").value,
  );
  if (!plugin) throw new Error("Select a plugin");
  const connectionId = node<HTMLSelectElement>("connection").value;
  if (plugin.provider && !connectionId) {
    message("Connect an account for this service first.", true);
    return;
  }
  const input = {
    plugin: plugin.id,
    ...(connectionId ? { connectionId } : {}),
  };
  const page = await client.resources.discover({
    ...input,
    ...(after ? { after } : {}),
  });
  const choices = node("choices");
  if (!after) choices.replaceChildren();
  for (const item of page.items) {
    const choose = button(
      item.label,
      async () => {
        selected = await client.resources.register({
          ...input,
          type: plugin.type,
          target: item.target,
        });
        node("selection").replaceChildren(
          text("strong", item.label),
          text("p", JSON.stringify(item.target)),
          text("code", selected.id),
        );
        node<HTMLSelectElement>("action").replaceChildren(
          ...selected.actions.map((action) => option(action, action)),
        );
        node<HTMLInputElement>("confirm").checked = false;
        node("review").hidden = false;
        node("review-title").focus();
        message("Resource selected. Review the permission before approving.");
      },
      "choice",
    );
    choose.append(text("small", JSON.stringify(item.target)));
    choices.append(choose);
  }
  if (!page.items.length && !after)
    choices.append(text("p", "No resources found for this selection."));
  choiceCursor = page.nextCursor;
  node("more-choices").hidden = !choiceCursor;
  message("Choose one resource to review its permission.");
}
function workflowRow(saved: SavedWorkflow) {
  const row = text("div", "");
  row.className = "approval";
  const recipient = settings.recipients.find(
    (r) => r.audience === saved.audience,
  );
  row.append(
    text(
      "h3",
      `${saved.action} · ${saved.active ? "Active" : "Disabled or expired"}`,
    ),
    text("p", recipient?.label ?? saved.audience),
    text("code", saved.resource),
    text(
      "p",
      `Approval ends ${new Date(saved.expiresAt * 1000).toLocaleString()}`,
    ),
    text("code", saved.id),
  );
  if (saved.active)
    row.append(
      button(
        "Disable workflow",
        async () => {
          if (
            !window.confirm(
              "Disable this workflow? Its current grants and future renewal will be rejected.",
            )
          ) {
            message("Workflow unchanged.");
            return;
          }
          await client.workflows.disable({ id: saved.id });
          await workflows();
          message(
            "Workflow disabled. Existing and future calls under it are blocked.",
          );
        },
        "danger",
      ),
    );
  return row;
}
async function workflows(after?: string) {
  const page = await client.workflows.list(after ? { after } : {});
  const list = node("workflows");
  if (!after) list.replaceChildren();
  for (const saved of page.workflows) list.append(workflowRow(saved));
  if (!page.workflows.length && !after)
    list.append(
      text(
        "p",
        "No workflows approved yet. Select a resource above to get started.",
      ),
    );
  workflowCursor = page.nextCursor;
  node("more-workflows").hidden = !workflowCursor;
}
for (const provider of settings.providers)
  node("providers").append(
    button(
      `Connect ${provider.label}`,
      async () => {
        await client.connections.connect({
          provider: provider.id,
          returnTo: window.location.pathname,
        });
      },
      "",
    ),
  );
node<HTMLSelectElement>("plugin").replaceChildren(
  ...settings.plugins.map((p) => option(p.id, p.label)),
);
node<HTMLSelectElement>("recipient").replaceChildren(
  ...settings.recipients.map((r) =>
    option(r.audience, `${r.label} · ${r.audience.slice(0, 20)}…`),
  ),
);
node("plugin").onchange = () => {
  resetChoices();
  accountOptions();
};
node("connection").onchange = resetChoices;
for (const id of ["recipient", "action", "duration"])
  node(id).onchange = () => {
    node<HTMLInputElement>("confirm").checked = false;
  };
node("browse").onsubmit = (event) => {
  event.preventDefault();
  void run(() => browse());
};
node("approve").onsubmit = (event) => {
  event.preventDefault();
  void run(async () => {
    if (!selected || !node<HTMLInputElement>("confirm").checked)
      throw new Error("Review required");
    await client.workflows.approve({
      resource: selected.id,
      action: node<HTMLSelectElement>("action").value,
      audience: node<HTMLSelectElement>("recipient").value,
      expiresIn: Number(node<HTMLSelectElement>("duration").value),
      maxGrantSeconds: 300,
    });
    clearSelection();
    await workflows();
    message(
      "Workflow approved. Your application can now issue short-lived grants for this permission.",
    );
  });
};
node("more-connections").onclick = () => {
  void run(() => connections(connectionCursor ?? undefined));
};
node("more-choices").onclick = () => {
  void run(() => browse(choiceCursor ?? undefined));
};
node("more-workflows").onclick = () => {
  void run(() => workflows(workflowCursor ?? undefined));
};
void run(async () => {
  if (settings.providers.length) await connections();
  else accountOptions();
  await workflows();
  message("Ready. Browsing and selecting do not grant access.");
});
