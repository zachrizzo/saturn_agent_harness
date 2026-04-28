import type { RunMeta } from "@/lib/runs";

type Props = {
  runs: RunMeta[]; // newest-first expected; we'll sort oldest→newest for rendering
  slots?: number;  // how many bar slots to render (default 24)
  width?: number;
  height?: number;
};

/**
 * Tiny inline-SVG sparkline. One vertical bar per run (newest on the right).
 * Missing-run slots render as a very muted empty bar to preserve rhythm.
 */
export function RunSparkline({ runs, slots = 24, width = 120, height = 20 }: Props) {
  // take newest `slots` runs, then reverse so newest is on the right
  const recent = runs.slice(0, slots).reverse();
  const padStart = Math.max(0, slots - recent.length);

  const gap = 1;
  const barW = Math.max(1, (width - (slots - 1) * gap) / slots);

  function colorFor(r: RunMeta | undefined): string {
    if (!r) return "var(--border)";
    if (r.status === "success") return "var(--success)";
    if (r.status === "failed") return "var(--fail)";
    return "var(--warn)"; // running
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block"
      aria-hidden
    >
      {Array.from({ length: slots }).map((_, i) => {
        const runIdx = i - padStart;
        const r = runIdx >= 0 ? recent[runIdx] : undefined;
        const x = i * (barW + gap);
        const h = r ? height : Math.max(2, height * 0.25);
        const y = height - h;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={h}
            rx={0.5}
            fill={colorFor(r)}
            opacity={r ? 0.9 : 0.35}
          />
        );
      })}
    </svg>
  );
}
