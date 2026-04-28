import { AgentForm } from "../AgentForm";

export const dynamic = "force-dynamic";

export default function NewAgentPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">New agent</h1>
      <AgentForm />
    </div>
  );
}
