import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { isClaudeCli, normalizeCli } from "@/lib/clis";
import { listClaudeSlashCommands } from "@/lib/native/claude-agent";
import { listCodexSkills } from "@/lib/native/codex-app-server";

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
    name: "native",
    label: "/native",
    description: "Run a selected-CLI subcommand directly, for native features Saturn does not model.",
    kind: "builtin",
    clis: ["claude-bedrock", "claude-personal", "claude-local", "codex"],
    transform: "literal",
    instruction: "/native",
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

const CODEX_NATIVE_SLASH_COMMANDS: SlashCommand[] = [
  ["permissions", "Set what Codex can do without asking first."],
  ["approvals", "Alias for permissions."],
  ["sandbox-add-read-dir", "Grant sandbox read access to an extra directory."],
  ["agent", "Switch or inspect the active agent thread."],
  ["apps", "Browse apps/connectors available to Codex."],
  ["plugins", "Browse installed and discoverable Codex plugins."],
  ["clear", "Clear the active Codex conversation context."],
  ["compact", "Compact the native Codex conversation history."],
  ["copy", "Show the latest completed Codex output for copying."],
  ["diff", "Show the Git diff for the current workspace."],
  ["exit", "Close the native Codex session context."],
  ["quit", "Close the native Codex session context."],
  ["experimental", "List or toggle Codex experimental features."],
  ["feedback", "Prepare Codex feedback diagnostics."],
  ["init", "Create or inspect repository agent instructions."],
  ["logout", "Sign out of Codex."],
  ["mention", "Attach or reference a file for the next turn."],
  ["model", "List Codex models and reasoning effort options."],
  ["fast", "Inspect or toggle Fast mode."],
  ["goal", "Set, view, pause, resume, or clear a Codex goal."],
  ["personality", "Choose a communication style for Codex responses."],
  ["ps", "Show background terminals for the current session."],
  ["stop", "Stop background terminals for the current session."],
  ["clean", "Alias for stop."],
  ["fork", "Fork the current conversation into a new thread."],
  ["side", "Start a focused side conversation."],
  ["resume", "List saved Codex conversations."],
  ["new", "Start a fresh Codex conversation context."],
  ["review", "Ask Codex to review the working tree."],
  ["status", "Display native Codex session configuration and token context."],
  ["debug-config", "Print native Codex config and policy diagnostics."],
  ["statusline", "Inspect status-line configuration."],
  ["title", "Inspect terminal-title configuration."],
  ["keymap", "Inspect keymap configuration."],
].map(([name, description]) => ({
  name,
  label: `/${name}`,
  description,
  kind: "command" as const,
  clis: ["codex"],
  transform: "literal" as const,
  instruction: `/${name}`,
}));

const CLAUDE_NATIVE_FALLBACK_COMMANDS: SlashCommand[] = [
  ["add-dir", "Add a working directory for file access in this session."],
  ["agents", "Manage Claude Code agent configurations."],
  ["autofix-pr", "Start a Claude Code web session to fix PR issues."],
  ["background", "Detach the current session to keep running in the background."],
  ["bg", "Alias for background."],
  ["batch", "Run the bundled batch skill for parallel codebase work."],
  ["branch", "Fork the current conversation branch."],
  ["fork", "Alias for branch."],
  ["btw", "Ask a side question without bloating conversation context."],
  ["chrome", "Configure Claude in Chrome settings."],
  ["claude-api", "Load Claude API and Managed Agents reference material."],
  ["clear", "Start a fresh conversation context."],
  ["reset", "Alias for clear."],
  ["new", "Alias for clear."],
  ["color", "Set the current session prompt color."],
  ["compact", "Compact the conversation context."],
  ["config", "Open Claude Code settings."],
  ["settings", "Alias for config."],
  ["context", "Show current context usage."],
  ["copy", "Copy the last assistant response."],
  ["cost", "Alias for usage."],
  ["debug", "Enable debug logging and troubleshoot the session."],
  ["desktop", "Continue the current session in Claude Code Desktop."],
  ["app", "Alias for desktop."],
  ["diff", "Open a diff viewer for uncommitted and per-turn changes."],
  ["doctor", "Diagnose Claude Code installation and settings."],
  ["effort", "Set the model effort level."],
  ["exit", "Exit the CLI."],
  ["quit", "Alias for exit."],
  ["export", "Export the current conversation."],
  ["extra-usage", "Configure extra usage when rate limits are hit."],
  ["fast", "Toggle fast mode."],
  ["feedback", "Submit Claude Code feedback."],
  ["bug", "Alias for feedback."],
  ["fewer-permission-prompts", "Add permission allowlists based on common tool calls."],
  ["focus", "Toggle fullscreen focus view."],
  ["goal", "Set or clear a persistent Claude Code goal."],
  ["heapdump", "Write a heap snapshot for troubleshooting memory use."],
  ["help", "Show help and available commands."],
  ["hooks", "View hook configurations."],
  ["ide", "Manage IDE integrations."],
  ["init", "Initialize project memory with a CLAUDE.md guide."],
  ["insights", "Generate a Claude Code usage insights report."],
  ["install-github-app", "Set up Claude GitHub Actions."],
  ["install-slack-app", "Install the Claude Slack app."],
  ["keybindings", "Open or create keybindings configuration."],
  ["login", "Sign in to Anthropic."],
  ["logout", "Sign out of Anthropic."],
  ["loop", "Run a repeated prompt loop."],
  ["proactive", "Alias for loop."],
  ["mcp", "Manage MCP servers and authentication."],
  ["memory", "Edit Claude memory files."],
  ["mobile", "Show the Claude mobile app QR code."],
  ["ios", "Alias for mobile."],
  ["android", "Alias for mobile."],
  ["model", "Select or change the Claude model."],
  ["passes", "Share a Claude Code pass if eligible."],
  ["permissions", "Manage Claude tool permission rules."],
  ["allowed-tools", "Alias for permissions."],
  ["plan", "Enter plan mode."],
  ["plugin", "Manage Claude Code plugins."],
  ["powerup", "Discover Claude Code features."],
  ["privacy-settings", "View and update privacy settings."],
  ["radio", "Open Claude FM radio."],
  ["recap", "Generate a one-line session recap."],
  ["release-notes", "View Claude Code release notes."],
  ["reload-plugins", "Reload active plugins."],
  ["remote-control", "Expose this session for remote control."],
  ["rc", "Alias for remote-control."],
  ["remote-env", "Configure the default remote environment."],
  ["rename", "Rename the current session."],
  ["resume", "Resume a saved conversation."],
  ["continue", "Alias for resume."],
  ["review", "Review a pull request or current changes."],
  ["rewind", "Rewind conversation and/or code to a checkpoint."],
  ["checkpoint", "Alias for rewind."],
  ["undo", "Alias for rewind."],
  ["sandbox", "Toggle sandbox mode."],
  ["schedule", "Create or manage routines."],
  ["routines", "Alias for schedule."],
  ["scroll-speed", "Adjust fullscreen mouse-wheel scroll speed."],
  ["security-review", "Review pending changes for security issues."],
  ["setup-bedrock", "Configure Amazon Bedrock auth and model pins."],
  ["setup-vertex", "Configure Google Vertex AI auth and model pins."],
  ["simplify", "Run the bundled simplify skill."],
  ["skills", "List available Claude Code skills."],
  ["stats", "Alias for usage."],
  ["status", "Show Claude Code status."],
  ["statusline", "Configure the status line."],
  ["stickers", "Order Claude Code stickers."],
  ["stop", "Stop a background session."],
  ["tasks", "List and manage background tasks."],
  ["bashes", "Alias for tasks."],
  ["team-onboarding", "Generate a team onboarding guide."],
  ["teleport", "Pull a Claude Code web session into the terminal."],
  ["tp", "Alias for teleport."],
  ["terminal-setup", "Configure terminal keybindings."],
  ["theme", "Change the color theme."],
  ["tui", "Set the terminal UI renderer."],
  ["ultraplan", "Draft a plan in an ultraplan session."],
  ["ultrareview", "Run a deep cloud code review."],
  ["upgrade", "Open plan upgrade options."],
  ["usage", "Show session cost and usage limits."],
  ["voice", "Toggle voice dictation."],
  ["web-setup", "Connect GitHub for Claude Code on the web."],
].map(([name, description]) => ({
  name,
  label: `/${name}`,
  description,
  kind: "command" as const,
  clis: ["claude-bedrock", "claude-personal", "claude-local"],
  transform: "literal" as const,
  instruction: `/${name}`,
}));

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

function discoveryCwd(requestedCwd?: string | null): string {
  return requestedCwd?.trim() || process.env.AUTOMATIONS_ROOT || process.cwd();
}

async function getClaudeCommands(cli: string, cwd: string): Promise<SlashCommand[]> {
  try {
    const commands = await listClaudeSlashCommands({ cli, cwd });
    if (commands.length > 0) {
      return commands.map((command) => {
        const name = command.name.replace(/^\//, "");
        return {
          name,
          label: `/${name}`,
          description: command.description || `Invoke ${name}`,
          kind: "command" as const,
          clis: ["claude-bedrock", "claude-personal", "claude-local"],
          transform: "replace" as const,
          instruction: `/${name}`,
        };
      });
    }
  } catch {
    // Fall through to the filesystem-based compatibility scan for machines
    // where the Claude binary is not available to the dashboard process.
  }

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

async function getCodexCommands(cwd: string): Promise<SlashCommand[]> {
  try {
    const skills = await listCodexSkills(cwd);
    if (skills.length > 0) {
      return skills.map((skill) => ({
        name: skill.name,
        label: `/${skill.name}`,
        description: skill.shortDescription || skill.description || `Use Codex skill ${skill.name}`,
        kind: "skill" as const,
        clis: ["codex"],
        transform: "literal" as const,
        instruction: `$${skill.name}`,
      }));
    }
  } catch {
    // Fall through to the legacy scan so the menu still works when Codex is
    // not installed or app-server is temporarily unavailable.
  }

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
  const cwd = discoveryCwd(searchParams.get("cwd"));

  const discoveredCommands =
    cli === "codex"
      ? await getCodexCommands(cwd)
      : isClaudeCli(cli)
        ? await getClaudeCommands(cli, cwd)
        : [];
  const commands: SlashCommand[] = [];
  const seen = new Set<string>();
  const orderedCommands = cli === "codex"
    ? [...CODEX_NATIVE_SLASH_COMMANDS, ...BUILTIN_COMMANDS, ...discoveredCommands]
    : isClaudeCli(cli)
      ? [...discoveredCommands, ...CLAUDE_NATIVE_FALLBACK_COMMANDS, ...BUILTIN_COMMANDS]
      : [...BUILTIN_COMMANDS, ...discoveredCommands];
  for (const command of orderedCommands) {
    if (!command.clis.includes(cli) || seen.has(command.name)) continue;
    seen.add(command.name);
    commands.push(command);
  }

  return NextResponse.json({ commands });
}
