"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Slice, SliceMutationTier, SliceCostTier } from "@/lib/slices";
import { toClaudeAlias } from "@/lib/claude-models";
import { CLI_LABELS, CLI_SHORT_LABELS, normalizeCli } from "@/lib/clis";
import { Button, Card, Chip } from "@/app/components/ui";

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

  return (
    <Card className="overflow-hidden">
      <header className="px-4 py-3 flex items-center gap-2 flex-wrap border-b border-border">
        <Link
          href={`/slices/${encodeURIComponent(slice.id)}/edit`}
          className="text-base font-semibold hover:text-accent transition"
        >
          {slice.name}
        </Link>
        <Chip variant={mutationVariant(mutation)} className="text-[10px]">
          {mutation}
        </Chip>
        <Chip variant={costVariant(costTier)} className="text-[10px]">
          {costTier}
        </Chip>
        <Chip className="text-[10px]" title={CLI_LABELS[cli]}>{CLI_SHORT_LABELS[cli]}</Chip>
        {slice.model && (
          <Chip className="mono text-[10px] max-w-[160px] truncate" title={slice.model}>
            {toClaudeAlias(slice.model) ?? slice.model}
          </Chip>
        )}
      </header>

      {slice.description && (
        <div className="px-4 py-2 text-xs text-muted border-b border-border line-clamp-2">
          {slice.description}
        </div>
      )}

      {slice.tags && slice.tags.length > 0 && (
        <div className="px-4 py-2 flex flex-wrap gap-1 border-b border-border">
          {slice.tags.map((t) => (
            <Chip key={t} className="text-[10px]">{t}</Chip>
          ))}
        </div>
      )}

      <div className="px-4 py-3 flex items-center gap-2 flex-wrap">
        <Link href={`/slices/${encodeURIComponent(slice.id)}/edit`}>
          <Button variant="default" size="sm">Edit</Button>
        </Link>
        <Link href={`/slices/${encodeURIComponent(slice.id)}/test`}>
          <Button variant="default" size="sm">Test</Button>
        </Link>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={handleDuplicate}
          disabled={duplicating}
        >
          {duplicating ? "Duplicating…" : "Duplicate"}
        </Button>
        <span className="ml-auto text-[11px] text-subtle mono">v{slice.version}</span>
      </div>
    </Card>
  );
}
