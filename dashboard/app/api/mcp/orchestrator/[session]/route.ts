// MCP orchestrator endpoint.
//
// GET  — SSE stream (server-to-client, keep-alive); Claude Code connects here
//        to discover the POST URL and receive any server notifications.
// POST — JSON-RPC messages from Claude Code → dispatched to the McpServer.
//
// Authentication: short-lived HMAC token in the `token` query parameter,
// minted by lib/mcp/auth.ts when the turn is spawned.

import { type NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/mcp/auth";
import { handleMcpRequest } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = Promise<{ session: string }>;

function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

async function authorizeAndHandle(req: NextRequest, params: Params) {
  const { session: sessionId } = await params;
  const token = req.nextUrl.searchParams.get("token");
  if (!token || !verifyToken(token, sessionId)) return unauthorized();
  return handleMcpRequest(sessionId, req);
}

// GET handles SSE keep-alive via WebStandardStreamableHTTPServerTransport;
// POST handles JSON-RPC; DELETE tears down the session.
export async function GET(req: NextRequest, { params }: { params: Params }) {
  return authorizeAndHandle(req, params);
}

export async function POST(req: NextRequest, { params }: { params: Params }) {
  return authorizeAndHandle(req, params);
}

export async function DELETE(req: NextRequest, { params }: { params: Params }) {
  return authorizeAndHandle(req, params);
}
