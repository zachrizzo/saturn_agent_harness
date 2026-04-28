import { NextResponse } from "next/server";
import { listAgents, createAgent, type Agent } from "@/lib/runs";
import { DEFAULT_CLAUDE_ALIAS } from "@/lib/claude-models";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const existing = await listAgents();
  if (existing.some((a) => a.kind === "orchestrator")) {
    return NextResponse.json({ seeded: false, message: "orchestrators already exist" });
  }

  const orchestrators: Omit<Agent, "created_at">[] = [
    {
      id: "code-review-swarm",
      name: "Code Review Swarm",
      description: "Parallel code review: security, correctness, performance, conventions, supply chain.",
      kind: "orchestrator",
      cli: "claude-bedrock",
      model: DEFAULT_CLAUDE_ALIAS,
      prompt: `You are a code review orchestrator. Your job is to review code changes thoroughly using your specialist slice tools.

STRATEGY:
1. Call list_slices to see available specialists.
2. Call get_budget to check your budget.
3. Call dispatch_slice("scope-bucketer", { focus: "categorize the changed files in this diff: <diff summary>" }) to understand scope.
4. Based on scope, dispatch relevant reviewers IN PARALLEL (multiple dispatch_slice calls in one response):
   - Always: security-reviewer, correctness-reviewer
   - If TypeScript/JS: conventions-reviewer
   - If has package.json changes: supply-chain-reviewer
   - If performance-critical paths: performance-reviewer
   - If has test files: test-reviewer
5. Pass focus as the file list for each domain (e.g., "Review these backend files: src/api/auth.ts, src/middleware/jwt.ts").
6. When all slices return, synthesize a single markdown report:
   - Group findings by severity: Critical → High → Medium → Low
   - Deduplicate findings at the same file:line
   - Add a "## Needs Attention" section for critical/high findings
   - End with a one-line summary: "N critical, M high, P medium, Q low findings across X slices."
7. Call stop("review complete") when done.

If a slice returns budget_exceeded, synthesize with what you have and note incomplete coverage.
If a slice fails, note it in the report and continue.`,
      slices_available: [
        "scope-bucketer",
        "security-reviewer",
        "correctness-reviewer",
        "conventions-reviewer",
        "performance-reviewer",
        "test-reviewer",
        "supply-chain-reviewer",
      ],
      can_create_custom_slices: false,
      allowed_mutations: ["read-only"],
      budget: {
        max_total_tokens: 300000,
        max_wallclock_seconds: 900,
        max_slice_calls: 15,
        max_recursion_depth: 1,
      },
      on_budget_exceeded: "report-partial",
      on_slice_failure: "continue",
      allowedTools: [],
      tags: ["code-review"],
      timeout_seconds: 1200,
    },
    {
      id: "research-deep-dive",
      name: "Research Deep Dive",
      description: "Multi-source research swarm: web search + code reading + synthesis.",
      kind: "orchestrator",
      cli: "claude-bedrock",
      model: DEFAULT_CLAUDE_ALIAS,
      prompt: `You are a research orchestrator. Given a research question, gather information from multiple sources in parallel and synthesize a comprehensive report.

STRATEGY:
1. Call list_slices to see available research tools.
2. Decompose the question into 2-4 parallel research tasks.
3. Dispatch in PARALLEL:
   - web-searcher for online sources, documentation, recent developments
   - code-reader if the question relates to code in the current repo
4. Synthesize all findings into a structured markdown report with:
   - Executive summary (3-5 sentences)
   - Key findings (bulleted)
   - Sources and evidence
   - Gaps and uncertainties
   - Recommendations
5. Call stop("research complete").`,
      slices_available: ["web-searcher", "code-reader"],
      can_create_custom_slices: true,
      allowed_mutations: ["read-only"],
      budget: {
        max_total_tokens: 200000,
        max_wallclock_seconds: 600,
        max_slice_calls: 10,
        max_recursion_depth: 1,
      },
      on_budget_exceeded: "report-partial",
      on_slice_failure: "continue",
      allowedTools: [],
      tags: ["research"],
      timeout_seconds: 900,
    },
    {
      id: "feature-implementer",
      name: "Feature Implementer",
      description: "Plans and implements features using code-reader + code-writer + security review.",
      kind: "orchestrator",
      cli: "claude-bedrock",
      model: DEFAULT_CLAUDE_ALIAS,
      prompt: `You are a feature implementation orchestrator. Given a feature request, plan and implement it carefully.

STRATEGY:
1. Call list_slices and get_budget.
2. Call dispatch_slice("code-reader", { focus: "understand the current codebase structure relevant to: <feature>" }) to understand context.
3. Plan the implementation: identify files to create/modify, interfaces to add.
4. For each independent change, dispatch dispatch_slice("code-writer-typescript", { focus: "<specific change>", prior_context: "<relevant context from code-reader>" }).
   - Changes that are independent of each other can be dispatched IN PARALLEL.
   - Changes that depend on earlier changes must be dispatched SERIALLY.
5. After each code-writer slice completes, dispatch dispatch_slice("security-reviewer", { focus: "review these changes for security issues: <summary of changes>" }) if the changes touch auth/crypto/input-handling.
6. Summarize all changes made, files touched, and any remaining TODOs.
7. Call stop("implementation complete").

IMPORTANT: code-writer-typescript uses worktree sandbox — changes are isolated. The user must apply them manually via the UI.`,
      slices_available: [
        "code-reader",
        "code-writer-typescript",
        "security-reviewer",
        "correctness-reviewer",
      ],
      can_create_custom_slices: false,
      allowed_mutations: ["read-only", "writes-source"],
      budget: {
        max_total_tokens: 500000,
        max_wallclock_seconds: 1800,
        max_slice_calls: 30,
        max_recursion_depth: 2,
      },
      on_budget_exceeded: "report-partial",
      on_slice_failure: "abort",
      allowedTools: [],
      tags: ["implementation"],
      timeout_seconds: 2400,
    },
  ];

  for (const orch of orchestrators) {
    await createAgent(orch);
  }

  return NextResponse.json({ seeded: true, count: orchestrators.length });
}
