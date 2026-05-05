"use client";

import ReactMarkdown from "react-markdown";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Tone = "default" | "success" | "warn" | "fail" | "accent";
type ChartType = "bar" | "line" | "area";

type UiMetric = {
  label?: unknown;
  value?: unknown;
  delta?: unknown;
  tone?: unknown;
};

type UiLink = {
  label?: unknown;
  href?: unknown;
  description?: unknown;
};

type UiTable = {
  title?: unknown;
  columns?: unknown;
  rows?: unknown;
};

type UiSection = {
  title?: unknown;
  body?: unknown;
  items?: unknown;
};

type UiChartSeries = {
  key?: unknown;
  label?: unknown;
  color?: unknown;
  tone?: unknown;
};

type UiChart = {
  title?: unknown;
  type?: unknown;
  xKey?: unknown;
  series?: unknown;
  data?: unknown;
};

type GeneratedUiPayload = {
  title?: unknown;
  summary?: unknown;
  metrics?: unknown;
  links?: unknown;
  charts?: unknown;
  tables?: unknown;
  sections?: unknown;
};

type ParsedOutput = {
  markdown: string;
  payloads: GeneratedUiPayload[];
};

const UI_BLOCK_RE = /```(?:saturn-ui|saturn-ui\s+json)\s*\n([\s\S]*?)```/gi;
const MAX_CELL_CHARS = 700;
const MAX_ROWS = 50;
const MAX_COLUMNS = 8;
const MAX_CHART_POINTS = 80;
const MAX_CHART_SERIES = 4;

const PALETTE = {
  default: "#64748b",
  accent: "#3b82f6",
  success: "#22c55e",
  warn: "#f59e0b",
  fail: "#ef4444",
};

const CHART_COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444"];

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function tone(value: unknown): Tone {
  return value === "success" || value === "warn" || value === "fail" || value === "accent"
    ? value
    : "default";
}

function chartType(value: unknown): ChartType {
  return value === "line" || value === "area" ? value : "bar";
}

function truncate(value: unknown): string {
  const raw = text(value);
  return raw.length > MAX_CELL_CHARS ? `${raw.slice(0, MAX_CELL_CHARS - 1)}...` : raw;
}

function safeHref(value: unknown): string {
  const raw = text(value).trim();
  if (!raw) return "";
  if (raw.startsWith("/") || raw.startsWith("#")) return raw;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function safeColor(value: unknown, fallback: string): string {
  const raw = text(value).trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  return fallback;
}

function parseOutput(markdown: string): ParsedOutput {
  const payloads: GeneratedUiPayload[] = [];
  const cleaned = markdown.replace(UI_BLOCK_RE, (match, rawJson: string) => {
    try {
      const parsed = JSON.parse(rawJson) as GeneratedUiPayload;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payloads.push(parsed);
    } catch {
      return match;
    }
    return "";
  }).trim();
  return { markdown: cleaned, payloads };
}

function normalizeColumns(table: UiTable): Array<{ key: string; label: string }> {
  const columns = Array.isArray(table.columns) ? table.columns : [];
  return columns
    .map((column, index) => {
      if (typeof column === "string") return { key: column, label: column };
      if (column && typeof column === "object") {
        const record = column as Record<string, unknown>;
        const key = text(record.key || record.id || record.label).trim();
        return key ? { key, label: text(record.label || key) || key } : null;
      }
      return { key: `col_${index + 1}`, label: `Column ${index + 1}` };
    })
    .filter((column): column is { key: string; label: string } => Boolean(column))
    .slice(0, MAX_COLUMNS);
}

function normalizeRows(table: UiTable): Array<Record<string, unknown>> {
  return (Array.isArray(table.rows) ? table.rows : [])
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    .slice(0, MAX_ROWS);
}

function normalizeChartData(chart: UiChart): Array<Record<string, string | number>> {
  return (Array.isArray(chart.data) ? chart.data : [])
    .filter((point): point is Record<string, unknown> => Boolean(point) && typeof point === "object" && !Array.isArray(point))
    .slice(0, MAX_CHART_POINTS)
    .map((point) => {
      const next: Record<string, string | number> = {};
      for (const [key, value] of Object.entries(point)) {
        if (typeof value === "number" && Number.isFinite(value)) next[key] = value;
        else if (typeof value === "string" || typeof value === "boolean") next[key] = String(value);
      }
      return next;
    });
}

function normalizeSeries(chart: UiChart): Array<{ key: string; label: string; color: string }> {
  const series = Array.isArray(chart.series) ? chart.series : [];
  return series
    .map((entry, index) => {
      if (typeof entry === "string") {
        return { key: entry, label: entry, color: CHART_COLORS[index % CHART_COLORS.length] };
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const raw = entry as UiChartSeries;
      const key = text(raw.key).trim();
      if (!key) return null;
      const fallback = PALETTE[tone(raw.tone)] || CHART_COLORS[index % CHART_COLORS.length];
      return {
        key,
        label: text(raw.label) || key,
        color: safeColor(raw.color, fallback),
      };
    })
    .filter((entry): entry is { key: string; label: string; color: string } => Boolean(entry))
    .slice(0, MAX_CHART_SERIES);
}

function GeneratedChart({ chart }: { chart: UiChart }) {
  const data = normalizeChartData(chart);
  const series = normalizeSeries(chart);
  const xKey = text(chart.xKey).trim();
  const type = chartType(chart.type);
  if (!xKey || data.length === 0 || series.length === 0) return null;

  const common = (
    <>
      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
      <XAxis
        dataKey={xKey}
        tick={{ fill: "var(--text-subtle)", fontSize: 11 }}
        axisLine={{ stroke: "var(--border)" }}
        tickLine={false}
        minTickGap={18}
      />
      <YAxis
        tick={{ fill: "var(--text-subtle)", fontSize: 11 }}
        axisLine={{ stroke: "var(--border)" }}
        tickLine={false}
        width={42}
      />
      <Tooltip
        contentStyle={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border-strong)",
          borderRadius: 8,
          color: "var(--text)",
          fontSize: 12,
        }}
      />
    </>
  );

  return (
    <section className="generated-ui-chart-wrap">
      {text(chart.title) && <h4>{text(chart.title)}</h4>}
      <div className="generated-ui-chart">
        <ResponsiveContainer width="100%" height={220}>
          {type === "line" ? (
            <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              {common}
              {series.map((item) => (
                <Line key={item.key} type="monotone" dataKey={item.key} name={item.label} stroke={item.color} strokeWidth={2} dot={false} />
              ))}
            </LineChart>
          ) : type === "area" ? (
            <AreaChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              {common}
              {series.map((item) => (
                <Area key={item.key} type="monotone" dataKey={item.key} name={item.label} stroke={item.color} fill={item.color} fillOpacity={0.18} />
              ))}
            </AreaChart>
          ) : (
            <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              {common}
              {series.map((item) => (
                <Bar key={item.key} dataKey={item.key} name={item.label} fill={item.color} radius={[4, 4, 0, 0]} />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function GeneratedUi({ payload }: { payload: GeneratedUiPayload }) {
  const metrics = (Array.isArray(payload.metrics) ? payload.metrics : []) as UiMetric[];
  const links = (Array.isArray(payload.links) ? payload.links : []) as UiLink[];
  const charts = (Array.isArray(payload.charts) ? payload.charts : []) as UiChart[];
  const tables = (Array.isArray(payload.tables) ? payload.tables : []) as UiTable[];
  const sections = (Array.isArray(payload.sections) ? payload.sections : []) as UiSection[];

  return (
    <section className="generated-ui">
      {(text(payload.title) || text(payload.summary)) && (
        <div className="generated-ui-head">
          {text(payload.title) && <h3>{text(payload.title)}</h3>}
          {text(payload.summary) && <p>{text(payload.summary)}</p>}
        </div>
      )}

      {metrics.length > 0 && (
        <div className="generated-ui-metrics">
          {metrics.map((metric, index) => (
            <div key={`${text(metric.label)}-${index}`} className={`generated-ui-metric generated-ui-tone-${tone(metric.tone)}`}>
              <span>{text(metric.label) || "Metric"}</span>
              <strong>{text(metric.value) || "-"}</strong>
              {text(metric.delta) && <small>{text(metric.delta)}</small>}
            </div>
          ))}
        </div>
      )}

      {charts.map((chart, index) => <GeneratedChart key={`${text(chart.title)}-${index}`} chart={chart} />)}

      {links.length > 0 && (
        <div className="generated-ui-links">
          {links.map((link, index) => {
            const href = safeHref(link.href);
            if (!href) return null;
            return (
              <a key={`${href}-${index}`} href={href} className="generated-ui-link">
                <span>{text(link.label) || href}</span>
                {text(link.description) && <small>{text(link.description)}</small>}
              </a>
            );
          })}
        </div>
      )}

      {sections.map((section, index) => (
        <section key={`${text(section.title)}-${index}`} className="generated-ui-section">
          {text(section.title) && <h4>{text(section.title)}</h4>}
          {text(section.body) && <p>{text(section.body)}</p>}
          {Array.isArray(section.items) && section.items.length > 0 && (
            <ul>
              {section.items.slice(0, 30).map((item, itemIndex) => (
                <li key={itemIndex}>{truncate(item)}</li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {tables.map((table, index) => {
        const columns = normalizeColumns(table);
        const rows = normalizeRows(table);
        if (columns.length === 0 || rows.length === 0) return null;
        return (
          <section key={`${text(table.title)}-${index}`} className="generated-ui-table-wrap">
            {text(table.title) && <h4>{text(table.title)}</h4>}
            <div className="generated-ui-table-scroll">
              <table className="generated-ui-table">
                <thead>
                  <tr>
                    {columns.map((column) => <th key={column.key}>{column.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {columns.map((column) => <td key={column.key}>{truncate(row[column.key])}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </section>
  );
}

export function GeneratedOutputView({ markdown }: { markdown: string }) {
  const parsed = parseOutput(markdown);
  return (
    <div className="generated-output-view">
      {parsed.payloads.map((payload, index) => <GeneratedUi key={index} payload={payload} />)}
      {parsed.markdown && (
        <article className="prose-dashboard text-sm leading-relaxed">
          <ReactMarkdown>{parsed.markdown}</ReactMarkdown>
        </article>
      )}
    </div>
  );
}
