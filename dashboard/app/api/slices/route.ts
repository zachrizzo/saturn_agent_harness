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

function validateSandbox(value: unknown): value is SliceSandbox {
  if (!isObject(value)) return false;
  if (typeof value.mode !== "string") return false;
  if (typeof value.net !== "string") return false;
  return true;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<Slice>;
  const { id, name, cli, capability, prompt_template, sandbox } = body;

  if (!id || !name || !cli || !capability || !prompt_template || !sandbox) {
    return NextResponse.json(
      { error: "id, name, cli, capability, prompt_template, sandbox are required" },
      { status: 400 }
    );
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) {
    return NextResponse.json({ error: "id must be alphanumeric with - or _" }, { status: 400 });
  }
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
  if (body.model) body.model = toClaudeAlias(body.model) ?? body.model;

  try {
    const slice = await createSlice({
      ...body,
      id,
      name,
      cli: normalizeCli(cli),
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
