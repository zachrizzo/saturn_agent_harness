import { notFound, redirect } from "next/navigation";
import { getAgent } from "@/lib/runs";
import { AgentForm } from "../../AgentForm";

export const dynamic = "force-dynamic";

export default async function AgentEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = await getAgent(id);

  if (!agent) {
    notFound();
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Edit agent</h1>
        <p className="text-[13px] text-muted mt-1 mono">{agent.id}</p>
      </header>
      <AgentForm existing={agent} />
    </div>
  );
}
