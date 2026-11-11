# agent-plugins

Plugins for coding agents. Currently supported: agy (Antigravity CLI) and [Claude Code](https://claude.com/claude-code). Plugins share their scripts across agents, so adding an agent doesn't mean another copy of each plugin.

| Plugin | What it does | agy | Claude Code |
|---|---|---|---|
| [context-guard](plugins/context-guard) | Context usage in the status line, plus a `/compact` nudge at task boundaries once context passes a threshold | ✓ | ✓ |

## Install

Each plugin's README has the full steps for every agent it supports. Some plugins also need a setup step for things an agent's plugins can't do themselves, such as setting the status line.

### agy

Plugins come with a one-line install that downloads their latest release, so no clone is needed. Each plugin's README has the command. Releases are tagged `<plugin>@<version>`. From a clone, `agy plugin install plugins/<plugin>` also works.

### Claude Code

This repo is a Claude Code marketplace:

```
/plugin marketplace add gcsabbagh/agent-plugins
/plugin install <plugin>@gcsabbagh-agent-plugins
```

## Tests

```
npm test
```

Runs every plugin's `test/*.test.mjs` with Node's built-in test runner (Node 22 or later). See each plugin's README for what its tests need.

## License

[MIT](LICENSE)
