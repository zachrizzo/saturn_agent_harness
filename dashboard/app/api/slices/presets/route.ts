import { NextResponse } from "next/server";
import { listSlices, createSlice, type Slice } from "@/lib/slices";
import { DEFAULT_CLAUDE_ALIAS, DEFAULT_CHEAP_CLAUDE_ALIAS } from "@/lib/claude-models";

const MAIN_MODEL = DEFAULT_CLAUDE_ALIAS;
const CHEAP_MODEL = DEFAULT_CHEAP_CLAUDE_ALIAS;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  // Only seed if catalog is empty
  const existing = await listSlices();
  if (existing.length > 0) {
    return NextResponse.json({ seeded: false, message: "catalog not empty" });
  }

  const presets: Omit<Slice, "created_at" | "version">[] = [
    {
      id: "scope-bucketer",
      name: "Scope Bucketer",
      description:
        "Given a file list or diff, categorizes files into domains: frontend, backend, infra, tests, config.",
      cli: "claude-bedrock",
      model: CHEAP_MODEL,
      allowedTools: ["Read", "Bash(git diff:*)", "Bash(git log:*)"],
      capability: {
        mutation: "read-only",
        scope: ["repo"],
        output: { kind: "structured" },
        interactivity: "one-shot",
        cost_tier: "cheap",
      },
      prompt_template: {
        system: 'You are a file scope analyzer. Given the focus area, categorize changed files into domains. Return ONLY a fenced ```json block with: {"frontend": ["path"], "backend": ["path"], "infra": ["path"], "tests": ["path"], "config": ["path"], "other": ["path"]}. No explanations.',
        variables: ["focus"],
        required: ["focus"],
      },
      sandbox: { mode: "none", net: "deny" },
      budget: { max_tokens: 4000, timeout_seconds: 60 },
      io_schema: {
        output: {
          type: "object",
          properties: {
            frontend: { type: "array" },
            backend: { type: "array" },
            infra: { type: "array" },
            tests: { type: "array" },
            config: { type: "array" },
            other: { type: "array" },
          },
        },
      },
      tags: ["utility", "code-review"],
    },
    {
      id: "security-reviewer",
      name: "Security Reviewer",
      description: "Audits code for auth bypass, injection, secrets, CORS, SSRF, JWT issues.",
      cli: "claude-bedrock",
      model: MAIN_MODEL,
      allowedTools: ["Read", "Grep", "Glob", "Bash(git log:*)"],
      capability: {
        mutation: "read-only",
        scope: ["repo"],
        output: { kind: "structured" },
        interactivity: "one-shot",
        cost_tier: "premium",
      },
      prompt_template: {
        system: 'You are a security specialist. Focus: {{focus}}. Prior context: {{prior_context}}. Rubric: CRITICAL=RCE/auth-bypass/SQL-injection/secrets; HIGH=XSS/CSRF/SSRF/JWT-gaps; MEDIUM=permissive-CORS/missing-rate-limits; LOW=weak-hashing/missing-headers. Return ONLY a fenced ```findings.json``` block: [{"severity":"high","file":"src/auth.ts","line":42,"msg":"..."}]. Skip style nits.',
        variables: ["focus", "prior_context"],
        required: ["focus"],
      },
      sandbox: { mode: "none", net: "deny" },
      budget: { max_tokens: 8000, timeout_seconds: 180 },
      io_schema: {
        output: {
          type: "object",
          properties: {
            findings: {
              type: "array",
              items: {
                type: "object",
                required: ["severity", "file", "msg"],
                properties: {
                  severity: { enum: ["critical", "high", "medium", "low"] },
                  file: { type: "string" },
                  line: { type: "number" },
                  msg: { type: "string" },
                },
              },
            },
          },
        },
      },
      tags: ["security", "code-review"],
    },
    {
      id: "correctness-reviewer",
      name: "Correctness Reviewer",
      description: "Finds logic bugs, edge cases, race conditions, null dereferences.",
      cli: "claude-bedrock",
      model: MAIN_MODEL,
      allowedTools: ["Read", "Grep", "Glob"],
      capability: {
        mutation: "read-only",
        scope: ["repo"],
        output: { kind: "structured" },
        interactivity: "one-shot",
        cost_tier: "premium",
      },
      prompt_template: {
        system: 'You are a correctness reviewer. Focus: {{focus}}. Look for: logic bugs, off-by-one, null/undefined deref, race conditions, missing error handling, wrong assumptions. Return ONLY ```findings.json```: [{"severity":"high","file":"...","line":N,"msg":"..."}].',
        variables: ["focus", "prior_context"],
        required: ["focus"],
      },
      sandbox: { mode: "none", net: "deny" },
      budget: { max_tokens: 8000, timeout_seconds: 180 },
      io_schema: {
        output: { type: "object", properties: { findings: { type: "array" } } },
      },
      tags: ["correctness", "code-review"],
    },
    {
      id: "conventions-reviewer",
      name: "Conventions Reviewer",
      description: "Checks adherence to project conventions from CLAUDE.md / README.",
      cli: "claude-bedrock",
      model: "",
      allowedTools: ["Read", "Grep", "Glob"],
      capability: {
        mutation: "read-only",
        scope: ["repo"],
        output: { kind: "structured" },
        interactivity: "one-shot",
        cost_tier: "free",
      },
      prompt_template: {
        system: 'You are a conventions checker. Focus: {{focus}}. Read CLAUDE.md (or README if missing) first to understand project conventions. Return ONLY ```findings.json```: [{"severity":"low","file":"...","line":N,"msg":"violates convention: ..."}]. Skip anything that isn\'t a clear convention violation.',
        variables: ["focus"],
        required: ["focus"],
      },
      sandbox: { mode: "none", net: "deny" },
      budget: { max_tokens: 4000, timeout_seconds: 120 },
      io_schema: {
        output: { type: "object", properties: { findings: { type: "array" } } },
      },
      tags: ["conventions", "code-review"],
    },
    {
      id: "performance-reviewer",
      name: "Performance Reviewer",
      description: "Finds N+1 queries, blocking I/O, memory leaks, unnecessary re-renders.",
      cli: "claude-bedrock",
      model: CHEAP_MODEL,
      allowedTools: ["Read", "Grep", "Glob"],
      capability: {
        mutation: "read-only",
        scope: ["repo"],
        output: { kind: "structured" },
        interactivity: "one-shot",
        cost_tier: "cheap",
      },
      prompt_template: {
        system: 'You are a performance specialist. Focus: {{focus}}. Find: N+1 queries, blocking event-loop calls, large allocations, unnecessary re-renders, missing indices. Return ONLY ```findings.json```: [{"severity":"medium","file":"...","line":N,"msg":"..."}].',
        variables: ["focus"],
        required: ["focus"],
      },
      sandbox: { mode: "none", net: "deny" },
      budget: { max_tokens: 5000, timeout_seconds: 120 },
      io_schema: {
        output: { type: "object", properties: { findings: { type: "array" } } },
      },
      tags: ["performance", "code-review"],
    },
    {
      id: "test-reviewer",
      name: "Test Reviewer",
      description: "Checks test coverage, mock vs reality, missing edge cases.",
      cli: "claude-bedrock",
      model: CHEAP_MODEL,
      allowedTools: ["Read", "Grep", "Glob"],
      capability: {
        mutation: "read-only",
        scope: ["repo"],
        output: { kind: "structured" },
        interactivity: "one-shot",
        cost_tier: "cheap",
      },
      prompt_template: {
        system: 'You are a test quality reviewer. Focus: {{focus}}. Check: are critical paths tested, are mocks realistic, are edge cases covered, are assertions meaningful. Return ONLY ```findings.json```: [{"severity":"medium","file":"...","line":N,"msg":"..."}].',
        variables: ["focus"],
        required: ["focus"],
      },
      sandbox: { mode: "none", net: "deny" },
      budget: { max_tokens: 5000, timeout_seconds: 120 },
      io_schema: {
        output: { type: "object", properties: { findings: { type: "array" } } },
      },
      tags: ["testing", "code-review"],
    },
    {
      id: "web-searcher",
      name: "Web Searcher",
      description: "Searches the internet for information, documentation, or context.",
      cli: "claude-bedrock",
      model: MAIN_MODEL,
      allowedTools: ["WebSearch", "WebFetch"],
      capability: {
        mutation: "read-only",
        scope: ["internet"],
        output: { kind: "markdown" },
        interactivity: "one-shot",
        cost_tier: "premium",
      },
      prompt_template: {
        system: "You are a research specialist. Focus: {{focus}}. Search for relevant information and return a concise markdown summary with sources. Include URLs for every key claim.",
        variables: ["focus"],
        required: ["focus"],
      },
      sandbox: { mode: "none", net: "allow" },
      budget: { max_tokens: 8000, timeout_seconds: 180 },
      tags: ["research", "web"],
    },
    {
      id: "code-reader",
      name: "Code Reader",
      description: "Reads and summarizes code structure, APIs, or logic flows.",
      cli: "claude-bedrock",
      model: MAIN_MODEL,
      allowedTools: ["Read", "Grep", "Glob", "Bash(find:*)", "Bash(git log:*)"],
      capability: {
        mutation: "read-only",
        scope: ["repo"],
        output: { kind: "markdown" },
        interactivity: "one-shot",
        cost_tier: "premium",
      },
      prompt_template: {
        system: "You are a code analysis specialist. Focus: {{focus}}. Read the relevant files, trace execution paths, and produce a clear markdown summary of what the code does, its interfaces, and any gotchas.",
        variables: ["focus"],
        required: ["focus"],
      },
      sandbox: { mode: "none", net: "deny" },
      budget: { max_tokens: 10000, timeout_seconds: 240 },
      tags: ["analysis"],
    },
    {
      id: "code-writer-typescript",
      name: "TypeScript Code Writer",
      description: "Writes or edits TypeScript/TSX files. Returns unified diff.",
      cli: "claude-bedrock",
      model: MAIN_MODEL,
      allowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash(git diff:*)"],
      capability: {
        mutation: "writes-source",
        scope: ["repo"],
        output: { kind: "code-patch" },
        interactivity: "multi-turn",
        cost_tier: "premium",
      },
      prompt_template: {
        system: "You are a TypeScript specialist. Task: {{focus}}. Context: {{prior_context}}. Implement the requested change. After editing, return a concise summary of what you changed and why.",
        variables: ["focus", "prior_context"],
        required: ["focus"],
      },
      sandbox: { mode: "worktree", net: "deny" },
      budget: { max_tokens: 20000, timeout_seconds: 300 },
      tags: ["implementation", "typescript"],
    },
    {
      id: "supply-chain-reviewer",
      name: "Supply Chain Reviewer",
      description: "Audits package.json for vulnerable deps, postinstall scripts, abandoned packages.",
      cli: "codex",
      model: "",
      allowedTools: ["Read", "Bash(pnpm audit:*)", "Bash(npm audit:*)", "Bash(find:*)"],
      capability: {
        mutation: "read-only",
        scope: ["repo"],
        output: { kind: "structured" },
        interactivity: "one-shot",
        cost_tier: "cheap",
      },
      prompt_template: {
        system: 'You are a supply chain security specialist. Focus: {{focus}}. Run `pnpm audit --prod` or `npm audit --omit=dev`. Also grep package.json files for postinstall/preinstall scripts and known-bad packages (request, node-uuid, event-stream). Return ONLY ```findings.json```: [{"severity":"high","file":"package.json","line":null,"msg":"..."}]. Only report critical/high CVEs and obvious supply chain risks.',
        variables: ["focus"],
        required: ["focus"],
      },
      sandbox: { mode: "none", net: "deny" },
      budget: { max_tokens: 4000, timeout_seconds: 120 },
      io_schema: {
        output: { type: "object", properties: { findings: { type: "array" } } },
      },
      tags: ["security", "supply-chain", "code-review"],
    },
  ];

  for (const preset of presets) {
    await createSlice(preset);
  }

  return NextResponse.json({ seeded: true, count: presets.length });
}
