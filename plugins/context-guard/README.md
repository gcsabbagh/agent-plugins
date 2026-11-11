# context-guard

Shows context usage in the statusline. When context passes 50%, Claude is asked to suggest `/compact` at the next task boundary, with instruction text that keeps what the next step needs.

## What you get

Statusline:

```
Opus 5.5  ctx 63%  $1.23  +42 -7  main
```

It shows the model, context % (green under 50, yellow under 80, red at 80 and above), session cost, lines added and removed, and the git branch.

Prompt hook: at 50% or more, when Claude finishes a turn that closes a task (PR opened, fix confirmed, plan agreed), it ends with a line like:

```
/compact keep: PR #42 and its review comments, the two files changed in src/parser/, the decision to drop the legacy flag
```

Claude doesn't suggest it in the middle of debugging. Above 80% it also tells you to have it write the current state to a file first.

## Install

```
/plugin marketplace add gcsabbagh/perso
/plugin install context-guard@gcsabbagh-perso
/context-guard:install
```

Then restart Claude Code.

If you don't want the statusline, run `/context-guard:install --quiet` instead. Your current statusline stays as it is (or stays empty), and only the `/compact` nudge is active.

You need the last command because plugins can't set `statusLine`. The install script copies the statusline script to `~/.claude/context-guard/statusline.sh` and points `~/.claude/settings.json` at it. If you already had a `statusLine` command, it's saved to `~/.claude/context-guard/prev-statusline.sh` and keeps running. Its output is shown in quiet mode and dropped otherwise. The script also backs up `settings.json` to `settings.json.bak-context-guard`, next to the original. The backup is made on the first run only.

## Requirements

- `bash` (Git Bash on Windows)
- `jq` on your PATH (`brew install jq`, or `winget install jqlang.jq` on Windows)

## Configuration

`/context-guard:install --quiet`: no visible statusline, nudge only. Run `/context-guard:install` again to switch back.

`CONTEXT_GUARD_THRESHOLD` (default `50`): the context % at which the prompt hook starts nudging. Set it in the `env` block of `~/.claude/settings.json`.

## How it works

Only the statusline receives live context metrics, so the statusline script writes the current % to `${TMPDIR:-/tmp}/claude-ctx-<session_id>`. The `UserPromptSubmit` hook reads that file. When the % is at or above the threshold, it injects a short instruction as `additionalContext`.

## Uninstall

```
/plugin uninstall context-guard@gcsabbagh-perso
```

Then restore `statusLine` in `~/.claude/settings.json` from `settings.json.bak-context-guard`, or delete the key.
