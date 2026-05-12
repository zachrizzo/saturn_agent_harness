#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: options.timeout ?? 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${output}`);
  }
  return output;
}

function assertIncludes(text, needle, label) {
  if (!text.includes(needle)) {
    throw new Error(`${label} did not include ${JSON.stringify(needle)}`);
  }
}

function assertSourceIncludes(file, needles) {
  const source = readFileSync(path.join(root, file), "utf8");
  for (const needle of needles) {
    assertIncludes(source, needle, file);
  }
}

run("node", ["--check", "bin/codex-native-slash.mjs"]);
run("node", ["--check", "bin/codex-app-server-turn.mjs"]);

assertSourceIncludes("bin/codex-app-server-turn.mjs", [
  '"native.request"',
  "item/tool/requestUserInput",
  "item/permissions/requestApproval",
]);

assertSourceIncludes("dashboard/app/api/slash-commands/route.ts", [
  '["model", "List Codex models and reasoning effort options."]',
  '["goal", "Set, view, pause, resume, or clear a Codex goal."]',
  '["permissions", "Set what Codex can do without asking first."]',
  '["agents", "Manage Claude Code agent configurations."]',
  'listClaudeSlashCommands',
  'listCodexSkills',
]);

assertSourceIncludes("dashboard/lib/native/claude-executable.ts", [
  '"/usr/local/bin/claude"',
  "CLAUDE_CODE_EXECUTABLE",
  "resolveClaudeExecutable",
]);

const models = run("node", ["bin/codex-native-slash.mjs", "--cwd", root, "model"], { timeout: 30_000 });
assertIncludes(models, "Native Codex Models", "/model");

const permissions = run("node", ["bin/codex-native-slash.mjs", "--cwd", root, "permissions"], { timeout: 30_000 });
assertIncludes(permissions, "Native Codex Permissions", "/permissions");

console.log("native bridge checks passed");
