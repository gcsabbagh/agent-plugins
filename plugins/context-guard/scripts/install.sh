#!/usr/bin/env bash
# context-guard installer. Plugins cannot set statusLine, so this copies the
# statusline script into ~/.claude/context-guard and points settings.json at it.
# Usage: install.sh [--quiet]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
CG_DIR="$CLAUDE_DIR/context-guard"
SETTINGS="$CLAUDE_DIR/settings.json"
BACKUP="$SETTINGS.bak-context-guard"
OUR_CMD="bash ~/.claude/context-guard/statusline.sh"

mode=full
for arg in "$@"; do
  case "$arg" in
    --quiet|-q) mode=quiet ;;
    "") ;;
    *) echo "context-guard: unknown option '$arg' (only --quiet is supported)" >&2; exit 2 ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  echo "context-guard: jq is required. Install it (brew install jq / winget install jqlang.jq) and run again." >&2
  exit 1
fi

mkdir -p "$CG_DIR"
cp "$SCRIPT_DIR/statusline.sh" "$CG_DIR/statusline.sh"
printf '%s\n' "$mode" > "$CG_DIR/mode"

[ -s "$SETTINGS" ] || echo '{}' > "$SETTINGS"
jq empty "$SETTINGS" 2>/dev/null || { echo "context-guard: $SETTINGS is not valid JSON; not touching it." >&2; exit 1; }

# Back up once, so the backup is always the pre-context-guard version.
[ -f "$BACKUP" ] || cp "$SETTINGS" "$BACKUP"

current=$(jq -r '.statusLine.command // empty' "$SETTINGS" | tr -d '\r')
if [ -n "$current" ] && [[ "$current" != *context-guard/statusline.sh* ]]; then
  { echo '#!/usr/bin/env bash'
    echo '# Previous statusLine command, kept by context-guard. Receives the same stdin.'
    printf '%s\n' "$current"
  } > "$CG_DIR/prev-statusline.sh"
  echo "context-guard: kept previous statusline in $CG_DIR/prev-statusline.sh"
fi

tmp=$(mktemp "$SETTINGS.XXXXXX")
jq --arg cmd "$OUR_CMD" '.statusLine = ((.statusLine // {}) + {type: "command", command: $cmd})' "$SETTINGS" > "$tmp"
mv "$tmp" "$SETTINGS"

echo "context-guard: installed (mode: $mode). statusLine -> $OUR_CMD"
echo "context-guard: settings backup at $BACKUP"
echo "context-guard: restart Claude Code to apply."
