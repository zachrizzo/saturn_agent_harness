import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sessionsRoot } from "@/lib/paths";
import { executeSlice } from "@/lib/slice-executor";
import { initBudget } from "@/lib/budget";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sliceId } = await params;
  const body = await req.json().catch(() => ({}));
  const inputs = (body.inputs ?? {}) as Record<string, unknown>;

  const testSessionId = `_test-${randomUUID().slice(0, 8)}`;

  // Create test session dir + minimal meta.json so slice-executor doesn't crash
  const sessionDir = path.join(sessionsRoot(), testSessionId);
  await fs.mkdir(path.join(sessionDir, "slices"), { recursive: true });

  const minimalMeta = {
    session_id: testSessionId,
    status: "running",
    started_at: new Date().toISOString(),
    turns: [],
    agent_snapshot: {
      id: "__test__",
      name: "Test",
      kind: "orchestrator",
      prompt: "",
      cli: "claude-bedrock",
      created_at: new Date().toISOString(),
    },
  };
  await fs.writeFile(
    path.join(sessionDir, "meta.json"),
    JSON.stringify(minimalMeta, null, 2)
  );

  // Initialize budget (required by slice-executor)
  await initBudget(testSessionId);

  const result = await executeSlice({ sessionId: testSessionId, sliceId, inputs });

  // Mark test session as done so GC can clean it up
  await fs.writeFile(path.join(sessionDir, "_test_marker"), testSessionId);

  return NextResponse.json(result);
}
