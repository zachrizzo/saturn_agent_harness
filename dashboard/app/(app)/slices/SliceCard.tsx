"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Slice, SliceMutationTier, SliceCostTier } from "@/lib/slices";
import { toClaudeAlias } from "@/lib/claude-models";
import { CLI_LABELS, CLI_SHORT_LABELS, normalizeCli } from "@/lib/clis";
import { Button, Card, Chip } from "@/app/components/ui";
import { ShareExportButton } from "@/app/components/share/ShareExportButton";
import { IconBash, IconDispatch, IconEdit, IconFork, IconSlice } from "@/app/components/shell/icons";

function mutationVariant(tier: SliceMutationTier): "success" | "warn" | "fail" | "default" {
  switch (tier) {
    case "read-only": return "success";
    case "writes-scratch": return "warn";
    case "writes-source": return "fail";
    case "executes-side-effects": return "fail";
    default: return "default";
  }
}

function costVariant(tier: SliceCostTier): "success" | "accent" | "warn" | "default" {
  switch (tier) {
    case "free": return "success";
    case "cheap": return "accent";
    case "premium": return "warn";
    default: return "default";
  }
}

function formatTier(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function SliceCard({ slice }: { slice: Slice }) {
  const router = useRouter();
  const [duplicating, setDuplicating] = useState(false);

  const handleDuplicate = async () => {
    setDuplicating(true);
    try {
      const copyId = `${slice.id}-copy`;
      const res = await fetch("/api/slices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...slice,
          id: copyId,
          name: `${slice.name} (copy)`,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "duplicate failed");
      }
      const { slice: created } = await res.json();
      router.push(`/slices/${encodeURIComponent(created.id)}/edit`);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Duplicate failed");
      setDuplicating(false);
    }
  };

  const mutation = slice.capability.mutation;
  const costTier = slice.capability.cost_tier;
  const cli = normalizeCli(slice.cli);
  const modelLabel = slice.model ? toClaudeAlias(slice.model) ?? slice.model : "CLI default";
  const scopeLabel = slice.capability.scope?.length
    ? slice.capability.scope.map(formatTier).join(", ")
    : "Repo";
  const outputLabel = formatTier(slice.capability.output?.kind ?? "markdown");
  const toolCount = slice.allowedTools?.length ?? 0;

  return (
    <Card interactive className="slice-card">
      <div className="slice-card-main">
        <div className="slice-card-icon" aria-hidden="true">
          <IconSlice className="w-4 h-4" />
        </div>

        <div className="slice-card-content">
          <header className="slice-card-header">
            <div className="min-w-0">
              <Link
                href={`/slices/${encodeURIComponent(slice.id)}/edit`}
                className="slice-card-title"
              >
                {slice.name}
              </Link>
              <div className="slice-card-id mono">{slice.id}</div>
            </div>
            <span className="slice-card-version mono">v{slice.version}</span>
          </header>

          <div className="slice-card-chips">
            <Chip variant={mutationVariant(mutation)}>
              {formatTier(mutation)}
            </Chip>
            <Chip variant={costVariant(costTier)}>
              {formatTier(costTier)}
            </Chip>
            <Chip title={CLI_LABELS[cli]}>{CLI_SHORT_LABELS[cli]}</Chip>
          </div>

          {slice.description ? (
            <p className="slice-card-description">{slice.description}</p>
          ) : (
            <p className="slice-card-description muted">No description</p>
          )}

          <dl className="slice-card-meta">
            <div>
              <dt>Model</dt>
              <dd className="mono" title={slice.model ?? undefined}>{modelLabel}</dd>
            </div>
            <div>
              <dt>Scope</dt>
              <dd>{scopeLabel}</dd>
            </div>
            <div>
              <dt>Output</dt>
              <dd>{outputLabel}</dd>
            </div>
            <div>
              <dt>Tools</dt>
              <dd>{toolCount === 0 ? "Default" : toolCount}</dd>
            </div>
          </dl>

          {slice.tags && slice.tags.length > 0 && (
            <div className="slice-card-tags">
              {slice.tags.slice(0, 5).map((t) => (
                <span key={t}>{t}</span>
              ))}
              {slice.tags.length > 5 && <span>+{slice.tags.length - 5}</span>}
            </div>
          )}
        </div>
      </div>

      <div className="slice-card-actions">
        <Link href={`/slices/${encodeURIComponent(slice.id)}/edit`} className="btn slice-card-action">
          <IconEdit className="w-3.5 h-3.5" />
          Edit
        </Link>
        <Link href={`/slices/${encodeURIComponent(slice.id)}/test`} className="btn slice-card-action">
          <IconBash className="w-3.5 h-3.5" />
          Test
        </Link>
        <span className="slice-card-share">
          <IconDispatch className="w-3.5 h-3.5" />
          <ShareExportButton
            endpoint={`/api/share/slices/${encodeURIComponent(slice.id)}`}
            filename={`saturn-slice-${slice.id}`}
          />
        </span>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={handleDuplicate}
          disabled={duplicating}
          className="slice-card-action"
        >
          <IconFork className="w-3.5 h-3.5" />
          {duplicating ? "Duplicating..." : "Duplicate"}
        </Button>
      </div>
    </Card>
  );
}
