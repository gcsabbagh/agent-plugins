#!/usr/bin/env bash
# context-guard statusline. Installed to ~/.claude/context-guard/statusline.sh.
# Reads Claude Code's statusline JSON on stdin, records context % for the
# prompt hook, runs any previous statusline, and prints one line.

CG_DIR="$HOME/.claude/context-guard"
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
    [ (.session_id // ""),
      (.model.display_name // .model.id // "?"),
      (pct | if . == "" then "" else floor end),
      (.cost.total_cost_usd // 0),
      (.cost.total_lines_added // 0),
      (.cost.total_lines_removed // 0),
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
  if   [ "$pct" -lt 50 ]; then c=$green
  elif [ "$pct" -lt 80 ]; then c=$yellow
  else c=$red; fi
  ctx="${c}ctx ${pct}%${reset}"
fi

cost_fmt=$(printf '$%.2f' "$cost" 2>/dev/null || printf '$%s' "$cost")

branch=""
if [ -n "$dir" ]; then
  branch=$(git -C "$dir" --no-optional-locks branch --show-current 2>/dev/null)
fi

line="${model}  ${ctx}  ${cost_fmt}  ${green}+${added}${reset} ${red}-${removed}${reset}"
[ -n "$branch" ] && line="${line}  ${cyan}${branch}${reset}"
printf '%s\n' "$line"
