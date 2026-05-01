import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { isClaudeCli, normalizeCli } from "@/lib/clis";

export const dynamic = "force-dynamic";

export type SlashCommand = {
  name: string;
  label: string;
  description: string;
  kind: "builtin" | "skill" | "command";
  clis: string[];
  transform: "prefix" | "replace" | "literal";
  instruction: string;
  action?: "claude-personal-login";
};

const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: "login",
    label: "/login",
    description: "Open Claude Code personal login in Terminal.",
    kind: "builtin",
    clis: ["claude-personal"],
    transform: "replace",
    instruction: "/login",
    action: "claude-personal-login",
  },
  {
    name: "plan",
    label: "/plan",
    description: "Use the selected CLI's native plan mode for this turn.",
    kind: "builtin",
    clis: ["claude-bedrock", "claude-personal", "claude-local", "codex"],
    transform: "literal",
    instruction: "/plan",
  },
  {
    name: "mcp",
    label: "/mcp",
    description: "Run the selected CLI's native MCP manager and refresh tools for the next turn.",
    kind: "builtin",
    clis: ["claude-bedrock", "claude-personal", "claude-local", "codex"],
    transform: "literal",
    instruction: "/mcp",
  },
  {
    name: "think",
    label: "/think",
    description: "Use extended thinking / reasoning before responding.",
    kind: "builtin",
    clis: ["claude-bedrock", "claude-personal", "claude-local"],
    transform: "prefix",
    instruction: "[Extended thinking] Use deep reasoning and think through this carefully before responding:\n\n",
  },
  {
    name: "review",
    label: "/review",
    description: "Do a thorough code review of recent changes.",
    kind: "builtin",
    clis: ["claude-bedrock", "claude-personal", "claude-local", "codex"],
    transform: "replace",
    instruction: "Please do a thorough code review. Look at recent changes (git diff), check for bugs, security issues, code quality, and adherence to project conventions. Be specific about what you find.",
  },
  {
    name: "commit",
    label: "/commit",
    description: "Stage and commit all changes with a meaningful commit message.",
    kind: "builtin",
    clis: ["claude-bedrock", "claude-personal", "claude-local", "codex"],
    transform: "replace",
    instruction: "Stage all modified files and create a git commit. Write a concise, meaningful commit message that explains what changed and why. Show me what you're committing before you do it.",
  },
  {
    name: "test",
    label: "/test",
    description: "Run the test suite and report results.",
    kind: "builtin",
    clis: ["claude-bedrock", "claude-personal", "claude-local", "codex"],
    transform: "replace",
    instruction: "Run the project's test suite. Show the full output. If tests fail, identify the root cause and suggest fixes.",
  },
  {
    name: "explain",
    label: "/explain",
    description: "Explain how the current codebase / feature works.",
    kind: "builtin",
    clis: ["claude-bedrock", "claude-personal", "claude-local", "codex"],
    transform: "prefix",
    instruction: "Explain clearly and thoroughly: ",
  },
  {
    name: "fix",
    label: "/fix",
    description: "Find and fix the described issue.",
    kind: "builtin",
    clis: ["claude-bedrock", "claude-personal", "claude-local", "codex"],
    transform: "prefix",
    instruction: "Find the root cause and fix this issue. Show your reasoning:\n\n",
  },
];

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function findFiles(dir: string, fileName: string, maxDepth: number): Promise<string[]> {
  if (maxDepth < 0) return [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === fileName) {
        result.push(entryPath);
      } else if (entry.isDirectory()) {
        result.push(...await findFiles(entryPath, fileName, maxDepth - 1));
      }
    }

    return result;
  } catch {
    return [];
  }
}

async function findMarkdownFiles(dir: string, maxDepth: number): Promise<string[]> {
  if (maxDepth < 0) return [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".md")) {
        result.push(entryPath);
      } else if (entry.isDirectory()) {
        result.push(...await findMarkdownFiles(entryPath, maxDepth - 1));
      }
    }

    return result;
  } catch {
    return [];
  }
}

function commandNameFromPath(rootDir: string, filePath: string, prefix?: string): string {
  const relative = path
    .relative(rootDir, filePath)
    .replace(/\.md$/, "")
    .split(path.sep)
    .filter(Boolean)
    .join(":");
  return prefix ? `${prefix}:${relative}` : relative;
}

async function readDescription(filePath: string): Promise<string> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const descMatch = fmMatch[1].match(/description:\s*["']?(.+?)["']?\s*$/m);
      if (descMatch) return descMatch[1].trim().substring(0, 120);
    }
    // Fall back to first non-empty, non-heading line
    const lines = raw.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("---"));
    if (lines[0]) return lines[0].trim().substring(0, 120);
  } catch {}
  return "";
}

type DiscoveredItem = { filePath: string; name: string; kind: "skill" | "command" };

async function readCommandBody(filePath: string): Promise<string> {
  try {
    return (await fs.readFile(filePath, "utf8")).trim();
  } catch {
    return "";
  }
}

async function addMarkdownCommands(
  add: (item: DiscoveredItem) => void,
  rootDir: string,
  prefix?: string,
) {
  for (const filePath of await findMarkdownFiles(rootDir, 3)) {
    add({ filePath, name: commandNameFromPath(rootDir, filePath, prefix), kind: "command" });
  }
}

async function getClaudeItems(): Promise<DiscoveredItem[]> {
  const result: DiscoveredItem[] = [];
  const homeDir = os.homedir();
  const seen = new Set<string>();

  const add = (item: DiscoveredItem) => {
    if (!seen.has(item.name)) {
      seen.add(item.name);
      result.push(item);
    }
  };

  // 1. ~/.claude/skills/ — standalone skills
  const globalSkillsDir = path.join(homeDir, ".claude", "skills");
  for (const name of await listDirs(globalSkillsDir)) {
    const skillFile = path.join(globalSkillsDir, name, "SKILL.md");
    const readmeFile = path.join(globalSkillsDir, name, "README.md");
    const filePath = await fs.access(skillFile).then(() => skillFile).catch(() => readmeFile);
    add({ filePath, name, kind: "skill" });
  }

  // 2. Native user/project command files. Claude Code exposes these as
  // /user:<name> and /project:<name> slash commands.
  await addMarkdownCommands(add, path.join(homeDir, ".claude", "commands"), "user");
  await addMarkdownCommands(add, path.join(process.env.AUTOMATIONS_ROOT ?? process.cwd(), ".claude", "commands"), "project");

  // 3. Installed plugins from installed_plugins.json (source of truth)
  const installedPath = path.join(homeDir, ".claude", "plugins", "installed_plugins.json");
  let installedPlugins: Record<string, { installPath: string }[]> = {};
  try {
    const raw = await fs.readFile(installedPath, "utf8");
    const parsed = JSON.parse(raw) as { plugins?: Record<string, { installPath: string }[]> };
    installedPlugins = parsed.plugins ?? {};
  } catch {}

  for (const [pluginKey, installs] of Object.entries(installedPlugins)) {
    const pluginName = pluginKey.split("@")[0];
    const installPath = installs[0]?.installPath;
    if (!installPath) continue;

    // skills/ subdirs
    const skillsDir = path.join(installPath, "skills");
    for (const skillName of await listDirs(skillsDir)) {
      const skillFile = path.join(skillsDir, skillName, "SKILL.md");
      const readmeFile = path.join(skillsDir, skillName, "README.md");
      const filePath = await fs.access(skillFile).then(() => skillFile).catch(() => readmeFile);
      add({ filePath, name: `${pluginName}:${skillName}`, kind: "skill" });
    }

    // commands/ .md files
    const commandsDir = path.join(installPath, "commands");
    for (const cmdFile of await listFiles(commandsDir)) {
      if (!cmdFile.endsWith(".md")) continue;
      const cmdName = cmdFile.replace(/\.md$/, "");
      add({ filePath: path.join(commandsDir, cmdFile), name: `${pluginName}:${cmdName}`, kind: "command" });
    }
  }

  // 4. Local plugins (not in installed_plugins.json)
  const localPluginsDir = path.join(homeDir, ".claude", "plugins", "local");
  for (const pluginName of await listDirs(localPluginsDir)) {
    const pluginDir = path.join(localPluginsDir, pluginName);

    const skillsDir = path.join(pluginDir, "skills");
    for (const skillName of await listDirs(skillsDir)) {
      const skillFile = path.join(skillsDir, skillName, "SKILL.md");
      const readmeFile = path.join(skillsDir, skillName, "README.md");
      const filePath = await fs.access(skillFile).then(() => skillFile).catch(() => readmeFile);
      add({ filePath, name: `${pluginName}:${skillName}`, kind: "skill" });
    }

    const commandsDir = path.join(pluginDir, "commands");
    for (const cmdFile of await listFiles(commandsDir)) {
      if (!cmdFile.endsWith(".md")) continue;
      const cmdName = cmdFile.replace(/\.md$/, "");
      add({ filePath: path.join(commandsDir, cmdFile), name: `${pluginName}:${cmdName}`, kind: "command" });
    }
  }

  return result;
}

type CodexPluginManifest = {
  name?: string;
  skills?: string;
  commands?: string;
};

async function readCodexPluginManifest(manifestPath: string): Promise<CodexPluginManifest> {
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(raw) as CodexPluginManifest;
  } catch {
    return {};
  }
}

async function getCodexItems(): Promise<DiscoveredItem[]> {
  const result: DiscoveredItem[] = [];
  const homeDir = os.homedir();
  const seen = new Set<string>();

  const add = (item: DiscoveredItem) => {
    if (!seen.has(item.name)) {
      seen.add(item.name);
      result.push(item);
    }
  };

  // 1. ~/.codex/skills/ — standalone and system skills
  const codexSkillsDir = path.join(homeDir, ".codex", "skills");
  for (const filePath of await findFiles(codexSkillsDir, "SKILL.md", 3)) {
    const relativeParts = path
      .relative(codexSkillsDir, path.dirname(filePath))
      .split(path.sep)
      .filter((part) => part && part !== ".system");
    const name = relativeParts.at(-1);
    if (name) add({ filePath, name, kind: "skill" });
  }

  // 2. Native-looking user/project command files, when present. Codex exec does
  // not expose an interactive slash-command registry, so these are converted
  // into prompt instructions below instead of sent as literal slash commands.
  await addMarkdownCommands(add, path.join(homeDir, ".codex", "commands"), "user");
  await addMarkdownCommands(add, path.join(process.env.AUTOMATIONS_ROOT ?? process.cwd(), ".codex", "commands"), "project");

  // 3. ~/.codex/plugins/ — cached and local plugin skills/commands
  const codexPluginsDir = path.join(homeDir, ".codex", "plugins");
  for (const manifestPath of await findFiles(codexPluginsDir, "plugin.json", 6)) {
    if (!manifestPath.includes(`${path.sep}.codex-plugin${path.sep}`)) continue;

    const pluginDir = path.dirname(path.dirname(manifestPath));
    const manifest = await readCodexPluginManifest(manifestPath);
    const pluginName = manifest.name || path.basename(pluginDir);
    const skillsDir = manifest.skills
      ? path.resolve(pluginDir, manifest.skills)
      : path.join(pluginDir, "skills");

    for (const filePath of await findFiles(skillsDir, "SKILL.md", 2)) {
      const skillName = path.basename(path.dirname(filePath));
      add({ filePath, name: `${pluginName}:${skillName}`, kind: "skill" });
    }

    const commandsDir = manifest.commands
      ? path.resolve(pluginDir, manifest.commands)
      : path.join(pluginDir, "commands");
    await addMarkdownCommands((item) => add({ ...item, name: `${pluginName}:${item.name}` }), commandsDir);
  }

  return result;
}

async function getClaudeCommands(): Promise<SlashCommand[]> {
  const items = await getClaudeItems();
  return Promise.all(
    items.map(async ({ filePath, name, kind }) => {
      const description = await readDescription(filePath);
      return {
        name,
        label: `/${name}`,
        description: description || `Invoke ${name}`,
        kind,
        clis: ["claude-bedrock", "claude-personal", "claude-local"],
        transform: "replace" as const,
        instruction: `/${name}`,
      };
    })
  );
}

async function getCodexCommands(): Promise<SlashCommand[]> {
  const items = await getCodexItems();
  return Promise.all(
    items.map(async ({ filePath, name, kind }) => {
      const description = await readDescription(filePath);
      const commandBody = kind === "command" ? await readCommandBody(filePath) : "";
      return {
        name,
        label: `/${name}`,
        description: description || `Use Codex ${kind} ${name}`,
        kind,
        clis: ["codex"],
        transform: "prefix" as const,
        instruction: kind === "command" && commandBody
          ? `Use the Codex command "${name}". Follow these command instructions for this task:\n\n${commandBody}\n\n`
          : `Use the Codex skill "${name}". Follow its SKILL.md instructions for this task.\n\n`,
      };
    })
  );
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cli = normalizeCli(searchParams.get("cli"));

  const discoveredCommands =
    cli === "codex"
      ? await getCodexCommands()
      : isClaudeCli(cli)
        ? await getClaudeCommands()
        : [];
  const commands = [...BUILTIN_COMMANDS, ...discoveredCommands].filter((c) => c.clis.includes(cli));

  return NextResponse.json({ commands });
}
