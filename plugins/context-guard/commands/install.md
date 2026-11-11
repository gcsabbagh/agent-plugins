---
description: Install the context-guard statusline (--quiet for the /compact nudge only, --agy to install it for agy)
argument-hint: "[--quiet] [--agy]"
allowed-tools: Bash
---

Run the context-guard installer with the Bash tool, passing the user's arguments through:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" $ARGUMENTS
```

The supported options are `--quiet` and `--agy`. If the arguments above came through empty but the user asked for quiet mode, add `--quiet` yourself; if they asked to install it for agy (Antigravity CLI), add `--agy`.

Report the script's output to the user. If it succeeds, tell them to restart the app its last line names (Claude Code, or agy with `--agy`). If it fails because `jq` is missing, tell them to install `jq` and run `/context-guard:install` again. Do not edit `~/.claude/settings.json` or any `~/.gemini` file yourself.
