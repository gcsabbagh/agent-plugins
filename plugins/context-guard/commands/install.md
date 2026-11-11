---
description: Install the context-guard statusline (pass --quiet for the /compact nudge only)
argument-hint: "[--quiet]"
allowed-tools: Bash
---

Run the context-guard installer with the Bash tool, passing the user's arguments through:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" $ARGUMENTS
```

The only supported option is `--quiet`. If the arguments above came through empty but the user asked for quiet mode, add `--quiet` yourself.

Report the script's output to the user. If it succeeds, tell them to restart Claude Code. If it fails because `jq` is missing, tell them to install `jq` and run `/context-guard:install` again. Do not edit `~/.claude/settings.json` yourself.
