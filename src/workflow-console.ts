import { startOwnerConsole } from "./account-console.ts";
import type { WorkflowManager } from "./workflows.ts";

export async function startWorkflowConsole(options: {
  workflows: WorkflowManager;
  loginKey: string;
  port?: number;
}) {
  return startOwnerConsole({
    ...options,
    ownerId: options.workflows.ownerId,
  });
}
