import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { spawn } from "child_process";
import { getAgent, updateAgent } from "@/lib/runs";
import { binDir } from "@/lib/paths";

export const dynamic = "force-dynamic";

// POST /api/agents/[id]/schedule { cron: "*/5 * * * *" }  or  { cron: null } to clear
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { cron } = (await req.json()) as { cron: string | null };

  const agent = await getAgent(id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    await updateAgent(id, { cron: cron ?? null });

    // Invoke register-job.sh to sync crontab
    const register = path.join(binDir(), "register-job.sh");
    const proc = spawn(register, [], { detached: true, stdio: "ignore" });
    proc.unref();

    return NextResponse.json({ success: true, cron });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed" }, { status: 500 });
  }
}
