#!/usr/bin/env node
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(paths) {
  for (const candidate of paths) {
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
}

async function installedPluginPaths(home, pluginId, installedPlugins) {
  const entries = installedPlugins?.plugins?.[pluginId];
  if (!Array.isArray(entries)) return [];

  const paths = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.installPath !== "string") continue;
    try {
      const info = await stat(entry.installPath);
      if (info.isDirectory()) paths.push(entry.installPath);
    } catch {
      // Ignore stale plugin registry entries.
    }
  }

  // Fallback for older plugin registry layouts.
  if (paths.length === 0) {
    const [pluginName, marketplace] = pluginId.split("@");
    if (pluginName && marketplace) {
      const cacheRoot = path.join(home, ".claude", "plugins", "cache", marketplace, pluginName);
      try {
        const versions = await readdir(cacheRoot);
        paths.push(...versions.map((version) => path.join(cacheRoot, version)));
      } catch {
        // No cache fallback available.
      }
    }
  }

  return paths;
}

async function readPluginMcpServers(pluginPath) {
  const mcpPath = await firstExisting([
    path.join(pluginPath, ".mcp.json"),
    path.join(pluginPath, "mcp.json"),
    path.join(pluginPath, "figma-power", "mcp.json"),
  ]);
  if (mcpPath) {
    const config = await readJson(mcpPath);
    if (isRecord(config?.mcpServers)) return config.mcpServers;
  }

  const server = await readJson(path.join(pluginPath, "server.json"));
  if (Array.isArray(server?.remotes) && server.remotes.length > 0) {
    const remote = server.remotes.find((item) => typeof item?.url === "string");
    if (remote) {
      const pluginName = path.basename(path.dirname(pluginPath));
      return {
        [pluginName]: {
          type: remote.type === "streamable-http" ? "http" : remote.type ?? "http",
          url: remote.url,
        },
      };
    }
  }

  return undefined;
}

async function main() {
  const outPath = process.argv[2];
  if (!outPath) {
    console.error("usage: build-plugin-mcp-config.mjs <out-path>");
    process.exit(2);
  }

  const home = process.env.HOME;
  if (!home) return;

  const settingsFiles = [
    path.join(home, ".claude", "settings.json"),
    path.join(home, ".claude", "settings.local.json"),
    path.join(home, ".claude", "settings-local.json"),
  ];
  const enabledPlugins = {};
  for (const file of settingsFiles) {
    const settings = await readJson(file);
    if (!isRecord(settings?.enabledPlugins)) continue;
    Object.assign(enabledPlugins, settings.enabledPlugins);
  }

  const installedPlugins = await readJson(path.join(home, ".claude", "plugins", "installed_plugins.json"));
  const mcpServers = {};

  for (const [pluginId, enabled] of Object.entries(enabledPlugins)) {
    if (enabled !== true) continue;
    const pluginName = pluginId.split("@")[0];
    if (!pluginName) continue;

    const pluginPaths = await installedPluginPaths(home, pluginId, installedPlugins);
    for (const pluginPath of pluginPaths) {
      const servers = await readPluginMcpServers(pluginPath);
      if (!isRecord(servers)) continue;

      for (const [serverName, serverConfig] of Object.entries(servers)) {
        if (!isRecord(serverConfig)) continue;
        mcpServers[`plugin:${pluginName}:${serverName}`] = serverConfig;
      }
      break;
    }
  }

  if (Object.keys(mcpServers).length === 0) return;

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify({ mcpServers }, null, 2)}\n`, { mode: 0o600 });
  console.log(outPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
