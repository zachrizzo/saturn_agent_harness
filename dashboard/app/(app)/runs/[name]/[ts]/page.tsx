import { notFound } from "next/navigation";
import { getRun, getTokenBreakdown, getToolCallSummary } from "@/lib/runs";
import { formatDuration, formatTimestamp, formatTokens } from "@/lib/format";
import { toClaudeAlias } from "@/lib/claude-models";
import { RunDetailClient } from "./RunDetailClient";
import { CLI_SHORT_LABELS, DEFAULT_CLI, normalizeCli } from "@/lib/clis";

export const revalidate = 0;
export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ name: string; ts: string }> }) {
  const { name, ts } = await params;
  const run = await getRun(name, ts);
  if (!run) notFound();
  const { meta, events, finalMarkdown, stderr } = run;

  const bd = getTokenBreakdown(events);
  const tokenBreakdown = {
    ...bd,
    formattedInput: formatTokens(bd.input),
    formattedOutput: formatTokens(bd.output),
    formattedCacheCreation: formatTokens(bd.cacheCreation),
    formattedCacheRead: formatTokens(bd.cacheRead),
    formattedTotal: formatTokens(bd.total),
  };

  const toolSummary = getToolCallSummary(events);
  const modelLabel = meta.model ? (toClaudeAlias(meta.model) ?? meta.model) : null;

  return (
    <RunDetailClient
      name={name}
      ts={ts}
      initialMeta={meta}
      initialEvents={events}
      initialFinalMarkdown={finalMarkdown}
      initialStderr={stderr}
      initialTokenBreakdown={tokenBreakdown}
      initialToolSummary={toolSummary}
      formattedStarted={formatTimestamp(meta.started_at)}
      modelLabel={modelLabel}
      cliLabel={CLI_SHORT_LABELS[normalizeCli(meta.cli ?? DEFAULT_CLI)]}
    />
  );
}
