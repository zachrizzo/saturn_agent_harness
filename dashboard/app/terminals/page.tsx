import { listAllTerminals } from "@/lib/terminals";
import { TerminalsWorkspace } from "./TerminalsWorkspace";

export const dynamic = "force-dynamic";

export default async function TerminalsPage() {
  const initialData = await listAllTerminals();
  return <TerminalsWorkspace initialData={initialData} />;
}
