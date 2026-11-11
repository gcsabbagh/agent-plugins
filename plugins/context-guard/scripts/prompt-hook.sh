#!/usr/bin/env bash
# context-guard prompt hook. Reads the context % written by the statusline and,
# at or above the threshold, asks the agent to suggest /compact at the next
# task boundary.
#   Claude Code: UserPromptSubmit hook (no arguments).
#   agy:         PreInvocation hook, run with --agy. agy expects JSON on stdout
#                every time and runs this before every model call, so it only
#                injects on the first call of a turn (invocationNum 0).

agy=false
[ "${1:-}" = "--agy" ] && agy=true

done_noop() { $agy && echo '{}'; exit 0; }

command -v jq >/dev/null 2>&1 || done_noop

input=$(cat)
# tr strips the CR that jq on Windows adds.
IFS=$'\x1f' read -r session_id invocation < <(
  printf '%s' "$input" | jq -r '[(.session_id // .conversationId // ""), (.invocationNum // 0)] | map(tostring) | join("\u001f")' | tr -d '\r'
)
[ -n "$session_id" ] || done_noop
[ "$invocation" = "0" ] || done_noop

file="${TMPDIR:-/tmp}/claude-ctx-$session_id"
[ -f "$file" ] || done_noop
pct=$(tr -dc '0-9' < "$file")
[ -n "$pct" ] || done_noop

threshold="${CONTEXT_GUARD_THRESHOLD:-50}"
case "$threshold" in ''|*[!0-9]*) threshold=50 ;; esac
[ "$pct" -ge "$threshold" ] || done_noop

# Claude's /compact takes instructions for the summary; agy's takes a message
# it answers right after compacting, so the line is phrased as the next prompt.
if $agy; then
  compact_line='/compact Next: <the next step>. Keep in mind: <what it needs: open PRs or issues, files changed, decisions made, open questions>'
else
  compact_line='/compact keep: <what the next step needs: open PRs or issues, files changed, decisions made, open questions>'
fi

msg="context-guard: context window is at ${pct}%. If the turn you are about to finish closes a task (PR opened, fix confirmed, plan agreed), end your reply with one line the user can copy, in the form:
${compact_line}
Be specific (numbers, paths, names). Do not suggest it mid-task, such as in the middle of debugging or an unfinished change; keep working and suggest it at the next boundary. Suggest it at most once per task."

if [ "$pct" -ge 80 ]; then
  msg="${msg}
Context is above 80%: before the /compact line, also tell the user to have you write the current state (goal, progress, next steps) to a file first, so nothing is lost if compaction drops detail."
fi

if $agy; then
  jq -n --arg ctx "$msg" '{injectSteps: [{systemMessage: {systemMessage: $ctx}}]}'
else
  jq -n --arg ctx "$msg" '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $ctx}}'
fi
