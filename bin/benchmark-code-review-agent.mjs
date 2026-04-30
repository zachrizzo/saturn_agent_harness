#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const baseUrl = process.env.SATURN_BASE_URL ?? "http://127.0.0.1:3737";
const agentId = process.env.CODE_REVIEW_AGENT_ID ?? "active-code-review-agent";
const benchmarkCase = process.env.CODE_REVIEW_BENCHMARK_CASE ?? process.argv[2] ?? "seeded";
const timeoutMs = Number(process.env.CODE_REVIEW_BENCHMARK_TIMEOUT_MS ?? 20 * 60 * 1000);
const pollIntervalMs = Number(process.env.CODE_REVIEW_BENCHMARK_POLL_MS ?? 5000);

const expectedFindings = [
  {
    id: "command-injection",
    severity: "critical",
    patterns: [/command injection/i, /\bexec\b/i, /printerName/i, /invoiceId.*pdf/i],
  },
  {
    id: "path-traversal",
    severity: "high",
    patterns: [/path traversal|arbitrary file read/i, /attachment|INVOICE_DIR|path\.join/i],
  },
  {
    id: "broken-authorization",
    severity: "high",
    patterns: [/authorization|access control|IDOR|non-admin|member/i, /owner|everyone else|any invoice/i],
  },
  {
    id: "hardcoded-secret-and-logging",
    severity: "high",
    patterns: [/hardcoded secret|secret/i, /REPORT_SECRET|sk_live/i, /console\.log|log/i],
  },
  {
    id: "negative-total",
    severity: "medium",
    patterns: [/negative|below zero|clamp|invalid/i, /WELCOME10|coupon/i, /subtotal|total/i],
  },
  {
    id: "unvalidated-quantities",
    severity: "medium",
    patterns: [/quantit(?:y|ies)|unitCents|line item|number inputs/i, /validate|negative|NaN|integer|fractional|finite/i],
  },
  {
    id: "sequential-n-plus-one",
    severity: "medium",
    patterns: [/sequential|N\+1|parallel|bounded concurrency|batch/i, /loadInvoice|loadCustomerName|customer lookup|invoice lookup|renderInvoiceSummaries/i],
  },
  {
    id: "missing-tests",
    severity: "medium",
    patterns: [/missing tests|test coverage|happy path|only covers one|coverage is not adequate|weak/i, /authorization|path traversal|coupon|negative|security/i],
  },
];

const benchmarkCases = {
  seeded: {
    targetPath: path.join(repoRoot, "benchmarks/code-review-agent/fixture"),
    expectedFindings,
    minimumFinalScore: expectedFindings.length,
    minimumCombinedScore: expectedFindings.length,
    clean: false,
  },
  clean: {
    targetPath: path.join(repoRoot, "benchmarks/code-review-agent/clean-fixture"),
    expectedFindings: [],
    minimumFinalScore: 0,
    minimumCombinedScore: 0,
    clean: true,
  },
};

const selectedCase = benchmarkCases[benchmarkCase];
if (!selectedCase) {
  throw new Error(`Unknown CODE_REVIEW_BENCHMARK_CASE: ${benchmarkCase}`);
}
const { targetPath } = selectedCase;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(pathname, options) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${options?.method ?? "GET"} ${pathname} failed ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function readGraphRunText(sessionId) {
  const root = process.env.AUTOMATIONS_ROOT ?? repoRoot;
  const graphDir = path.join(root, "sessions", sessionId, "graph-runs");
  const names = await fs.readdir(graphDir).catch(() => []);
  const chunks = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const raw = await fs.readFile(path.join(graphDir, name), "utf8").catch(() => "");
    if (!raw) continue;
    chunks.push(raw);
    try {
      const parsed = JSON.parse(raw);
      for (const run of parsed.runs ?? []) {
        const output = run?.result?.output;
        if (typeof output === "string") chunks.push(output);
      }
    } catch {
      // Keep the raw graph-run text above.
    }
  }
  return chunks.join("\n\n");
}

async function readSliceRunText(sessionId) {
  const root = process.env.AUTOMATIONS_ROOT ?? repoRoot;
  const sliceDir = path.join(root, "sessions", sessionId, "slices");
  const names = await fs.readdir(sliceDir).catch(() => []);
  const chunks = [];
  for (const name of names) {
    const raw = await fs.readFile(path.join(sliceDir, name, "output.raw.txt"), "utf8").catch(() => "");
    if (raw) chunks.push(raw);
  }
  return chunks.join("\n\n");
}

function scoreText(text, findings = expectedFindings) {
  const found = [];
  const missed = [];
  for (const expected of findings) {
    const matched = expected.patterns.every((pattern) => pattern.test(text));
    (matched ? found : missed).push(expected);
  }
  return {
    score: found.length,
    total: findings.length,
    found,
    missed,
  };
}

function scoreCleanText(text) {
  const actionableFindingMarker =
    /(^|\n)\s*(?:\d+[.)]\s*|[-*]\s*)?(?:\*\*)?(?:\[[Pp][0-3]\]|[Pp][0-3]\s+[—-]|Severity[`*\s:]+P[0-3])/;
  return {
    saysNoActionableFindings: /no actionable findings|no findings|no issues/i.test(text),
    actionableFindingMarkers: (text.match(new RegExp(actionableFindingMarker.source, "gm")) ?? []).length,
  };
}

function formatScore(label, score) {
  const foundIds = score.found.map((finding) => finding.id).join(", ") || "none";
  const missedIds = score.missed.map((finding) => finding.id).join(", ") || "none";
  return [
    `${label}: ${score.score}/${score.total}`,
    `  found: ${foundIds}`,
    `  missed: ${missedIds}`,
  ].join("\n");
}

async function waitForSession(sessionId) {
  const deadline = Date.now() + timeoutMs;
  let session;
  while (Date.now() < deadline) {
    session = await fetchJson(`/api/sessions/${sessionId}`);
    const status = session?.meta?.status;
    const turnStatus = session?.meta?.turns?.at(-1)?.status;
    process.stderr.write(`benchmark poll: session=${status ?? "unknown"} turn=${turnStatus ?? "unknown"}\n`);
    if (status !== "running" && turnStatus !== "running") return session;
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for session ${sessionId} after ${Math.round(timeoutMs / 1000)}s`);
}

async function main() {
  await fs.access(targetPath);
  const message = [
    "Benchmark the active code review workflow end to end.",
    "",
    `Review only this target path: ${targetPath}`,
    "Use the saved slice graph through the orchestrator tools before synthesizing the final answer.",
    "Do not inspect the benchmark runner, README, expected criteria, git history, or files outside the target path unless a dependency imported by the target file is required.",
    "Only report code-evidenced, actionable findings. If there are no actionable findings, say so plainly instead of inventing risks.",
    "",
    "Return findings first, sorted by severity. Each finding must include file, line, risk, and fix.",
  ].join("\n");

  const created = await fetchJson("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      agent_id: agentId,
      message,
      cli: "codex",
      reasoningEffort: "high",
      overrides: {
        budget: {
          max_total_tokens: 1200000,
          max_wallclock_seconds: 1200,
          max_slice_calls: 20,
          max_recursion_depth: 3,
        },
      },
    }),
  });

  const sessionId = created.session_id;
  const session = await waitForSession(sessionId);
  const finalText = session?.meta?.turns?.at(-1)?.final_text ?? "";
  const graphText = await readGraphRunText(sessionId);
  const sliceText = await readSliceRunText(sessionId);
  const finalScore = scoreText(finalText, selectedCase.expectedFindings);
  const combinedScore = scoreText(`${finalText}\n\n${graphText}\n\n${sliceText}`, selectedCase.expectedFindings);
  const cleanScore = selectedCase.clean ? scoreCleanText(finalText) : null;

  const report = {
    agent_id: agentId,
    benchmark_case: benchmarkCase,
    session_id: sessionId,
    status: session?.meta?.status,
    turn_status: session?.meta?.turns?.at(-1)?.status,
    target_path: targetPath,
    final_score: {
      score: finalScore.score,
      total: finalScore.total,
      found: finalScore.found.map((finding) => finding.id),
      missed: finalScore.missed.map((finding) => finding.id),
    },
    combined_score: {
      score: combinedScore.score,
      total: combinedScore.total,
      found: combinedScore.found.map((finding) => finding.id),
      missed: combinedScore.missed.map((finding) => finding.id),
    },
    clean_score: cleanScore,
  };

  console.log(JSON.stringify(report, null, 2));
  console.log("");
  console.log(formatScore("Final answer", finalScore));
  console.log(formatScore("Final + graph outputs", combinedScore));

  if (selectedCase.clean) {
    if (!cleanScore?.saysNoActionableFindings || cleanScore.actionableFindingMarkers > 0) {
      process.exitCode = 1;
    }
  } else if (
    finalScore.score < selectedCase.minimumFinalScore ||
    combinedScore.score < selectedCase.minimumCombinedScore
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
