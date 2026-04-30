import { NextResponse } from "next/server";
import { MEMORY_TYPES, normalizeProjectScope, type MemoryType } from "@/lib/memory";

export type MemoryScopeFilter = "all" | "global" | "project";

const MEMORY_SCOPES = ["all", "global", "project"] as const;

export type MemoryFilters = {
  scope?: MemoryScopeFilter;
  cwd?: string;
  projectScope?: ReturnType<typeof normalizeProjectScope>;
  type?: MemoryType;
  tag?: string;
  limit?: number;
};

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function serverError(err: unknown, fallback = "failed") {
  const message = err instanceof Error ? err.message : fallback;
  return NextResponse.json({ error: message }, { status: 500 });
}

export function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function cleanStringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : undefined;
  if (!values) return undefined;

  return [...new Set(values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
}

export function parseMemoryType(value: unknown): MemoryType | undefined {
  const type = cleanString(value);
  return type && (MEMORY_TYPES as readonly string[]).includes(type) ? type as MemoryType : undefined;
}

export function parseLimit(value: unknown, fallback?: number): number | undefined {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = typeof value === "string" ? value.trim() : value;
  const limit = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return undefined;
  return limit;
}

export function parseScopeFilter(value: unknown): MemoryScopeFilter | undefined {
  if (value === undefined || value === null || value === "") return "all";
  return typeof value === "string" && MEMORY_SCOPES.includes(value as MemoryScopeFilter)
    ? value as MemoryScopeFilter
    : undefined;
}

export function projectScopeForCwd(cwd: string): ReturnType<typeof normalizeProjectScope> {
  return normalizeProjectScope(cwd);
}

export function parseQueryFilters(params: URLSearchParams): MemoryFilters | { error: string } {
  const scope = parseScopeFilter(params.get("scope") ?? undefined);
  if (!scope) return { error: "scope must be one of all, global, or project" };

  const cwd = cleanString(params.get("cwd"));
  if (scope === "project" && !cwd) return { error: "cwd is required for project scope" };

  const limit = parseLimit(params.get("limit") ?? undefined);
  if ((params.has("limit") || params.get("limit")) && limit === undefined) {
    return { error: "limit must be an integer from 1 to 100" };
  }

  const type = parseMemoryType(params.get("type"));
  if (params.has("type") && params.get("type") && !type) {
    return { error: "type must be one of Entities, Concepts, Projects, Decisions, Troubleshooting, or Sessions" };
  }
  const tag = cleanString(params.get("tag"));
  return {
    scope,
    ...(cwd ? { cwd, projectScope: projectScopeForCwd(cwd) } : {}),
    ...(type ? { type } : {}),
    ...(tag ? { tag } : {}),
    ...(limit ? { limit } : {}),
  };
}

export function parseBodyScope(body: Record<string, unknown>): MemoryFilters | { error: string } {
  const hasScope = Object.prototype.hasOwnProperty.call(body, "scope");
  const hasCwd = Object.prototype.hasOwnProperty.call(body, "cwd");
  const rawScope = cleanString(body.scope);
  const cwd = cleanString(body.cwd);

  if (hasScope && !rawScope) return { error: "scope must be global, project, or a cwd string" };
  if (hasCwd && !cwd) return { error: "cwd must be a non-empty string" };
  if (!rawScope && !cwd) return {};
  if (rawScope === "all") return { error: "scope cannot be all when writing memory" };
  if (rawScope === "global") return { scope: "global", cwd: undefined, projectScope: undefined };

  const projectCwd = rawScope && rawScope !== "project" ? rawScope : cwd;
  if (!projectCwd) return { error: "cwd is required for project memory" };

  return {
    scope: "project",
    cwd: projectCwd,
    projectScope: projectScopeForCwd(projectCwd),
  };
}

export function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}
