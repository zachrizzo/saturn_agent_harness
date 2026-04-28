"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Slice, SliceMutationTier, SliceCostTier } from "@/lib/slices";
import { SliceCard } from "./SliceCard";
import { Button, Card, Chip, Input } from "@/app/components/ui";

const MUTATION_TIERS: SliceMutationTier[] = [
  "read-only",
  "writes-scratch",
  "writes-source",
  "executes-side-effects",
];
const COST_TIERS: SliceCostTier[] = ["free", "cheap", "premium"];

export default function SlicesPage() {
  const [slices, setSlices] = useState<Slice[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [mutationFilter, setMutationFilter] = useState<SliceMutationTier | "all">("all");
  const [costFilter, setCostFilter] = useState<SliceCostTier | "all">("all");

  useEffect(() => {
    fetch("/api/slices")
      .then((r) => r.json())
      .then((data) => {
        setSlices(data.slices ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filtered = slices.filter((s) => {
    if (
      search &&
      !s.name.toLowerCase().includes(search.toLowerCase()) &&
      !s.description?.toLowerCase().includes(search.toLowerCase()) &&
      !s.tags?.some((t) => t.toLowerCase().includes(search.toLowerCase()))
    ) {
      return false;
    }
    if (mutationFilter !== "all" && s.capability.mutation !== mutationFilter) return false;
    if (costFilter !== "all" && s.capability.cost_tier !== costFilter) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <section className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Slices</h1>
          <p className="text-sm text-muted mt-1">
            Reusable specialist sub-agents. Each slice has its own CLI, model, tools, and I/O contract.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/slices/new">
            <Button variant="primary">New slice</Button>
          </Link>
        </div>
      </section>

      <div className="space-y-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, description, or tag…"
          className="max-w-sm"
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-subtle uppercase tracking-wider">Mutation:</span>
          {(["all", ...MUTATION_TIERS] as const).map((tier) => (
            <button
              key={tier}
              type="button"
              onClick={() => setMutationFilter(tier)}
              className={`px-2.5 py-1 rounded text-[11px] border transition-colors ${
                mutationFilter === tier
                  ? "bg-accent-soft border-accent text-accent"
                  : "border-border text-muted hover:bg-bg-hover"
              }`}
            >
              {tier === "all" ? "All" : tier}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-subtle uppercase tracking-wider">Cost:</span>
          {(["all", ...COST_TIERS] as const).map((tier) => (
            <button
              key={tier}
              type="button"
              onClick={() => setCostFilter(tier)}
              className={`px-2.5 py-1 rounded text-[11px] border transition-colors ${
                costFilter === tier
                  ? "bg-accent-soft border-accent text-accent"
                  : "border-border text-muted hover:bg-bg-hover"
              }`}
            >
              {tier === "all" ? "All" : tier}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-muted text-sm">Loading…</div>
      ) : slices.length === 0 ? (
        <Card>
          <div className="p-10 text-center">
            <div className="text-muted mb-2">No slices yet.</div>
            <Link href="/slices/new" className="text-accent hover:underline text-sm">
              Create your first slice
            </Link>
          </div>
        </Card>
      ) : filtered.length === 0 ? (
        <div className="text-muted text-sm">No slices match the current filters.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((s) => (
            <SliceCard key={s.id} slice={s} />
          ))}
        </div>
      )}
    </div>
  );
}
