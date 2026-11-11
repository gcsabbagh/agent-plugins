#!/usr/bin/env bash
# context-guard statusline. Installed to ~/.claude/context-guard/ (Claude Code)
# or ~/.gemini/context-guard/ (agy); both send the same statusline JSON on stdin.
# Records context % for the prompt hook, runs any previous statusline, and
# prints one line.

# State (mode, previous statusline) lives next to the installed copy, unless
# CONTEXT_GUARD_DIR says otherwise (the agy plugin runs from its own folder).
# agy's Windows launcher passes backslash paths, which dirname doesn't split.
if [ -n "${CONTEXT_GUARD_DIR:-}" ]; then
  CG_DIR="${CONTEXT_GUARD_DIR//\\//}"
else
  self="${BASH_SOURCE[0]//\\//}"
  CG_DIR="$(cd "$(dirname "$self")" && pwd)"
fi
input=$(cat)

command -v jq >/dev/null 2>&1 || { echo "context-guard: jq not found"; exit 0; }

# Previous statusline: always run (it may have side effects), show only in quiet mode.
prev_out=""
if [ -f "$CG_DIR/prev-statusline.sh" ]; then
  prev_out=$(printf '%s' "$input" | bash "$CG_DIR/prev-statusline.sh" 2>/dev/null)
fi

# Unit separator, not tab: tabs are IFS whitespace, so empty fields would collapse.
# tr strips the CR that jq on Windows adds.
IFS=$'\x1f' read -r session_id model pct cost added removed dir < <(
  printf '%s' "$input" | jq -r '
    def pct:
      if (.context_window.used_percentage // null) != null then .context_window.used_percentage
      elif (.context_window.current_usage // null) != null and (.context_window.context_window_size // 0) > 0 then
        ((.context_window.current_usage
          | (.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0))
         * 100 / .context_window.context_window_size)
      else "" end;
    # Claude Code sends cost as an object; agy sends null or a bare number and
    # has no line counts. Missing fields come out empty and are not shown.
    (.cost | if type == "object" then . elif type == "number" then {total_cost_usd: .} else {} end) as $cost |
    [ (.session_id // ""),
      (.model.display_name // .model.id // "?"),
      (pct | if . == "" then "" else floor end),
      ($cost.total_cost_usd // ""),
      ($cost.total_lines_added // ""),
      ($cost.total_lines_removed // ""),
      (.workspace.current_dir // .cwd // "")
    ] | map(tostring) | join("\u001f")' | tr -d '\r'
)

if [ -n "$session_id" ] && [ -n "$pct" ]; then
  printf '%s\n' "$pct" > "${TMPDIR:-/tmp}/claude-ctx-$session_id" 2>/dev/null
fi

if [ "$(cat "$CG_DIR/mode" 2>/dev/null)" = "quiet" ]; then
  [ -n "$prev_out" ] && printf '%s\n' "$prev_out"
  exit 0
fi

reset=$'\033[0m'; dim=$'\033[2m'; green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'; cyan=$'\033[36m'

if [ -z "$pct" ]; then
  ctx="${dim}ctx --${reset}"
else
  # Yellow from the nudge threshold (same default and validation as the prompt
  # hook), red from 80, where the hook also asks to save state first.
  threshold="${CONTEXT_GUARD_THRESHOLD:-50}"
  case "$threshold" in ''|*[!0-9]*) threshold=50 ;; esac
  if   [ "$pct" -ge 80 ]; then c=$red
  elif [ "$pct" -ge "$threshold" ]; then c=$yellow
  else c=$green; fi
  ctx="${c}ctx ${pct}%${reset}"
fi


branch=""
if [ -n "$dir" ]; then
  branch=$(git -C "$dir" --no-optional-locks branch --show-current 2>/dev/null)
fi

line="${model}  ${ctx}"
[ -n "$cost" ] && line="${line}  $(printf '$%.2f' "$cost" 2>/dev/null || printf '$%s' "$cost")"
[ -n "$added$removed" ] && line="${line}  ${green}+${added:-0}${reset} ${red}-${removed:-0}${reset}"
[ -n "$branch" ] && line="${line}  ${cyan}${branch}${reset}"
printf '%s\n' "$line"
