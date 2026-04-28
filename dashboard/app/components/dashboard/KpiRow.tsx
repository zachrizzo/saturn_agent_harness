type Tone = "default" | "success" | "warn" | "fail";

type Item = {
  label: string;
  value: string;
  tone?: Tone;
  delta?: string;
};

type Props = {
  runningNow: number;
  successRate: number; // 0-100
  runs24h: number;
  failingJobs: number;
  totalJobs: number;
  tokens: string; // pre-formatted ("2.1M")
  tokensDelta?: string;
};

const TONE_CLASS: Record<Tone, string> = {
  default: "",
  success: "kpi-success",
  warn: "kpi-warn",
  fail: "kpi-fail",
};

export function KpiRow({
  runningNow,
  successRate,
  runs24h,
  failingJobs,
  totalJobs,
  tokens,
  tokensDelta,
}: Props) {
  let successTone: Tone = "default";
  if (runs24h > 0) {
    if (successRate >= 90) successTone = "success";
    else if (successRate >= 70) successTone = "warn";
    else successTone = "fail";
  }

  const items: Item[] = [
    {
      label: "Running now",
      value: String(runningNow),
      tone: runningNow > 0 ? "warn" : "default",
      delta: runningNow > 0 ? "live" : "idle",
    },
    {
      label: "Success (24h)",
      value: runs24h > 0 ? `${successRate}%` : "—",
      tone: successTone,
      delta: `${runs24h} runs`,
    },
    {
      label: "Failing jobs",
      value: String(failingJobs),
      tone: failingJobs > 0 ? "fail" : "success",
      delta: `of ${totalJobs} active`,
    },
    {
      label: "Tokens (24h)",
      value: tokens,
      delta: tokensDelta ?? "—",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-[10px]">
      {items.map((it) => (
        <div key={it.label} className={`kpi ${TONE_CLASS[it.tone ?? "default"]}`}>
          <span className="accent-line" />
          <div className="kpi-label">{it.label}</div>
          <div className="kpi-value">{it.value}</div>
          <div className="kpi-delta">{it.delta}</div>
        </div>
      ))}
    </div>
  );
}
