#!/usr/bin/env bash
# context-guard UserPromptSubmit hook. Reads the context % written by the
# statusline and, at or above the threshold, asks Claude to suggest /compact
# at the next task boundary.

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' | tr -d '\r')
[ -n "$session_id" ] || exit 0

file="${TMPDIR:-/tmp}/claude-ctx-$session_id"
[ -f "$file" ] || exit 0
pct=$(tr -dc '0-9' < "$file")
[ -n "$pct" ] || exit 0

threshold="${CONTEXT_GUARD_THRESHOLD:-50}"
case "$threshold" in ''|*[!0-9]*) threshold=50 ;; esac
[ "$pct" -ge "$threshold" ] || exit 0

msg="context-guard: context window is at ${pct}%. If the turn you are about to finish closes a task (PR opened, fix confirmed, plan agreed), end your reply with one line the user can copy, in the form:
/compact keep: <what the next step needs: open PRs or issues, files changed, decisions made, open questions>
Be specific (numbers, paths, names). Do not suggest it mid-task, such as in the middle of debugging or an unfinished change; keep working and suggest it at the next boundary. Suggest it at most once per task."

if [ "$pct" -ge 80 ]; then
  msg="${msg}
Context is above 80%: before the /compact line, also tell the user to have you write the current state (goal, progress, next steps) to a file first, so nothing is lost if compaction drops detail."
fi

jq -n --arg ctx "$msg" '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $ctx}}'
