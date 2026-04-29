"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Slice, SliceMutationTier, SliceCostTier } from "@/lib/slices";
import { SliceCard } from "./SliceCard";
import { Button, Card, Input } from "@/app/components/ui";
import { ImportShareButton } from "@/app/components/share/ImportShareButton";
import { IconSearch } from "@/app/components/shell/icons";

const MUTATION_TIERS: SliceMutationTier[] = [
  "read-only",
  "writes-scratch",
  "writes-source",
  "executes-side-effects",
];
const COST_TIERS: SliceCostTier[] = ["free", "cheap", "premium"];

const MUTATION_LABELS: Record<SliceMutationTier | "all", string> = {
  all: "All",
  "read-only": "Read only",
  "writes-scratch": "Scratch writes",
  "writes-source": "Source writes",
  "executes-side-effects": "Side effects",
};

const COST_LABELS: Record<SliceCostTier | "all", string> = {
  all: "All",
  free: "Free",
  cheap: "Cheap",
  premium: "Premium",
};

export default function SlicesPage() {
  const [slices, setSlices] = useState<Slice[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [mutationFilter, setMutationFilter] = useState<SliceMutationTier | "all">("all");
  const [costFilter, setCostFilter] = useState<SliceCostTier | "all">("all");

  const loadSlices = () => {
    setLoading(true);
    fetch("/api/slices")
      .then((r) => r.json())
      .then((data) => {
        setSlices(data.slices ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    loadSlices();
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

  const mutationCounts = Object.fromEntries(
    (["all", ...MUTATION_TIERS] as const).map((tier) => [
      tier,
      tier === "all"
        ? slices.length
        : slices.filter((slice) => slice.capability.mutation === tier).length,
    ])
  ) as Record<SliceMutationTier | "all", number>;

  const costCounts = Object.fromEntries(
    (["all", ...COST_TIERS] as const).map((tier) => [
      tier,
      tier === "all"
        ? slices.length
        : slices.filter((slice) => slice.capability.cost_tier === tier).length,
    ])
  ) as Record<SliceCostTier | "all", number>;

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
          <ImportShareButton onImported={loadSlices} />
          <Link href="/slices/new">
            <Button variant="primary">New slice</Button>
          </Link>
        </div>
      </section>

      <div className="slice-catalog-toolbar">
        <div className="slice-search-row">
          <label className="slice-search" aria-label="Search slices">
            <IconSearch className="w-4 h-4" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search slices"
            />
          </label>

          <div className="slice-results-count">
            {filtered.length} / {slices.length}
          </div>
        </div>

        <div className="slice-filter-groups">
          <div className="slice-filter-group" aria-label="Access filter">
            <span className="slice-filter-label">Access</span>
            <div className="slice-segmented">
              {(["all", ...MUTATION_TIERS] as const).map((tier) => (
                <button
                  key={tier}
                  type="button"
                  onClick={() => setMutationFilter(tier)}
                  className={mutationFilter === tier ? "active" : ""}
                >
                  <span>{MUTATION_LABELS[tier]}</span>
                  <span className="slice-filter-count">{mutationCounts[tier]}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="slice-filter-group" aria-label="Cost filter">
            <span className="slice-filter-label">Cost</span>
            <div className="slice-segmented">
              {(["all", ...COST_TIERS] as const).map((tier) => (
                <button
                  key={tier}
                  type="button"
                  onClick={() => setCostFilter(tier)}
                  className={costFilter === tier ? "active" : ""}
                >
                  <span>{COST_LABELS[tier]}</span>
                  <span className="slice-filter-count">{costCounts[tier]}</span>
                </button>
              ))}
            </div>
          </div>
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
