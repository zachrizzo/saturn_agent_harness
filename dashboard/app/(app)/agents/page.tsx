import Link from "next/link";
import { listAgents } from "@/lib/runs";
import { AgentCard } from "./AgentCard";
import { Button } from "@/app/components/ui";

export const revalidate = 0;
export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const agents = await listAgents();

  const scheduled = agents.filter((a) => Boolean(a.cron));
  const onDemand = agents.filter((a) => !a.cron);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Agents</h1>
          <p className="text-[13px] text-muted mt-1">
            {agents.length} saved · {scheduled.length} scheduled · {onDemand.length} on-demand
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/chats/new">
            <Button variant="ghost" size="sm">
              Ad-hoc chat
            </Button>
          </Link>
          <Link href="/agents/new">
            <Button variant="primary" size="sm">
              + New agent
            </Button>
          </Link>
        </div>
      </header>

      {agents.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-[13px] text-muted mb-2">
            No agents yet. Agents are reusable bundles of a CLI, model, and
            system prompt — give one a name and chat with it, or add a cron to
            run it unattended.
          </div>
          <Link
            href="/agents/new"
            className="text-accent hover:underline text-[13px]"
          >
            Create your first agent →
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          {scheduled.length > 0 && (
            <section>
              <div className="sect-head">
                <h2>Scheduled</h2>
                <span className="right">
                  {scheduled.length} {scheduled.length === 1 ? "agent" : "agents"} on cron
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {scheduled.map((a) => (
                  <AgentCard key={a.id} agent={a} />
                ))}
              </div>
            </section>
          )}
          {onDemand.length > 0 && (
            <section>
              <div className="sect-head">
                <h2>On-demand</h2>
                <span className="right">Start a chat manually</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {onDemand.map((a) => (
                  <AgentCard key={a.id} agent={a} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
