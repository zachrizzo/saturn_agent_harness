"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Props = {
  data: Array<{ date: string } & Record<string, number>>;
  sources: string[];
};

// Palette chosen to have sufficient contrast in both light and dark themes.
const PALETTE = [
  "#3b82f6", // blue
  "#22c55e", // green
  "#f59e0b", // amber
  "#a855f7", // purple
  "#ef4444", // red
  "#14b8a6", // teal
  "#ec4899", // pink
  "#eab308", // yellow
];

function formatTick(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function formatDate(s: string): string {
  // YYYY-MM-DD → MM/DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return `${s.slice(5, 7)}/${s.slice(8, 10)}`;
}

function sourceTotal(data: Props["data"], source: string): number {
  return data.reduce((total, row) => total + (Number(row[source]) || 0), 0);
}

export function TokensChart({ data, sources }: Props) {
  if (sources.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-bg-elev p-8 text-center text-sm text-muted">
        No token usage yet. Tokens will appear here once jobs or chats run.
      </div>
    );
  }

  const rankedSources = [...sources].sort((a, b) => sourceTotal(data, b) - sourceTotal(data, a));

  return (
    <div className="rounded-lg border border-border bg-bg-elev p-4">
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={formatDate}
            tick={{ fill: "var(--text-subtle)", fontSize: 11 }}
            axisLine={{ stroke: "var(--border)" }}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis
            tickFormatter={formatTick}
            tick={{ fill: "var(--text-subtle)", fontSize: 11 }}
            axisLine={{ stroke: "var(--border)" }}
            tickLine={false}
            width={48}
          />
          <Tooltip
            contentStyle={{
              background: "var(--bg-elev)",
              border: "1px solid var(--border-strong)",
              borderRadius: 8,
              fontSize: 12,
              color: "var(--text)",
            }}
            labelStyle={{ color: "var(--text-muted)", marginBottom: 4 }}
            itemStyle={{ color: "var(--text)" }}
            formatter={(v) => formatTick(Number(v) || 0)}
          />
          <Legend
            wrapperStyle={{ fontSize: 11, color: "var(--text-muted)" }}
            iconType="circle"
          />
          {rankedSources.map((source, i) => (
            <Line
              key={source}
              type="monotone"
              dataKey={source}
              stroke={PALETTE[i % PALETTE.length]}
              strokeWidth={1.8}
              dot={false}
              activeDot={{ r: 3 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <div className="mt-4 grid gap-x-5 gap-y-2 border-t border-border pt-3 sm:grid-cols-2 xl:grid-cols-3">
        {rankedSources.map((source, i) => (
          <div key={source} className="min-w-0">
            <div className="mb-1 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: PALETTE[i % PALETTE.length] }}
                />
                <span className="truncate text-[12px] font-medium text-fg">{source}</span>
              </div>
              <span className="shrink-0 text-[11px] tabular-nums text-muted">
                {formatTick(sourceTotal(data, source))}
              </span>
            </div>
            <ResponsiveContainer width="100%" height={36}>
              <LineChart data={data} margin={{ top: 3, right: 2, left: 2, bottom: 3 }}>
                <XAxis dataKey="date" hide />
                <YAxis hide domain={[0, "dataMax"]} />
                <Line
                  type="monotone"
                  dataKey={source}
                  stroke={PALETTE[i % PALETTE.length]}
                  strokeWidth={1.6}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ))}
      </div>
    </div>
  );
}
