#!/usr/bin/env bash
# context-guard one-line installer: downloads a context-guard release from
# GitHub and runs its install.sh, with no clone.
#   curl -fsSL https://raw.githubusercontent.com/gcsabbagh/agent-plugins/main/plugins/context-guard/scripts/get.sh | bash -s -- --agy
# Usage: get.sh [--version X.Y.Z] [--agy-plugin] [install.sh options]
#   --version     install that release instead of the latest one
#   --agy-plugin  install it as an agy plugin (agy plugin install), then run the
#                 installer from the installed plugin, which implies --agy
# Everything else goes to install.sh (--agy, --claude, --nudge-only).
# On Windows, use get.ps1 from PowerShell, or run this from Git Bash.
set -euo pipefail

# Everything runs from main, called on the last line, so a partial download
# through a pipe never runs.
main() {
  local repo="${CONTEXT_GUARD_REPO:-gcsabbagh/agent-plugins}"
  # Overridable so the tests can serve releases locally.
  local releases_url="${CONTEXT_GUARD_RELEASES_URL:-https://api.github.com/repos/$repo/releases?per_page=100}"
  local archive_base="${CONTEXT_GUARD_ARCHIVE_BASE:-https://github.com/$repo/archive/refs/tags}"

  local version="" agy_plugin=false args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || fail "--version needs a version, e.g. --version 1.1.0"; version=$2; shift 2 ;;
      --version=*) version=${1#--version=}; shift ;;
      --agy-plugin) agy_plugin=true; shift ;;
      *) args+=("$1"); shift ;;
    esac
  done

  local tool
  for tool in curl tar jq; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is required. Install it and run again."
  done

  local tag
  if [ -n "$version" ]; then
    tag="context-guard@$version"
  else
    # The repo's "latest release" may be another plugin's, so pick the newest
    # published context-guard@ release.
    tag=$(curl -fsSL "$releases_url" | jq -r '
      [.[] | select((.tag_name | startswith("context-guard@")) and (.draft | not) and (.prerelease | not))]
      | first | .tag_name // empty') || fail "couldn't list releases from $releases_url"
    [ -n "$tag" ] || fail "no context-guard release found at $releases_url"
  fi

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  echo "context-guard: downloading $tag" >&2
  curl -fsSL -o "$tmp/src.tar.gz" "$archive_base/$tag.tar.gz" || fail "couldn't download $tag from $archive_base"
  # Relative paths: Git Bash's tar reads "C:/..." as a remote host.
  mkdir "$tmp/src"
  (cd "$tmp" && tar -xzf src.tar.gz --strip-components=1 -C src) || fail "couldn't unpack $tag"
  local plugin="$tmp/src/plugins/context-guard"
  [ -f "$plugin/scripts/install.sh" ] || fail "$tag has no plugins/context-guard/scripts/install.sh"

  # stdin is this script when piped, so keep the children off it.
  if $agy_plugin; then
    command -v agy >/dev/null 2>&1 || fail "agy not found on PATH, which --agy-plugin needs."
    local src="$plugin"
    case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) src=$(cygpath -w "$plugin") ;; esac
    agy plugin install "$src" </dev/null || fail "agy plugin install failed"
    bash "$HOME/.gemini/config/plugins/context-guard/scripts/install.sh" --agy ${args[@]+"${args[@]}"} </dev/null
  else
    bash "$plugin/scripts/install.sh" ${args[@]+"${args[@]}"} </dev/null
    case " ${args[*]-} " in *" --agy "*) ;; *)
      echo "context-guard: in Claude Code the nudge hook comes with the plugin: /plugin marketplace add $repo, then /plugin install context-guard@gcsabbagh-agent-plugins" >&2 ;;
    esac
  fi
}

fail() { echo "context-guard: $*" >&2; exit 1; }

main "$@"
