export const NEW_CHAT_AGENT_PARAM = "agent";

export function newChatHrefForAgent(agentId: string): string {
  return `/chats/new?${NEW_CHAT_AGENT_PARAM}=${encodeURIComponent(agentId)}`;
}
