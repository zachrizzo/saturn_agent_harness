import { NextRequest, NextResponse } from "next/server";
import {
  listSlices,
  createSlice,
  type Slice,
  type SliceCapability,
  type SlicePromptTemplate,
  type SliceSandbox,
} from "@/lib/slices";
import { toClaudeAlias } from "@/lib/claude-models";
import { normalizeCli } from "@/lib/clis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const slices = await listSlices();
  return NextResponse.json({ slices });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseVariables(template: string): string[] {
  const matches = template.match(/\{\{([^}]+)\}\}/g) ?? [];
  const names = matches.map((m) => m.slice(2, -2).trim()).filter(Boolean);
  return [...new Set(names)];
}

function validateCapability(value: unknown): value is SliceCapability {
  if (!isObject(value)) return false;
  if (typeof value.mutation !== "string") return false;
  if (!Array.isArray(value.scope)) return false;
  if (!isObject(value.output) || typeof value.output.kind !== "string") return false;
  if (typeof value.interactivity !== "string") return false;
  if (typeof value.cost_tier !== "string") return false;
  return true;
}

function validatePromptTemplate(value: unknown): value is SlicePromptTemplate {
  if (!isObject(value)) return false;
  if (typeof value.system !== "string") return false;
  if (!Array.isArray(value.variables)) return false;
  if (value.required !== undefined && !Array.isArray(value.required)) return false;
  return true;
}

function normalizePromptTemplate(value: unknown, prompt: unknown): SlicePromptTemplate | null {
  if (isObject(value) && typeof value.system === "string") {
    const variables = Array.isArray(value.variables)
      ? value.variables.filter((v): v is string => typeof v === "string")
      : parseVariables(value.system);
    const required = Array.isArray(value.required)
      ? value.required.filter((v): v is string => typeof v === "string")
      : variables;

    return {
      system: value.system,
      variables,
      required,
    };
  }

  if (typeof prompt === "string") {
    const variables = parseVariables(prompt);
    return {
      system: prompt,
      variables,
      required: variables,
    };
  }

  return null;
}

function validateSandbox(value: unknown): value is SliceSandbox {
  if (!isObject(value)) return false;
  if (typeof value.mode !== "string") return false;
  if (typeof value.net !== "string") return false;
  return true;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<Slice> & { prompt?: string };
  const { prompt, ...sliceBody } = body;
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!id || !name) {
    return NextResponse.json(
      { error: "id and name are required" },
      { status: 400 }
    );
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) {
    return NextResponse.json({ error: "id must be alphanumeric with - or _" }, { status: 400 });
  }

  const prompt_template = normalizePromptTemplate(body.prompt_template, prompt);
  if (!prompt_template || !prompt_template.system.trim()) {
    return NextResponse.json({ error: "prompt_template.system is required" }, { status: 400 });
  }

  const capability: SliceCapability =
    body.capability === undefined
      ? {
          mutation: "read-only",
          scope: ["repo"],
          output: { kind: "markdown" },
          interactivity: "one-shot",
          cost_tier: "cheap",
        }
      : body.capability;
  const sandbox: SliceSandbox =
    body.sandbox === undefined ? { mode: "none", net: "deny" } : body.sandbox;

  if (!validateCapability(capability)) {
    return NextResponse.json({ error: "capability is malformed" }, { status: 400 });
  }
  if (!validatePromptTemplate(prompt_template)) {
    return NextResponse.json({ error: "prompt_template is malformed" }, { status: 400 });
  }
  if (!validateSandbox(sandbox)) {
    return NextResponse.json({ error: "sandbox is malformed" }, { status: 400 });
  }

  // Normalize Bedrock IDs to short aliases before writing to slices.json.
  const model = body.model ? toClaudeAlias(body.model) ?? body.model : body.model;

  try {
    const slice = await createSlice({
      ...sliceBody,
      id,
      name,
      cli: normalizeCli(body.cli),
      model,
      capability,
      prompt_template,
      sandbox,
    } as Omit<Slice, "created_at" | "version"> & { version?: number; created_at?: string });
    return NextResponse.json({ slice }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    if (message.startsWith("Slice already exists")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
