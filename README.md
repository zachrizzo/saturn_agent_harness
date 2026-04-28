# saturn

Schedule Claude Code agent runs via native macOS cron and view results in a local Next.js dashboard.

---

## Fresh Machine Setup

Paste this prompt into Claude Code to set up the entire project from scratch:

```
You are setting up the saturn harness on a fresh machine. The repo is at /Users/zachrizzo/programming/ai\ harnnes. Do all of the following in order:

1. Install prerequisites:
   - Install the Codex Desktop app from https://codex.com (required for image generation — it populates ~/.codex/skills/.system/)
   - Verify the Codex CLI is available: codex --version (it ships with the Desktop app; if missing run: npm install -g @openai/codex)
   - Run: pipx install litellm
   - Ensure ~/.local/bin is in PATH — add to ~/.zshrc if missing:
     grep -q '.local/bin' ~/.zshrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
   - Create local config files from the committed examples:
     cp settings.example.json settings.json
     cp agents.example.json agents.json
     cp slices.example.json slices.json
     cp mcps.example.json mcps.json
     cp working-directories.example.json working-directories.json
     cp jobs/jobs.example.json jobs/jobs.json
     cp dashboard/.env.local.example dashboard/.env.local
   - Run: cd "/Users/zachrizzo/programming/ai harnnes/dashboard" && npm install && npm run build

2. Create ~/litellm_config.yaml — copy the full YAML from the "Model Backends" section of README.md

3. Create ~/bin/claude-local — copy the full script from the "Model Backends" section of README.md
   Then run: chmod +x ~/bin/claude-local

4. Configure Claude Code for Bedrock in ~/.claude/settings.json:
   Ensure these env keys exist: CLAUDE_CODE_USE_BEDROCK=1, AWS_PROFILE=sondermind-development-new, AWS_REGION=us-east-1
   Then run: aws sso login --profile sondermind-development-new

5. Patch all hardcoded /Users/zachrizzo paths to the current user's home directory:
   REPO="/Users/zachrizzo/programming/ai harnnes"
   ME="$(whoami)"
   NODE_BIN="$(dirname $(which node))"
   sed -i '' "s|/Users/zachrizzo|$HOME|g" "$REPO/bin/run-job.sh" "$REPO/bin/run-turn.sh" "$REPO/bin/run-slice.sh" "$REPO/dashboard/.env.local"
   sed -i '' "s|/Users/zachrizzo/.nvm/versions/node/v[0-9.]*|$HOME/.nvm/versions/node/$(node --version)|g" "$REPO/bin/run-job.sh" "$REPO/bin/run-turn.sh" "$REPO/bin/run-slice.sh"

6. Run: "/Users/zachrizzo/programming/ai harnnes/bin/sync-configs.sh"
   This propagates MCP servers to Claude Code and Codex.

7. Install the dashboard as an always-on service:
   REPO="/Users/zachrizzo/programming/ai harnnes"
   PLIST=~/Library/LaunchAgents/com.zachrizzo.claude-cron-dashboard.plist
   cp "$REPO/launchd/com.zachrizzo.claude-cron-dashboard.plist" "$PLIST"
   sed -i '' "s|/Users/zachrizzo|$HOME|g" "$PLIST"
   NODE_VER=$(node --version)
   sed -i '' "s|\.nvm/versions/node/v[0-9.]*|.nvm/versions/node/$NODE_VER|g" "$PLIST"
   launchctl load "$PLIST"

8. Register cron jobs:
   "/Users/zachrizzo/programming/ai harnnes/bin/register-job.sh"

9. Verify:
   - Visit http://127.0.0.1:3737
   - Dashboard `claude-bedrock` should use AWS Bedrock
   - Dashboard `claude-personal` should use Claude Code `/login`
   - Dashboard `claude-local` should use LM Studio via LiteLLM
```

---

## Model Backends

Dashboard backend IDs are:

| CLI ID | Binary | Backend |
|---|---|---|
| `claude-bedrock` | `claude` | AWS Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`, AWS profile/region) |
| `claude-personal` | `claude` | Claude Code personal `/login` auth, with Bedrock/LiteLLM env cleared |
| `claude-local` | `claude` | LM Studio via LiteLLM proxy on port 4000 |
| `codex` | `codex` | Codex CLI |

The legacy stored value `claude` is accepted as `claude-bedrock`.

For manual terminal testing, Bedrock and local can be run side-by-side after initial setup:

| Terminal | Command | Backend |
|---|---|---|
| Terminal 1 | `claude` | AWS Bedrock (global `~/.claude/settings.json`) |
| Terminal 2 | `claude-local` | LM Studio via LiteLLM proxy |

Switch model for a local session:
```bash
ANTHROPIC_MODEL=google/gemma-4-31b claude-local
```

### `~/litellm_config.yaml`

```yaml
model_list:
  # AWS Bedrock models (via sondermind-development-new SSO profile)
  - model_name: claude-opus-4-7
    litellm_params:
      model: bedrock/us.anthropic.claude-opus-4-7
      aws_profile_name: sondermind-development-new
      aws_region_name: us-east-1
  - model_name: claude-opus-4-6
    litellm_params:
      model: bedrock/us.anthropic.claude-opus-4-6-v1
      aws_profile_name: sondermind-development-new
      aws_region_name: us-east-1
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: bedrock/us.anthropic.claude-sonnet-4-6
      aws_profile_name: sondermind-development-new
      aws_region_name: us-east-1
  - model_name: claude-sonnet-4-5
    litellm_params:
      model: bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0
      aws_profile_name: sondermind-development-new
      aws_region_name: us-east-1
  - model_name: claude-haiku-4-5
    litellm_params:
      model: bedrock/us.anthropic.claude-haiku-4-5-20251001
      aws_profile_name: sondermind-development-new
      aws_region_name: us-east-1

  # LM Studio local models (OpenAI-compatible endpoint)
  - model_name: nvidia/nemotron-3-nano
    litellm_params:
      model: openai/nvidia/nemotron-3-nano
      api_base: http://127.0.0.1:1234/v1
      api_key: lm-studio
  - model_name: qwen/qwen3.6-27b
    litellm_params:
      model: openai/qwen/qwen3.6-27b
      api_base: http://127.0.0.1:1234/v1
      api_key: lm-studio
  - model_name: mlx-community/qwen3.6-27b
    litellm_params:
      model: openai/mlx-community/qwen3.6-27b
      api_base: http://127.0.0.1:1234/v1
      api_key: lm-studio
  - model_name: qwen/qwen3.6-35b-a3b
    litellm_params:
      model: openai/qwen/qwen3.6-35b-a3b
      api_base: http://127.0.0.1:1234/v1
      api_key: lm-studio
  - model_name: google/gemma-4-31b
    litellm_params:
      model: openai/google/gemma-4-31b
      api_base: http://127.0.0.1:1234/v1
      api_key: lm-studio
  - model_name: nvidia/nemotron-3-super
    litellm_params:
      model: openai/nvidia/nemotron-3-super
      api_base: http://127.0.0.1:1234/v1
      api_key: lm-studio
  - model_name: google/gemma-4-26b-a4b
    litellm_params:
      model: openai/google/gemma-4-26b-a4b
      api_base: http://127.0.0.1:1234/v1
      api_key: lm-studio

general_settings:
  master_key: sk-local-proxy-key
```

### `~/bin/claude-local`

```bash
#!/bin/bash
# claude-local — launch Claude Code pointed at LM Studio via LiteLLM proxy.
# Terminal 1 (Bedrock):  claude
# Terminal 2 (local):    claude-local
# Override model:        ANTHROPIC_MODEL=google/gemma-4-31b claude-local

LITELLM_PORT=4000
LITELLM_CONFIG="$HOME/litellm_config.yaml"
LITELLM_KEY="sk-local-proxy-key"

_litellm_ready() {
  curl -sf -H "Authorization: Bearer ${LITELLM_KEY}" \
    "http://0.0.0.0:${LITELLM_PORT}/health" >/dev/null 2>&1
}

if ! _litellm_ready; then
  # Kill anything on the port so litellm binds 4000 (not a random port)
  lsof -ti tcp:${LITELLM_PORT} | xargs kill -9 2>/dev/null || true
  sleep 1
  echo "[claude-local] Starting LiteLLM proxy on port ${LITELLM_PORT}..."
  "$HOME/.local/bin/litellm" --config "$LITELLM_CONFIG" --port "$LITELLM_PORT" \
    >/tmp/litellm.log 2>&1 &
  for i in $(seq 1 15); do
    sleep 1
    if _litellm_ready; then echo "[claude-local] LiteLLM ready."; break; fi
  done
fi

exec env \
  CLAUDE_CODE_USE_BEDROCK="" \
  CLAUDE_CODE_USE_VERTEX="" \
  ANTHROPIC_BASE_URL="http://0.0.0.0:${LITELLM_PORT}" \
  ANTHROPIC_AUTH_TOKEN="${LITELLM_KEY}" \
  ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-qwen/qwen3.6-27b}" \
  ANTHROPIC_SMALL_FAST_MODEL="${ANTHROPIC_SMALL_FAST_MODEL:-nvidia/nemotron-3-nano}" \
  claude "$@"
```

---

## Unified MCP + Skills config

`mcps.json` is the local single source of truth for MCP servers across Claude Code and Codex. Copy `mcps.example.json` to `mcps.json` and put real tokens only in the ignored local file. `skills/` is the shared skills directory. After editing either, run:

```bash
bin/sync-configs.sh
```

This writes:
- `~/.claude.json` → `.mcpServers`
- `~/.codex/config.toml` → `[mcp_servers.*]`
- Symlinks `skills/<name>/` into `~/.claude/skills/` and `~/.codex/skills/`

Each server entry in `mcps.json` has a `targets` array controlling which CLIs receive it.

---

## Telegram Dispatch

`bin/telegram-dispatch.mjs` lets you message Saturn through a Telegram bot. It follows the OpenClaw-style pattern: a local gateway stays online, each chat maps to a persistent Saturn session, and users can keep texting naturally while work runs in the background.

It uses Telegram long polling, so the Mac does not need a public webhook URL. Incoming Telegram messages create or continue dashboard sessions through the existing `/api/sessions` endpoints; final assistant replies are sent back to Telegram. If a turn is already running, new messages are queued and sent to the same session in order.

### Setup

1. Create a bot with Telegram's `@BotFather` and copy the bot token.

2. Start the dashboard first:
   ```bash
   cd "/Users/zachrizzo/programming/ai harnnes/dashboard"
   AUTOMATIONS_ROOT="/Users/zachrizzo/programming/ai harnnes" npm run start
   ```

3. Run once in allow-all mode to discover your chat id:
   ```bash
   cd "/Users/zachrizzo/programming/ai harnnes"
   TELEGRAM_BOT_TOKEN="123:abc" \
   TELEGRAM_ALLOW_ALL=1 \
   SATURN_BASE_URL="http://127.0.0.1:3737" \
   node bin/telegram-dispatch.mjs
   ```
   Send `/start` to the bot, then stop the process and read `telegram/state.json` for the chat id.

4. Run with a chat allowlist:
   ```bash
   TELEGRAM_BOT_TOKEN="123:abc" \
   TELEGRAM_ALLOWED_CHAT_IDS="123456789" \
   SATURN_BASE_URL="http://127.0.0.1:3737" \
   SATURN_ADHOC_CLI="claude-bedrock" \
   SATURN_ADHOC_MODEL="claude-sonnet-4-6" \
   node bin/telegram-dispatch.mjs
   ```

Optional routing:
- `SATURN_AGENT_ID=research-deep-dive` starts new Telegram chats through a saved dashboard agent.
- Without `SATURN_AGENT_ID`, the bridge creates ad-hoc sessions using `SATURN_ADHOC_CLI`, `SATURN_ADHOC_MODEL`, `SATURN_ADHOC_PROMPT`, `SATURN_ADHOC_CWD`, `SATURN_ADHOC_ALLOWED_TOOLS`, and `SATURN_ADHOC_TIMEOUT_SECONDS`.

Telegram commands:
- `/new` or `/reset` clears the current Telegram chat's session mapping.
- `/new <task>` starts a fresh session immediately.
- `/status` shows the active session status.
- `/session` shows the dashboard session id.
- `/think <low|medium|high|xhigh>` sets reasoning for this Telegram chat.
- `/model <id>` sets the model for this Telegram chat.
- `/agent <id|off>` routes new sessions through a saved dashboard agent.
- `/verbose <on|off>` toggles dashboard links and extra run details.

State lives in `telegram/state.json` and includes the Telegram update offset, per-chat session id, queued messages, and per-chat settings. Delete that file to fully reset the bridge.

### launchd

Copy `launchd/com.zachrizzo.saturn-telegram-dispatch.plist` to `~/Library/LaunchAgents/`, edit the token and chat id values, then load it:

```bash
cp "/Users/zachrizzo/programming/ai harnnes/launchd/com.zachrizzo.saturn-telegram-dispatch.plist" ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.zachrizzo.saturn-telegram-dispatch.plist
```

Logs are written to:
- `runs/telegram-dispatch.log`
- `runs/telegram-dispatch.err.log`

---

## Layout

```
saturn/
├── mcps.example.json     # template for local MCP server config
├── skills/               # shared Claude + Codex skills (symlinked into both)
├── bin/
│   ├── run-job.sh        # cron wrapper — invokes the configured backend
│   ├── sync-configs.sh   # propagate mcps.json + skills/ to each CLI
│   └── register-job.sh   # sync jobs.json into crontab
├── jobs/jobs.example.json # template for local job registry
├── agents.example.json   # template for saved dashboard agents
├── runs/                 # runtime run data, ignored by git
├── sessions/             # runtime interactive chat sessions, ignored by git
├── tasks/                # runtime task ticketing storage, ignored by git
├── telegram/             # Telegram bridge state (created at runtime)
├── dashboard/            # Next.js UI, served at http://127.0.0.1:3737
└── launchd/com.zachrizzo.claude-cron-dashboard.plist
```

---

## One-time setup

1. **Create local config files**
   ```bash
   cp settings.example.json settings.json
   cp agents.example.json agents.json
   cp slices.example.json slices.json
   cp mcps.example.json mcps.json
   cp working-directories.example.json working-directories.json
   cp jobs/jobs.example.json jobs/jobs.json
   cp dashboard/.env.local.example dashboard/.env.local
   ```
   Edit `mcps.json` and `dashboard/.env.local` for your machine. These live files are ignored so secrets and local paths stay out of git.

2. **Install the dashboard as an always-on service**
   ```bash
   cp "/Users/zachrizzo/programming/ai harnnes/launchd/com.zachrizzo.claude-cron-dashboard.plist" ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.zachrizzo.claude-cron-dashboard.plist
   ```
   Visit http://127.0.0.1:3737 to confirm. Stop with:
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.zachrizzo.claude-cron-dashboard.plist
   ```

3. **Register the jobs defined in `jobs/jobs.json`**
   ```bash
   "/Users/zachrizzo/programming/ai harnnes/bin/register-job.sh"
   crontab -l    # verify the lines marked "# saturn:<name>"
   ```

---

## Adding a new job

Edit `jobs/jobs.json` to append an object with `name`, `cron`, `prompt`, `allowedTools`, and optional `description`, `cwd`. Then:

```bash
"/Users/zachrizzo/programming/ai harnnes/bin/register-job.sh"
```

## Testing a job manually

```bash
"/Users/zachrizzo/programming/ai harnnes/bin/run-job.sh" my-open-mrs
```

The run appears in `runs/my-open-mrs/<timestamp>/` and in the dashboard.

---

## Notes

- Cron jobs inherit a minimal environment. `run-job.sh` hardcodes `PATH`, `HOME`, and the claude binary location — edit it if your install moves.
- The dashboard re-reads the filesystem on every request, so new runs show up on refresh.
- Recurring tasks have no hard expiration; remove a line from `crontab -e` or delete from `jobs.json` and re-run `register-job.sh`.
- `claude-bedrock` injects `CLAUDE_CODE_USE_BEDROCK=1` plus AWS profile/region at dispatch time.
- `claude-personal` clears Bedrock, Vertex, LiteLLM, base URL, and auth-token env vars and uses Claude Code's `/login` auth path.
- `claude-local` points Claude Code at LiteLLM on port 4000 and never modifies the global config.
