---
description: Install context-guard's status line for Claude Code, or for agy with --agy (--quiet for the /compact nudge only)
argument-hint: "[--agy | --claude] [--quiet]"
allowed-tools: Bash
---

Run the context-guard installer with the Bash tool, passing the user's arguments through:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" $ARGUMENTS
```

The supported options are `--agy`, `--claude` and `--quiet`. With no agent flag, the installer targets Claude Code. If the arguments above came through empty but the user asked for quiet mode, add `--quiet` yourself; if they asked to install it for agy (Antigravity CLI), add `--agy`.

Report the script's output to the user. If it succeeds, tell them to restart the app its last line names (Claude Code, or agy with `--agy`). If it fails because `jq` is missing, tell them to install `jq` and run `/context-guard:install` again. Do not edit `~/.claude/settings.json` or any `~/.gemini` file yourself.
