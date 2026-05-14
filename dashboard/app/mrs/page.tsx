import { readAppSettings } from "@/lib/settings";
import { MergeRequestsWorkspace, type MrWorkspaceSettings } from "./MergeRequestsWorkspace";

export const dynamic = "force-dynamic";

function workspaceSettings(settings: Awaited<ReturnType<typeof readAppSettings>>): MrWorkspaceSettings {
  const defaultModel = settings.defaultModels[settings.defaultCli];
  return {
    defaultCli: settings.defaultCli,
    defaultMcpTools: settings.defaultMcpTools,
    defaultModel,
    defaultReasoningEffort: settings.defaultReasoningEfforts[settings.defaultCli],
    defaultCwd: settings.defaultCwd,
  };
}

export default async function MergeRequestsPage() {
  const settings = await readAppSettings();
  return <MergeRequestsWorkspace settings={workspaceSettings(settings)} />;
}
