// MCP server factory.
//
// Uses WebStandardStreamableHTTPServerTransport (Web Standard APIs — works in
// Next.js App Router without Node.js ServerResponse). One McpServer is created
// per session and cached in a module-level Map so multiple requests sharing
// the same orchestrator turn see consistent state.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod/v3";

import {
  handleListSlices,
  handleDispatchSlice,
  handleDispatchCustomSlice,
  handleGetBudget,
  handleStop,
} from "./tools";
import type { CustomSliceSpec } from "@/lib/slice-executor";

// ─── Session-scoped server cache ─────────────────────────────────────────────

const serverCache = new Map<string, McpServer>();

// MCP tool handlers must return a content envelope. Every tool here just
// JSON-serializes its handler's result, so wrap that once.
function asTextResult(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

function getOrCreateServer(sessionId: string): McpServer {
  const cached = serverCache.get(sessionId);
  if (cached) return cached;

  const server = new McpServer({ name: "orchestrator", version: "1.0" });

  server.registerTool(
    "list_slices",
    { description: "List slices available to this orchestrator session." },
    async () => asTextResult(await handleListSlices(sessionId))
  );

  server.registerTool(
    "dispatch_slice",
    {
      description: "Dispatch a named slice and wait for its result. Returns output, tokens, duration, and remaining budget.",
      inputSchema: {
        slice_id: z.string().describe("ID of the slice to dispatch"),
        inputs: z.record(z.unknown()).describe("Input variables for the slice prompt template"),
      },
    },
    async ({ slice_id, inputs }) =>
      asTextResult(
        await handleDispatchSlice(sessionId, {
          slice_id,
          inputs: inputs as Record<string, unknown>,
        })
      )
  );

  server.registerTool(
    "dispatch_custom_slice",
    {
      description: "Dispatch an inline custom slice (not from the catalog). Gated by can_create_custom_slices.",
      inputSchema: {
        spec: z.object({
          cli: z.enum(["claude-bedrock", "claude-personal", "claude-local", "codex"]).describe("CLI to use"),
          model: z.string().optional().describe("Model override"),
          allowedTools: z.array(z.string()).optional().describe("Allowed tool list"),
          prompt: z.string().describe("Pre-rendered prompt text"),
          sandbox: z
            .object({
              mode: z.enum(["none", "tmpfs", "worktree"]),
              net: z.enum(["allow", "deny"]).optional(),
            })
            .optional()
            .describe("Sandbox settings"),
          budget: z
            .object({
              max_tokens: z.number().optional(),
              timeout_seconds: z.number().optional(),
            })
            .optional()
            .describe("Budget overrides"),
        }),
        inputs: z.record(z.unknown()).optional().describe("Optional inputs for logging"),
      },
    },
    async ({ spec, inputs }) =>
      asTextResult(
        await handleDispatchCustomSlice(sessionId, {
          spec: spec as unknown as CustomSliceSpec,
          inputs: inputs as Record<string, unknown> | undefined,
        })
      )
  );

  server.registerTool(
    "get_budget",
    { description: "Get the current budget usage and remaining allowances for this session." },
    async () => asTextResult(await handleGetBudget(sessionId))
  );

  server.registerTool(
    "stop",
    {
      description: "Mark the session as stopped so no further slices can be dispatched.",
      inputSchema: {
        reason: z.string().describe("Human-readable reason for stopping"),
      },
    },
    async ({ reason }) => asTextResult(await handleStop(sessionId, { reason }))
  );

  serverCache.set(sessionId, server);
  return server;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Handle an MCP HTTP request (GET/POST/DELETE) for the given session.
 * Creates a fresh WebStandardStreamableHTTPServerTransport per request
 * (stateless mode — no session ID header). The McpServer is cached so
 * tool registrations are shared across requests from the same orchestrator.
 */
export async function handleMcpRequest(
  sessionId: string,
  req: Request
): Promise<Response> {
  const server = getOrCreateServer(sessionId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no Mcp-Session-Id header
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export function removeMcpSession(sessionId: string): void {
  serverCache.delete(sessionId);
}
