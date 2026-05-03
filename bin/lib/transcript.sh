#!/bin/bash
# transcript.sh — replay-prompt construction for CLI switches.
#
# Sourced by run-turn.sh. When the caller switches CLIs mid-session (or the
# previous turn has no native session id), the new CLI has no memory of the
# prior conversation. We synthesize a "prior transcript" string from the
# session's meta.json so the new CLI can pick up where the old one left off.

if [[ -n "${SATURN_TRANSCRIPT_SH_LOADED:-}" ]]; then
  return 0
fi
SATURN_TRANSCRIPT_SH_LOADED=1

# saturn_build_transcript_text <meta-file> [<max-turns>] [<max-chars-per-field>]
#
# Echoes a multi-turn transcript built from the session's `turns[]` array.
# Each entry is rendered as
#
#   Turn <n> [cli=<cli>, status=<status>]
#   User: <user_message, truncated>
#
#   Assistant: <final_text, truncated>
#
# Defaults: keep the last 12 turns; truncate any field longer than 16K chars.
# Aborted turns get an explicit "[interrupted]" marker; turns with no
# final_text get a "[no final assistant response recorded]" placeholder.
saturn_build_transcript_text() {
  local meta_file="$1"
  local max_turns="${2:-${SATURN_TRANSCRIPT_MAX_TURNS:-12}}"
  local max_chars="${3:-${SATURN_TRANSCRIPT_FIELD_MAX_CHARS:-16000}}"

  jq -r --argjson max_turns "$max_turns" --argjson max_chars "$max_chars" '
    def trunc($n):
      if type == "string" and length > $n
      then .[0:$n] + "\n\n[truncated " + ((length - $n) | tostring) + " chars]"
      else .
      end;
    (.turns | length) as $total
    | (.turns | if length > $max_turns then .[(length - $max_turns):] else . end) as $turns
    | ($total - ($turns | length)) as $offset
    | $turns
    | to_entries[]
    | .key as $idx
    | .value as $turn
    | "Turn \($offset + $idx + 1) [cli=\($turn.cli // "unknown"), status=\($turn.status // "unknown")]"
      + "\nUser: " + (($turn.user_message // "") | trunc(($max_chars / 2) | floor))
      + "\n\nAssistant: "
      + (if (($turn.final_text // "") | length) > 0
         then (($turn.final_text // "") | trunc($max_chars))
              + (if ($turn.status // "") == "aborted"
                 then "\n\n[assistant response was interrupted before completion]"
                 else ""
                 end)
         else "[no final assistant response recorded; turn status was \($turn.status // "unknown")]"
         end)
  ' "$meta_file"
}

# saturn_build_replay_prompt <agent-block> <prev-cli> <new-cli> <transcript> <user-message>
#
# Composes the full replay-mode prompt: optional agent block (system prompt +
# Saturn CLI instructions), the framing/instructions block, the transcript,
# and the newest user request. Echoes the prompt to stdout so the caller can
# capture it into a single variable.
saturn_build_replay_prompt() {
  local agent_block="$1"
  local prev_cli="${2:-unknown}"
  local new_cli="$3"
  local transcript="$4"
  local user_message="$5"

  local agent_line=""
  if [[ -n "$agent_block" ]]; then
    agent_line="$agent_block

---

"
  fi

  printf '%s' "${agent_line}You are continuing an existing Saturn chat after a CLI/context switch.

You do not have native memory for this conversation. The transcript below is the authoritative prior context. Preserve prior conclusions, file paths, URLs, tool results, and stated next actions.

Important:
- The newest user request after the transcript is the active task.
- Do not restart an earlier task just because it appears in the transcript.
- If the newest user request says \"do this\", \"fix it\", or \"do all of this\", resolve that reference from the most recent non-empty assistant response in the transcript and then perform the requested work.
- If a prior turn was aborted or has no final response, treat it as incomplete context only.
- Before your final answer, sanity check that you are answering the newest user request, not replaying an older one.

Previous CLI: ${prev_cli}
Current CLI: ${new_cli}

Prior transcript:

${transcript}

---

Newest user request:
${user_message}"
}
