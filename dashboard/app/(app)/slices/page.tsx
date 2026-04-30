"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Slice } from "@/lib/slices";
import { SliceCard } from "./SliceCard";
import { Button, Card, Input } from "@/app/components/ui";
import { ImportShareButton } from "@/app/components/share/ImportShareButton";
import { IconSearch } from "@/app/components/shell/icons";

type QuickFilter = "all" | "read-only" | "writes" | "premium";

const QUICK_FILTER_LABELS: Record<QuickFilter, string> = {
  all: "All",
  "read-only": "Read-only",
  writes: "Writes",
  premium: "Premium",
};

export default function SlicesPage() {
  const [slices, setSlices] = useState<Slice[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");

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
    if (quickFilter === "read-only" && s.capability.mutation !== "read-only") return false;
    if (quickFilter === "writes" && s.capability.mutation === "read-only") return false;
    if (quickFilter === "premium" && s.capability.cost_tier !== "premium") return false;
    return true;
  });

  const quickFilterCounts: Record<QuickFilter, number> = {
    all: slices.length,
    "read-only": slices.filter((slice) => slice.capability.mutation === "read-only").length,
    writes: slices.filter((slice) => slice.capability.mutation !== "read-only").length,
    premium: slices.filter((slice) => slice.capability.cost_tier === "premium").length,
  };

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

        <div className="slice-quick-filters" aria-label="Slice filters">
          {(Object.keys(QUICK_FILTER_LABELS) as QuickFilter[]).map((filter) => (
            <button
              key={filter}
              type="button"
              onClick={() => setQuickFilter(filter)}
              className={quickFilter === filter ? "active" : ""}
            >
              <span>{QUICK_FILTER_LABELS[filter]}</span>
              <span>{quickFilterCounts[filter]}</span>
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
            <SliceCard
              key={s.id}
              slice={s}
              onDeleted={(id) => setSlices((prev) => prev.filter((slice) => slice.id !== id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
