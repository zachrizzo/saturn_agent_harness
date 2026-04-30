// MCP server factory.
//
// Uses WebStandardStreamableHTTPServerTransport (Web Standard APIs, compatible
// with Next.js App Router without Node.js ServerResponse). The transport is
// stateless, so each HTTP request gets a fresh McpServer wired to the session's
// persistent on-disk state.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod/v3";

import {
  handleListSlices,
  handleDispatchSlice,
  handleDispatchCustomSlice,
  handleRunSliceGraph,
  handleGetSliceGraphRun,
  handleGetBudget,
  handleStop,
} from "./tools";
import type { CustomSliceSpec } from "@/lib/slice-executor";

// MCP tool handlers must return a content envelope. Every tool here just
// JSON-serializes its handler's result, so wrap that once.
function asTextResult(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

function createServer(sessionId: string): McpServer {
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
    "run_slice_graph",
    {
      description:
        "Execute this orchestrator's saved slice graph in dependency order. Upstream node outputs are passed to downstream nodes as upstream_results so connected sub-agents can communicate.",
      inputSchema: {
        inputs: z.record(z.unknown()).optional().describe("Shared inputs for every workflow node, such as task, target files, or diff summary"),
        start_node_id: z.string().optional().describe("Optional graph node id to start from; downstream nodes will run after it"),
        max_nodes: z.number().optional().describe("Optional cap for smoke tests or partial graph execution"),
        wait: z.boolean().optional().describe("Set true only for short smoke tests. By default this starts a background graph run and returns graph_run_id immediately."),
      },
    },
    async ({ inputs, start_node_id, max_nodes, wait }) =>
      asTextResult(
        await handleRunSliceGraph(sessionId, {
          inputs: inputs as Record<string, unknown> | undefined,
          start_node_id,
          max_nodes,
          wait,
        })
      )
  );

  server.registerTool(
    "get_slice_graph_run",
    {
      description:
        "Poll a run started by run_slice_graph. Returns node runs, status, terminal results, and upstream_result_count for each node.",
      inputSchema: {
        graph_run_id: z.string().optional().describe("Graph run id returned by run_slice_graph. Omit to fetch the latest run for this session."),
        wait_seconds: z.number().optional().describe("Optionally wait up to 30 seconds for the run to advance or finish before returning."),
      },
    },
    async ({ graph_run_id, wait_seconds }) =>
      asTextResult(
        await handleGetSliceGraphRun(sessionId, {
          graph_run_id,
          wait_seconds,
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

  return server;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Handle an MCP HTTP request (GET/POST/DELETE) for the given session.
 * Creates a fresh WebStandardStreamableHTTPServerTransport per request
 * (stateless mode, no Mcp-Session-Id header). A fresh McpServer avoids the SDK
 * reconnect guard while all durable tool state still comes from the session id.
 */
export async function handleMcpRequest(
  sessionId: string,
  req: Request
): Promise<Response> {
  const server = createServer(sessionId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no Mcp-Session-Id header
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export function removeMcpSession(sessionId: string): void {
  void sessionId;
}
