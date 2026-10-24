import type { WorkflowDefinition } from "./workflows.ts";

export function validateWorkflowDefinitions(definitions: WorkflowDefinition[]) {
  if (
    definitions.length > 32 ||
    new Set(definitions.map((item) => item.id)).size !== definitions.length
  )
    throw new Error("Configure at most 32 workflows with unique IDs");
  for (const item of definitions) {
    if (
      Object.keys(item).some(
        (key) =>
          ![
            "id",
            "label",
            "resource",
            "action",
            "toolName",
            "approvalSeconds",
            "grantSeconds",
            "workerSeconds",
          ].includes(key),
      ) ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(item.id) ||
      !item.label ||
      item.label.length > 128 ||
      !item.resource.startsWith("urn:capvine:resource:") ||
      !item.action ||
      item.action.length > 1024 ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(item.toolName) ||
      !Number.isSafeInteger(item.approvalSeconds) ||
      item.approvalSeconds < 60 ||
      item.approvalSeconds > 31 * 86_400 ||
      !Number.isSafeInteger(item.grantSeconds) ||
      item.grantSeconds < 60 ||
      item.grantSeconds > 3600 ||
      !Number.isSafeInteger(item.workerSeconds) ||
      item.workerSeconds < 60 ||
      item.workerSeconds > item.grantSeconds
    )
      throw new Error("Invalid workflow definition");
  }
}
