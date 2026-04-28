import { NewChatForm } from "./NewChatForm";

export const dynamic = "force-dynamic";

export default function NewChatPage() {
  return (
    <div className="flex flex-col items-center justify-start pt-16 px-6 min-h-[60vh]">
      <div className="w-full mb-10 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">New chat</h1>
        <p className="text-[14px] text-muted mt-2">
          Start a conversation with any of your AI agents.
        </p>
      </div>
      <NewChatForm />
    </div>
  );
}
