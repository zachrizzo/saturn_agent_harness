import { permanentRedirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function OldChatSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  permanentRedirect(`/chats/${sessionId}`);
}
