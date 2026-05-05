"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { RunMeta } from "@/lib/runs";
import { formatDuration, formatTimestamp, formatTokens } from "@/lib/format";
import { statusVariant } from "@/lib/job-helpers";
import { Card, Chip } from "@/app/components/ui";
import { GeneratedOutputView } from "@/app/components/generated-ui/GeneratedOutputView";

export type LatestJobResult = {
  run: RunMeta;
  output: string;
};

type Props = {
  results: LatestJobResult[];
};

function runKey(run: RunMeta): string {
  return `${run.name}/${run.slug}`;
}

function outputTitle(output: string, run: RunMeta): string {
  const titleMatch = output.match(/```(?:saturn-ui|saturn-ui\s+json)\s*\n([\s\S]*?)```/i);
  if (titleMatch) {
    try {
      const parsed = JSON.parse(titleMatch[1]) as { title?: unknown };
      if (typeof parsed.title === "string" && parsed.title.trim()) return parsed.title.trim();
    } catch {
      // Fall back to Markdown title.
    }
  }
  const heading = output.split("\n").find((line) => /^#{1,3}\s+\S/.test(line));
  return heading ? heading.replace(/^#{1,3}\s+/, "").trim() : run.name;
}

function firstMeaningfulLine(output: string): string {
  const withoutUi = output.replace(/```(?:saturn-ui|saturn-ui\s+json)\s*\n[\s\S]*?```/gi, "").trim();
  const line = withoutUi
    .split("\n")
    .map((item) => item.replace(/^[-*#>\s]+/, "").trim())
    .find(Boolean);
  return line || "Structured job result";
}

export function LatestJobResults({ results }: Props) {
  const [selectedKey, setSelectedKey] = useState(() => results[0] ? runKey(results[0].run) : "");
  const selected = useMemo(
    () => results.find((result) => runKey(result.run) === selectedKey) ?? results[0],
    [results, selectedKey],
  );

  if (results.length === 0) {
    return (
      <Card className="latest-results-empty">
        <div>No job results yet.</div>
        <p>Run a job and its generated result UI will appear here.</p>
      </Card>
    );
  }

  return (
    <Card className="latest-results">
      <div className="latest-results-list" aria-label="Recent job results">
        {results.map((result) => {
          const key = runKey(result.run);
          const active = key === runKey(selected.run);
          return (
            <button
              key={key}
              type="button"
              className={`latest-results-item ${active ? "active" : ""}`}
              onClick={() => setSelectedKey(key)}
            >
              <span className="latest-results-item-top">
                <strong>{outputTitle(result.output, result.run)}</strong>
                <Chip variant={statusVariant(result.run.status)} dot>
                  {result.run.status}
                </Chip>
              </span>
              <span className="latest-results-job">{result.run.name}</span>
              <span className="latest-results-line">{firstMeaningfulLine(result.output)}</span>
              <span className="latest-results-meta">
                {formatTimestamp(result.run.finished_at ?? result.run.started_at)} · {formatDuration(result.run.duration_ms)} · {formatTokens(result.run.total_tokens)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="latest-results-detail">
        <div className="latest-results-detail-head">
          <div>
            <div className="eyebrow">Latest result</div>
            <h3>{outputTitle(selected.output, selected.run)}</h3>
            <p>{selected.run.name}</p>
          </div>
          <Link href={`/runs/${encodeURIComponent(selected.run.name)}/${encodeURIComponent(selected.run.slug)}`} className="btn text-[12px] py-1.5 px-3">
            Open run
          </Link>
        </div>
        <div className="latest-results-output">
          <GeneratedOutputView markdown={selected.output} />
        </div>
      </div>
    </Card>
  );
}
