// Saved fixtures for slice unit tests. Each fixture pairs an input record with
// optional expected-output assertions. Stored as JSON files on disk so they can
// be checked into git alongside the slice definitions.

import { promises as fs } from "node:fs";
import path from "node:path";
import { sliceFixturesDir } from "./paths";

export type FixtureAssertion =
  | { kind: "status_equals"; status: string }
  | { kind: "output_json_equals"; json: unknown }
  | { kind: "output_contains_key"; key: string }
  | { kind: "output_schema_valid" }
  | { kind: "max_tokens"; tokens: number }
  | { kind: "max_duration_ms"; ms: number };

export type SliceFixture = {
  name: string;
  description?: string;
  inputs: Record<string, unknown>;
  assertions?: FixtureAssertion[];
  created_at?: string;
  updated_at?: string;
};

const FIXTURE_NAME_PATTERN = /^[a-z0-9_\-.]+$/i;

function fixturePath(sliceId: string, name: string): string {
  if (!FIXTURE_NAME_PATTERN.test(name)) {
    throw new Error("fixture name must match /^[a-z0-9_\\-.]+$/i");
  }
  const dir = path.resolve(sliceFixturesDir(sliceId));
  const filePath = path.resolve(dir, `${name}.json`);
  const relative = path.relative(dir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("fixture path escapes fixture directory");
  }
  return filePath;
}

export async function listFixtures(sliceId: string): Promise<SliceFixture[]> {
  const dir = sliceFixturesDir(sliceId);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const loaded = await Promise.all(
    files.map((f) =>
      fs
        .readFile(path.join(dir, f), "utf8")
        .then((raw) => JSON.parse(raw) as SliceFixture)
        .catch(() => null),
    ),
  );
  return loaded
    .filter((f): f is SliceFixture => f !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getFixture(sliceId: string, name: string): Promise<SliceFixture | null> {
  let p: string;
  try {
    p = fixturePath(sliceId, name);
  } catch {
    return null;
  }
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as SliceFixture;
  } catch {
    return null;
  }
}

export async function saveFixture(sliceId: string, fixture: SliceFixture): Promise<void> {
  const dir = sliceFixturesDir(sliceId);
  await fs.mkdir(dir, { recursive: true });
  const p = fixturePath(sliceId, fixture.name);
  const now = new Date().toISOString();
  const toWrite: SliceFixture = {
    ...fixture,
    updated_at: now,
    created_at: fixture.created_at ?? now,
  };
  await fs.writeFile(
    p,
    JSON.stringify(toWrite, null, 2),
    "utf8",
  );
}

export async function deleteFixture(sliceId: string, name: string): Promise<void> {
  let p: string;
  try {
    p = fixturePath(sliceId, name);
  } catch {
    return;
  }
  await fs.unlink(p).catch(() => { /* already gone */ });
}

// ─── Assertion runner ────────────────────────────────────────────────────────

export type AssertionOutcome = {
  assertion: FixtureAssertion;
  passed: boolean;
  message?: string;
};

export type FixtureRunResult = {
  fixture_name: string;
  all_passed: boolean;
  outcomes: AssertionOutcome[];
};

function check(assertion: FixtureAssertion, passed: boolean, failMessage: string): AssertionOutcome {
  return { assertion, passed, message: passed ? undefined : failMessage };
}

/** Evaluates assertions against a slice execute result. */
export function evaluateAssertions(
  result: {
    status: string;
    output: unknown;
    tokens: { total: number };
    duration_ms: number;
  },
  assertions: FixtureAssertion[] = [],
): AssertionOutcome[] {
  return assertions.map((a) => {
    switch (a.kind) {
      case "status_equals":
        return check(a, result.status === a.status, `status ${result.status} !== ${a.status}`);
      case "output_json_equals":
        return check(
          a,
          JSON.stringify(result.output) === JSON.stringify(a.json),
          "output JSON mismatch",
        );
      case "output_contains_key": {
        const ok =
          !!result.output &&
          typeof result.output === "object" &&
          a.key in (result.output as Record<string, unknown>);
        return check(a, ok, `missing key "${a.key}"`);
      }
      case "output_schema_valid":
        return check(a, result.status === "success", "schema validation failed (status != success)");
      case "max_tokens":
        return check(a, result.tokens.total <= a.tokens, `${result.tokens.total} > ${a.tokens}`);
      case "max_duration_ms":
        return check(a, result.duration_ms <= a.ms, `${result.duration_ms}ms > ${a.ms}ms`);
    }
  });
}
