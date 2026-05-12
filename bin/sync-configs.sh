#!/bin/bash
# sync-configs.sh
# Reads mcps.json and skills/ and syncs them to each CLI's config:
#   - Claude Code: ~/.claude.json (mcpServers) + ~/.claude/skills/ (symlinks)
#   - Codex:       ~/.codex/config.toml (mcp_servers.*) + ~/.codex/skills/ (symlinks)
#
# Run this any time you add/remove an MCP server in mcps.json or a skill
# in skills/.

set -euo pipefail

AUTOMATIONS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MCPS_FILE="$AUTOMATIONS_ROOT/mcps.json"
SKILLS_DIR="$AUTOMATIONS_ROOT/skills"

CLAUDE_CONFIG="$HOME/.claude.json"
CODEX_CONFIG="$HOME/.codex/config.toml"

CLAUDE_SKILLS="$HOME/.claude/skills"
CODEX_SKILLS="$HOME/.codex/skills"

if [[ ! -f "$MCPS_FILE" ]]; then
  echo "error: $MCPS_FILE not found" >&2
  exit 1
fi

# ─── MCP servers ────────────────────────────────────────────────────────────

echo "→ syncing MCP servers from $MCPS_FILE"

python3 - "$MCPS_FILE" "$CLAUDE_CONFIG" "$CODEX_CONFIG" <<'PY'
import json, sys, os, re

mcps_file, claude_config, codex_config = sys.argv[1:4]

with open(mcps_file) as f:
    cfg = json.load(f)
servers = cfg.get("servers", {})

def for_target(target):
    return {k: v for k, v in servers.items() if target in v.get("targets", [])}

# ─── Claude Code (~/.claude.json .mcpServers) ─────
if os.path.exists(claude_config):
    with open(claude_config) as f:
        cc = json.load(f)
    existing_mcps = cc.get("mcpServers", {})
    if not isinstance(existing_mcps, dict):
        existing_mcps = {}
    # Upsert Saturn-managed entries while preserving MCP servers the CLI,
    # plugins, or the user manage directly.
    new_mcps = dict(existing_mcps)
    for name, s in for_target("claude").items():
        if s["type"] == "local":
            entry = {"type": "stdio", "command": s["command"][0], "args": s["command"][1:]}
            if "env" in s:
                entry["env"] = s["env"]
            if "alwaysLoad" in s:
                entry["alwaysLoad"] = bool(s["alwaysLoad"])
            new_mcps[name] = entry
        elif s["type"] == "remote":
            url = s["url"]
            # Claude's HTTP MCPs go under plugin namespacing for plugin-managed ones; here we add as direct http/sse
            entry = {"type": "http", "url": url}
            if "alwaysLoad" in s:
                entry["alwaysLoad"] = bool(s["alwaysLoad"])
            new_mcps[name] = entry
    cc["mcpServers"] = new_mcps
    with open(claude_config, "w") as f:
        json.dump(cc, f, indent=2)
    print(f"  ✓ Claude Code: synced {len(for_target('claude'))} Saturn servers, preserved {max(len(existing_mcps) - len(for_target('claude')), 0)} existing → {claude_config}")
else:
    print(f"  ⚠ Claude config not found at {claude_config}, skipping")

# ─── Codex (~/.codex/config.toml [mcp_servers.*]) ─────
if os.path.exists(codex_config):
    codex_servers = for_target("codex")
    managed_sections = set()
    for name in codex_servers:
        managed_sections.add(f"mcp_servers.{name}")
        managed_sections.add(f"mcp_servers.{name}.env")

    # Line-based removal of Saturn-managed [mcp_servers.*] sections only.
    # Native/user/plugin-managed MCP config stays intact.
    # A new section header starts with '[' at column 0.
    with open(codex_config) as f:
        lines = f.readlines()

    kept = []
    in_mcp_section = False
    section_re = re.compile(r'^\[([^\]]+)\]\s*$')
    for line in lines:
        m = section_re.match(line)
        if m:
            section_name = m.group(1)
            in_mcp_section = section_name in managed_sections
            if in_mcp_section:
                continue
            kept.append(line)
        elif in_mcp_section:
            # skip any non-section line that belongs to an mcp section
            continue
        else:
            kept.append(line)

    cleaned = "".join(kept).rstrip() + "\n"

    new_blocks = []
    for name, s in codex_servers.items():
        if s["type"] == "local":
            cmd = s["command"][0]
            args = s["command"][1:]
            block = f'\n[mcp_servers.{name}]\ncommand = {json.dumps(cmd)}\nargs = {json.dumps(args)}\n'
            if "env" in s:
                block += f'\n[mcp_servers.{name}.env]\n'
                for k, v in s["env"].items():
                    block += f'{k} = {json.dumps(v)}\n'
            new_blocks.append(block)
        elif s["type"] == "remote":
            block = f'\n[mcp_servers.{name}]\nurl = {json.dumps(s["url"])}\n'
            new_blocks.append(block)

    with open(codex_config, "w") as f:
        f.write(cleaned)
        f.writelines(new_blocks)
    print(f"  ✓ Codex: synced {len(new_blocks)} Saturn servers, preserved native/user MCP config → {codex_config}")
else:
    print(f"  ⚠ Codex config not found at {codex_config}, skipping")

PY

# ─── Skills (symlinks to shared directory) ──────────────────────────────────

if [[ -d "$SKILLS_DIR" ]]; then
  echo ""
  echo "→ syncing skills from $SKILLS_DIR"

  mkdir -p "$CLAUDE_SKILLS" "$CODEX_SKILLS"

  # Claude + Codex: symlink the whole skill directory (identical SKILL.md format)
  for skill_path in "$SKILLS_DIR"/*/; do
    [[ -d "$skill_path" ]] || continue
    skill_name="$(basename "$skill_path")"

    for target_dir in "$CLAUDE_SKILLS" "$CODEX_SKILLS"; do
      link="$target_dir/$skill_name"
      if [[ -L "$link" ]]; then
        rm "$link"
      elif [[ -e "$link" ]]; then
        echo "  ⚠ $link exists and is not a symlink — skipping (move or delete it manually)"
        continue
      fi
      ln -s "$skill_path" "$link"
      echo "  ✓ $link → $skill_path"
    done
  done

else
  echo "  (no $SKILLS_DIR directory — skipping skills sync)"
fi

echo ""
echo "Done. Restart any running CLI sessions to pick up changes."
