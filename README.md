# agent-plugins

Plugins for [Claude Code](https://claude.com/claude-code) and agy (Antigravity CLI).

| Plugin | What it does | Claude Code | agy |
|---|---|---|---|
| [context-guard](plugins/context-guard) | Context usage in the statusline, plus a `/compact` nudge at task boundaries once context passes a threshold | ✓ | ✓ |

## Install

Claude Code:

```
/plugin marketplace add gcsabbagh/agent-plugins
/plugin install <plugin>@gcsabbagh-agent-plugins
```

agy: each plugin's README explains how to install it. Some plugins also need a setup step for things agy plugins can't do themselves.

## Tests

```
npm test
```

Runs every plugin's `test/*.test.mjs` with Node's built-in test runner (Node 22 or later). See each plugin's README for what its tests need.

## License

[MIT](LICENSE)
