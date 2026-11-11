#!/usr/bin/env bash
# context-guard installer. Pick the agent with a flag; with none, it installs
# for Claude Code, which /context-guard:install in Claude Code relies on.
#   agy (--agy): points ~/.gemini/antigravity-cli/settings.json at the
#     statusline. If the agy plugin is installed (agy plugin install), its
#     scripts and hook are used as they are; otherwise the scripts are copied
#     into ~/.gemini/context-guard and the prompt hook is registered in
#     ~/.gemini/config/hooks.json.
#   Claude Code (--claude): plugins cannot set statusLine, so this copies the
#     statusline script into ~/.claude/context-guard and points settings.json
#     at it. The prompt hook ships with the plugin.
# Usage: install.sh [--agy | --claude] [--nudge-only]
set -euo pipefail

self="${BASH_SOURCE[0]//\\//}"  # dirname doesn't split backslash paths
SCRIPT_DIR="$(cd "$(dirname "$self")" && pwd)"

mode=full
target=claude
for arg in "$@"; do
  case "$arg" in
    --nudge-only) mode=nudge-only ;;
    --agy) target=agy ;;
    --claude) target=claude ;;
    "") ;;
    *) echo "context-guard: unknown option '$arg' (supported: --agy, --claude, --nudge-only)" >&2; exit 2 ;;
  esac
done

# CG_DIR holds state (mode, previous statusline). RUN_DIR holds the scripts the
# app runs, which COPY lists the files to copy there.
AGY_PLUGIN="$HOME/.gemini/config/plugins/context-guard"
if [ "$target" = claude ]; then
  app="Claude Code"
  CG_DIR="$HOME/.claude/context-guard"
  SETTINGS="$HOME/.claude/settings.json"
  HOOKS=""
  RUN_DIR="$CG_DIR"
  COPY=(statusline.sh)
else
  app="agy"
  CG_DIR="$HOME/.gemini/context-guard"
  SETTINGS="$HOME/.gemini/antigravity-cli/settings.json"
  HOOKS="$HOME/.gemini/config/hooks.json"
  if [ -f "$AGY_PLUGIN/.antigravity-plugin/plugin.json" ]; then
    RUN_DIR="$AGY_PLUGIN/scripts"
    COPY=()
  else
    RUN_DIR="$CG_DIR"
    COPY=(statusline.sh prompt-hook.sh agy.cmd)
  fi
fi

# In PowerShell or cmd on Windows, `bash` is usually WSL's, which would install
# into the Linux home instead of the Windows one. When this script is on a
# Windows drive, hand off to install.ps1, which finds Git Bash. Otherwise stop.
if grep -qi microsoft /proc/version 2>/dev/null && [ -d /mnt/c ]; then
  ps1=$(wslpath -w "$SCRIPT_DIR/install.ps1" 2>/dev/null || echo "$SCRIPT_DIR/install.ps1")
  case "$ps1" in [A-Za-z]:\\*)
    if command -v powershell.exe >/dev/null 2>&1; then
      echo "context-guard: this is WSL's bash, so running the Windows installer instead: $ps1" >&2
      cd "$SCRIPT_DIR"  # from a Linux cwd, powershell.exe warns about UNC paths
      exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$ps1" "$@"
    fi ;;
  esac
  echo "context-guard: this is WSL's bash, so it would install into WSL, not Windows. From PowerShell, run:" >&2
  echo "  & \"$ps1\"${*:+ $*}" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "context-guard: jq is required. Install it (brew install jq / winget install jqlang.jq) and run again." >&2
  exit 1
fi

windows=false
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) windows=true ;; esac

# Prints the command that runs one of the scripts in RUN_DIR from the target app.
# agy on Windows runs commands through cmd /c, where `bash` is usually WSL's and
# quoted paths get mangled, so it goes through the agy.cmd launcher (which also
# sets CONTEXT_GUARD_DIR).
script_cmd() { # <name> [args]
  local name=$1; shift
  local args="${*:+ $*}"
  if [ "$target" = agy ] && $windows; then
    local launcher
    launcher=$(cygpath -m "$RUN_DIR/agy.cmd")
    case "$launcher" in *' '*)
      echo "context-guard: $launcher contains a space, which agy can't run. Not installing." >&2; exit 1 ;;
    esac
    printf '%s %s%s\n' "$launcher" "$name" "$args"
  else
    # The ~ comes from a variable: bash 3.2 (macOS) keeps the backslash of a
    # literal \~, and newer bash expands a bare ~ back to $HOME.
    local env="" tilde='~'
    [ "$RUN_DIR" = "$CG_DIR" ] || env="CONTEXT_GUARD_DIR=${CG_DIR/#$HOME/$tilde} "
    printf '%sbash %s/%s.sh%s\n' "$env" "${RUN_DIR/#$HOME/$tilde}" "$name" "$args"
  fi
}

# Reads a JSON file, dropping a UTF-8 BOM, which jq rejects.
# (Octal via printf, since BSD sed on macOS has no \x escapes.)
BOM=$(printf '\357\273\277')
read_json() { sed "1s/^$BOM//" "$1"; }

# Prepares a JSON config for editing: creates it, validates it, backs it up once
# (so the backup is always the pre-context-guard version).
prepare_json() {
  mkdir -p "$(dirname "$1")"
  [ -s "$1" ] || echo '{}' > "$1"
  read_json "$1" | jq empty 2>/dev/null || { echo "context-guard: $1 is not valid JSON; not touching it." >&2; exit 1; }
  [ -f "$1.bak-context-guard" ] || cp "$1" "$1.bak-context-guard"
}

# Applies a jq filter to a JSON file in place: update_json <file> <filter> [jq args].
update_json() {
  local file=$1 filter=$2 tmp; shift 2
  tmp=$(mktemp "$file.XXXXXX")
  read_json "$file" | jq "$@" "$filter" > "$tmp"
  mv "$tmp" "$file"
}

mkdir -p "$CG_DIR"
prev_mode=$(cat "$CG_DIR/mode" 2>/dev/null || true)
# ${COPY[@]+...}: bash 3.2 (macOS) treats an empty array as unset under set -u.
for f in ${COPY[@]+"${COPY[@]}"}; do cp "$SCRIPT_DIR/$f" "$RUN_DIR/$f"; done
printf '%s\n' "$mode" > "$CG_DIR/mode"

prepare_json "$SETTINGS"
[ -n "$HOOKS" ] && prepare_json "$HOOKS"

current=$(read_json "$SETTINGS" | jq -r '.statusLine.command // empty' | tr -d '\r')
if [ -n "$current" ] && [[ "$current" != *context-guard/*statusline* ]]; then
  { echo '#!/usr/bin/env bash'
    echo '# Previous statusLine command, kept by context-guard. Receives the same stdin.'
    if [ "$target" = agy ] && $windows; then
      # agy ran it through cmd, so keep running it there.
      printf '@%s\r\n' "$current" > "$CG_DIR/prev-statusline.cmd"
      echo 'cmd //c "$(cygpath -w "${BASH_SOURCE[0]%.sh}.cmd")"'
    else
      printf '%s\n' "$current"
    fi
  } > "$CG_DIR/prev-statusline.sh"
  echo "context-guard: kept previous statusline in $CG_DIR/prev-statusline.sh"
fi

statusline_cmd=$(script_cmd statusline)
# In nudge-only mode agy would otherwise show an empty line in place of its
# own; switching back to full undoes that.
update_json "$SETTINGS" '.statusLine = ((.statusLine // {}) + {type: "command", command: $cmd})
  | if $target != "agy" then .
    elif $mode == "nudge-only" then .statusLine.stack_with_default = true
    elif $prev_mode == "nudge-only" then del(.statusLine.stack_with_default)
    else . end' \
  --arg cmd "$statusline_cmd" --arg target "$target" --arg mode "$mode" --arg prev_mode "$prev_mode"
echo "context-guard: installed (mode: $mode). statusLine -> $statusline_cmd"

if [ -n "$HOOKS" ] && [ "$RUN_DIR" != "$CG_DIR" ]; then
  # The plugin brings its own hook; drop one left from a script install.
  update_json "$HOOKS" 'del(.["context-guard"])'
  echo "context-guard: using the agy plugin's hook from $AGY_PLUGIN"
elif [ -n "$HOOKS" ]; then
  hook_cmd=$(script_cmd prompt-hook --agy)
  update_json "$HOOKS" '.["context-guard"] = {PreInvocation: [{type: "command", command: $cmd, timeout: 10}]}' --arg cmd "$hook_cmd"
  echo "context-guard: PreInvocation hook in $HOOKS -> $hook_cmd"
fi

echo "context-guard: settings backup at $SETTINGS.bak-context-guard"
echo "context-guard: restart $app to apply."
