import { MemoryWorkspace } from "@/app/components/memory/MemoryWorkspace";
import { readAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const settings = await readAppSettings();
  return <MemoryWorkspace defaultCwd={settings.defaultCwd ?? null} />;
}
