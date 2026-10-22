import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "./client.ts";
import { readClaim } from "./profile.ts";
import {
  PermissionDenied,
  type Grant,
  type Identity,
  type Json,
  type Principal,
} from "./types.ts";

export function createMcpServer(options: {
  signer: Identity;
  service: Principal;
  taskId: string;
  transport: (invocation: Uint8Array) => Promise<Json>;
  tools: { name: string; grant: Grant; loadGrant?: () => Promise<Grant> }[];
}) {
  if (!options.taskId || options.tools.length > 32)
    throw new Error("Invalid MCP provisioning");
  const tools = new Map<string, (typeof options.tools)[number]>();
  for (const tool of options.tools) {
    const claim = readClaim(tool.grant);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tool.name) || tools.has(tool.name))
      throw new Error("Invalid or duplicate tool name");
    if (
      tool.grant.audience.did() !== options.signer.did() ||
      claim.task !== options.taskId ||
      claim.service !== options.service.did()
    )
      throw new PermissionDenied(
        "Grant does not belong to this worker session",
      );
    tools.set(tool.name, { ...tool });
  }
  const client = createClient({
    signer: options.signer,
    service: options.service,
    transport: options.transport,
  });
  const server = new Server(
    { name: "capvine", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.keys()].map((name) => ({
      name,
      description: "Read the resource assigned to this tool for this session.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.get(request.params.name);
    if (!tool || Object.keys(request.params.arguments ?? {}).length !== 0)
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "Tool or arguments are not authorized for this session.",
          },
        ],
      };
    try {
      const grant = tool.loadGrant ? await tool.loadGrant() : tool.grant;
      const initial = readClaim(tool.grant);
      const claim = readClaim(grant);
      if (
        grant.audience.did() !== options.signer.did() ||
        claim.resource !== initial.resource ||
        claim.action !== initial.action ||
        claim.task !== initial.task ||
        claim.service !== initial.service
      )
        throw new PermissionDenied("Renewal changed the tool's authority");
      const value = await client.invoke(grant);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              error instanceof PermissionDenied
                ? "Permission denied."
                : "Resource read failed.",
          },
        ],
      };
    }
  });
  return server;
}
