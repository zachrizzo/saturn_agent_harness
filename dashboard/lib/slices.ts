// Slice catalog: types + CRUD. Mirrors the agent CRUD patterns in lib/runs.ts.
// This module uses node:fs and is server-only. Client components must use
// `import type { Slice, ... } from "./slices"` to avoid pulling fs in.
import { promises as fs } from "node:fs";
import { slicesFile } from "./paths";
import type { CLI } from "./runs";
import { normalizeCli } from "./clis";

export type SliceMutationTier =
  | "read-only"
  | "writes-scratch"
  | "writes-source"
  | "executes-side-effects";
export type SliceCostTier = "free" | "cheap" | "premium";
export type SliceScope = "single-file" | "directory" | "repo" | "multi-repo" | "internet";
export type SliceOutputKind = "structured" | "markdown" | "code-patch" | "no-output";
export type SliceInteractivity = "one-shot" | "multi-turn";
export type SliceSandboxMode = "none" | "tmpfs" | "worktree";
export type SliceSandboxNet = "allow" | "deny";

export type SliceCapability = {
  mutation: SliceMutationTier;
  scope: SliceScope[];
  output: { kind: SliceOutputKind; schema?: unknown };
  interactivity: SliceInteractivity;
  cost_tier: SliceCostTier;
};

export type SlicePromptTemplate = {
  system: string;
  variables: string[];
  required?: string[];
};

export type SliceSandbox = { mode: SliceSandboxMode; net: SliceSandboxNet };

export type SliceBudget = { max_tokens?: number; timeout_seconds?: number };

export type Slice = {
  id: string;
  name: string;
  description?: string;
  version: number;
  created_at: string;
  updated_at?: string;
  cli: CLI;
  model?: string;
  allowedTools?: string[];
  capability: SliceCapability;
  prompt_template: SlicePromptTemplate;
  sandbox: SliceSandbox;
  budget?: SliceBudget;
  io_schema?: { output?: unknown };
  tags?: string[];
};

async function readSlicesFile(): Promise<{ slices: Slice[] }> {
  try {
    const raw = await fs.readFile(slicesFile(), "utf8");
    const parsed = JSON.parse(raw);
    return { slices: parsed.slices ?? [] };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { slices: [] };
    throw err;
  }
}

async function writeSlicesFile(data: { slices: Slice[] }): Promise<void> {
  const body = {
    $comment: "Reusable slice catalog — managed by the dashboard.",
    slices: data.slices,
  };
  await fs.writeFile(slicesFile(), JSON.stringify(body, null, 2), "utf8");
}

export async function listSlices(): Promise<Slice[]> {
  const { slices } = await readSlicesFile();
  slices.forEach((slice) => {
    slice.cli = normalizeCli(slice.cli);
  });
  return slices;
}

export async function getSlice(id: string): Promise<Slice | undefined> {
  const slices = await listSlices();
  return slices.find((s) => s.id === id);
}

export async function createSlice(
  slice: Omit<Slice, "created_at" | "version"> & { version?: number; created_at?: string }
): Promise<Slice> {
  const data = await readSlicesFile();
  if (data.slices.find((s) => s.id === slice.id)) {
    throw new Error(`Slice already exists: ${slice.id}`);
  }
  const now = new Date().toISOString();
  const full: Slice = {
    ...slice,
    cli: normalizeCli(slice.cli),
    created_at: slice.created_at ?? now,
    updated_at: now,
    version: slice.version ?? 1,
  };
  data.slices.push(full);
  await writeSlicesFile(data);
  return full;
}

export async function updateSlice(
  id: string,
  patch: Partial<Omit<Slice, "id" | "created_at" | "version">>
): Promise<Slice> {
  const data = await readSlicesFile();
  const idx = data.slices.findIndex((s) => s.id === id);
  if (idx < 0) throw new Error(`Slice not found: ${id}`);
  const prev = data.slices[idx];
  const next: Slice = {
    ...prev,
    ...patch,
    cli: normalizeCli(patch.cli ?? prev.cli),
    id: prev.id,
    created_at: prev.created_at,
    version: (prev.version ?? 0) + 1,
    updated_at: new Date().toISOString(),
  };
  data.slices[idx] = next;
  await writeSlicesFile(data);
  return next;
}

export async function deleteSlice(id: string): Promise<void> {
  const data = await readSlicesFile();
  const filtered = data.slices.filter((s) => s.id !== id);
  if (filtered.length === data.slices.length) throw new Error(`Slice not found: ${id}`);
  await writeSlicesFile({ slices: filtered });
}
