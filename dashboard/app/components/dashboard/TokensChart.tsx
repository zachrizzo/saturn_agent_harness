"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
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

export function TokensChart({ data, sources }: Props) {
  if (sources.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-bg-elev p-8 text-center text-sm text-muted">
        No token usage yet. Tokens will appear here once jobs or chats run.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-bg-elev p-4">
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            {sources.map((source, i) => (
              <linearGradient key={source} id={`fill-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={PALETTE[i % PALETTE.length]} stopOpacity={0.4} />
                <stop offset="100%" stopColor={PALETTE[i % PALETTE.length]} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
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
          {sources.map((source, i) => (
            <Area
              key={source}
              type="monotone"
              dataKey={source}
              stackId="1"
              stroke={PALETTE[i % PALETTE.length]}
              strokeWidth={1.5}
              fill={`url(#fill-${i})`}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
