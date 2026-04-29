import {
  createAgent,
  getAgent,
  listAgents,
  updateAgent,
  type Agent,
} from "./runs";
import {
  createSlice,
  getSlice,
  listSlices,
  updateSlice,
  type Slice,
} from "./slices";
import { normalizeCli } from "./clis";

export const SHARE_SCHEMA = "saturn.share.v1";

export type ShareKind = "agent" | "slice" | "bundle";
export type ImportConflictMode = "rename" | "skip" | "overwrite";

type ShareAgent = Omit<Agent, "created_at" | "updated_at"> & {
  created_at?: string;
  updated_at?: string;
};

type ShareSlice = Omit<Slice, "created_at" | "updated_at" | "version"> & {
  created_at?: string;
  updated_at?: string;
  version?: number;
};

export type SaturnShareBundle = {
  schema: typeof SHARE_SCHEMA;
  kind: ShareKind;
  exported_at: string;
  agents?: ShareAgent[];
  slices?: ShareSlice[];
};

export type ImportSummary = {
  agents: {
    created: string[];
    updated: string[];
    skipped: string[];
    renamed: Array<{ from: string; to: string }>;
  };
  slices: {
    created: string[];
    updated: string[];
    skipped: string[];
    renamed: Array<{ from: string; to: string }>;
  };
};

type MutableShareAgent = ShareAgent & Record<string, unknown>;
type MutableShareSlice = ShareSlice & Record<string, unknown>;

const ID_RE = /^[a-z0-9][a-z0-9-_]*$/i;

function stripAgent(agent: Agent): ShareAgent {
  const { created_at, updated_at, ...shareable } = agent;
  void created_at;
  void updated_at;
  return shareable;
}

function stripSlice(slice: Slice): ShareSlice {
  const { created_at, updated_at, version, ...shareable } = slice;
  void created_at;
  void updated_at;
  void version;
  return shareable;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function agentSliceIds(agent: Agent): Set<string> {
  const ids = new Set<string>();
  if (Array.isArray(agent.slices_available)) {
    for (const id of agent.slices_available) ids.add(id);
  }
  for (const node of agent.slice_graph?.nodes ?? []) {
    if (node.slice_id) ids.add(node.slice_id);
  }
  return ids;
}

export async function exportAgentBundle(id: string): Promise<SaturnShareBundle | null> {
  const [agent, slices] = await Promise.all([getAgent(id), listSlices()]);
  if (!agent) return null;

  const sliceSet = agent.slices_available === "*"
    ? slices
    : slices.filter((slice) => agentSliceIds(agent).has(slice.id));

  return {
    schema: SHARE_SCHEMA,
    kind: "agent",
    exported_at: new Date().toISOString(),
    agents: [stripAgent(agent)],
    slices: uniqueById(sliceSet).map(stripSlice),
  };
}

export async function exportSliceBundle(id: string): Promise<SaturnShareBundle | null> {
  const slice = await getSlice(id);
  if (!slice) return null;

  return {
    schema: SHARE_SCHEMA,
    kind: "slice",
    exported_at: new Date().toISOString(),
    slices: [stripSlice(slice)],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function normalizeShareBundle(input: unknown): SaturnShareBundle {
  if (!isObject(input)) throw new Error("Import JSON must be an object");

  if (input.schema === SHARE_SCHEMA) {
    return {
      schema: SHARE_SCHEMA,
      kind: (input.kind === "agent" || input.kind === "slice" || input.kind === "bundle") ? input.kind : "bundle",
      exported_at: typeof input.exported_at === "string" ? input.exported_at : new Date().toISOString(),
      agents: toArray(input.agents as ShareAgent | ShareAgent[] | undefined),
      slices: toArray(input.slices as ShareSlice | ShareSlice[] | undefined),
    };
  }

  if (isObject(input.agent) || Array.isArray(input.agents)) {
    return {
      schema: SHARE_SCHEMA,
      kind: "agent",
      exported_at: new Date().toISOString(),
      agents: toArray((input.agent ?? input.agents) as ShareAgent | ShareAgent[] | undefined),
      slices: toArray((input.slice ?? input.slices) as ShareSlice | ShareSlice[] | undefined),
    };
  }

  if (isObject(input.slice) || Array.isArray(input.slices)) {
    return {
      schema: SHARE_SCHEMA,
      kind: "slice",
      exported_at: new Date().toISOString(),
      slices: toArray((input.slice ?? input.slices) as ShareSlice | ShareSlice[] | undefined),
    };
  }

  if (typeof input.id === "string" && typeof input.prompt === "string") {
    return {
      schema: SHARE_SCHEMA,
      kind: "agent",
      exported_at: new Date().toISOString(),
      agents: [input as ShareAgent],
    };
  }

  if (typeof input.id === "string" && (isObject(input.prompt_template) || typeof input.prompt === "string")) {
    return {
      schema: SHARE_SCHEMA,
      kind: "slice",
      exported_at: new Date().toISOString(),
      slices: [input as ShareSlice],
    };
  }

  throw new Error("Import JSON must contain agents or slices");
}

function validateId(id: unknown, label: string): string {
  if (typeof id !== "string" || !id.trim()) throw new Error(`${label} id is required`);
  const trimmed = id.trim();
  if (!ID_RE.test(trimmed)) throw new Error(`${label} id must be alphanumeric with - or _`);
  return trimmed;
}

function validateAgent(agent: MutableShareAgent): MutableShareAgent {
  agent.id = validateId(agent.id, "Agent");
  if (typeof agent.name !== "string" || !agent.name.trim()) throw new Error(`Agent ${agent.id} name is required`);
  if (typeof agent.prompt !== "string" || !agent.prompt.trim()) throw new Error(`Agent ${agent.id} prompt is required`);
  if (agent.cli) agent.cli = normalizeCli(agent.cli);
  if (Array.isArray(agent.supportedClis)) {
    agent.supportedClis = agent.supportedClis.map((cli) => normalizeCli(cli));
  }
  if (agent.defaultCli) agent.defaultCli = normalizeCli(agent.defaultCli);
  delete agent.created_at;
  delete agent.updated_at;
  return agent;
}

function parseVariables(template: string): string[] {
  const matches = template.match(/\{\{([^}]+)\}\}/g) ?? [];
  return [...new Set(matches.map((match) => match.slice(2, -2).trim()).filter(Boolean))];
}

function validateSlice(slice: MutableShareSlice): MutableShareSlice {
  slice.id = validateId(slice.id, "Slice");
  if (typeof slice.name !== "string" || !slice.name.trim()) throw new Error(`Slice ${slice.id} name is required`);

  if (!isObject(slice.prompt_template) && typeof slice.prompt === "string") {
    const variables = parseVariables(slice.prompt);
    slice.prompt_template = { system: slice.prompt, variables, required: variables };
    delete slice.prompt;
  }
  if (!isObject(slice.prompt_template) || typeof slice.prompt_template.system !== "string" || !slice.prompt_template.system.trim()) {
    throw new Error(`Slice ${slice.id} prompt_template.system is required`);
  }

  slice.cli = normalizeCli(slice.cli);
  slice.capability ??= {
    mutation: "read-only",
    scope: ["repo"],
    output: { kind: "markdown" },
    interactivity: "one-shot",
    cost_tier: "cheap",
  };
  slice.sandbox ??= { mode: "none", net: "deny" };
  delete slice.created_at;
  delete slice.updated_at;
  delete slice.version;
  return slice;
}

function nextAvailableId(baseId: string, existingIds: Set<string>): string {
  const root = `${baseId}-import`;
  if (!existingIds.has(root)) return root;
  let i = 2;
  while (existingIds.has(`${root}-${i}`)) i += 1;
  return `${root}-${i}`;
}

function rewriteAgentSliceRefs(agent: MutableShareAgent, sliceIdMap: Map<string, string>) {
  if (Array.isArray(agent.slices_available)) {
    agent.slices_available = agent.slices_available.map((id) => sliceIdMap.get(id) ?? id);
  }
  if (isObject(agent.slice_graph) && Array.isArray(agent.slice_graph.nodes)) {
    const graph = agent.slice_graph;
    agent.slice_graph = {
      ...graph,
      nodes: graph.nodes.map((node: unknown) => {
        if (!isObject(node) || typeof node.slice_id !== "string") return node;
        return { ...node, slice_id: sliceIdMap.get(node.slice_id) ?? node.slice_id };
      }) as NonNullable<Agent["slice_graph"]>["nodes"],
    };
  }
}

export async function importShareBundle(
  bundle: SaturnShareBundle,
  conflictMode: ImportConflictMode = "rename",
): Promise<ImportSummary> {
  const existingSlices = new Set((await listSlices()).map((slice) => slice.id));
  const existingAgents = new Set((await listAgents()).map((agent) => agent.id));
  const sliceIdMap = new Map<string, string>();
  const agentIdMap = new Map<string, string>();
  const summary: ImportSummary = {
    agents: { created: [], updated: [], skipped: [], renamed: [] },
    slices: { created: [], updated: [], skipped: [], renamed: [] },
  };

  for (const rawSlice of bundle.slices ?? []) {
    const slice = validateSlice({ ...rawSlice });
    const originalId = slice.id;
    const exists = existingSlices.has(originalId);

    if (exists && conflictMode === "skip") {
      sliceIdMap.set(originalId, originalId);
      summary.slices.skipped.push(originalId);
      continue;
    }
    if (exists && conflictMode === "overwrite") {
      const { id, ...patch } = slice;
      await updateSlice(id, patch);
      sliceIdMap.set(originalId, originalId);
      summary.slices.updated.push(originalId);
      continue;
    }
    if (exists) {
      slice.id = nextAvailableId(originalId, existingSlices);
      sliceIdMap.set(originalId, slice.id);
      summary.slices.renamed.push({ from: originalId, to: slice.id });
    } else {
      sliceIdMap.set(originalId, originalId);
    }

    await createSlice(slice as Parameters<typeof createSlice>[0]);
    existingSlices.add(slice.id);
    summary.slices.created.push(slice.id);
  }

  for (const rawAgent of bundle.agents ?? []) {
    const agent = validateAgent({ ...rawAgent });
    rewriteAgentSliceRefs(agent, sliceIdMap);
    const originalId = agent.id;
    const exists = existingAgents.has(originalId);

    if (exists && conflictMode === "skip") {
      agentIdMap.set(originalId, originalId);
      summary.agents.skipped.push(originalId);
      continue;
    }
    if (exists && conflictMode === "overwrite") {
      const { id, ...patch } = agent;
      await updateAgent(id, patch);
      agentIdMap.set(originalId, originalId);
      summary.agents.updated.push(originalId);
      continue;
    }
    if (exists) {
      agent.id = nextAvailableId(originalId, existingAgents);
      agentIdMap.set(originalId, agent.id);
      summary.agents.renamed.push({ from: originalId, to: agent.id });
    } else {
      agentIdMap.set(originalId, originalId);
    }

    await createAgent(agent as Parameters<typeof createAgent>[0]);
    existingAgents.add(agent.id);
    summary.agents.created.push(agent.id);
  }

  void agentIdMap;
  return summary;
}
