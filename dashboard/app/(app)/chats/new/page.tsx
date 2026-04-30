import { NewChatForm } from "./NewChatForm";
import { NEW_CHAT_AGENT_PARAM } from "@/lib/agent-navigation";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function NewChatPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const sp = searchParams ? await searchParams : {};
  const initialAgentId = firstParam(sp[NEW_CHAT_AGENT_PARAM] ?? sp.agent_id);

  return (
    <div className="flex flex-col items-center justify-start pt-16 px-6 min-h-[60vh]">
      <div className="w-full mb-10 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">New chat</h1>
        <p className="text-[14px] text-muted mt-2">
          Start a conversation with any of your AI agents.
        </p>
      </div>
      <NewChatForm initialAgentId={initialAgentId} />
    </div>
  );
}
