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

This repo is a Claude Code marketplace. Each plugin entry is pinned to the plugin's latest release tag:

```
/plugin marketplace add gcsabbagh/agent-plugins
/plugin install <plugin>@gcsabbagh-agent-plugins
```

## Tests

```
npm ci
npm test
```

Runs every plugin's `test/*.test.mjs`, plus the release tooling's tests in `test/`, with Node's built-in test runner (Node 22 or later). See each plugin's README for what its tests need. CI runs them on Ubuntu, macOS and Windows for every push and pull request.

## Releasing

`main` is the trunk. Releases are versioned with [Changesets](https://changesets.dev) and tagged `<plugin>@<version>`. Users get releases, not `main`:

- **One-line installs:** they download the latest release.
- **Claude Code:** the marketplace entry points at the release tag.

Each plugin keeps its version in `plugins/<plugin>/package.json`. A release copies it into the plugin's manifests and the marketplace entry.

1. **With each change users should hear about,** run `npm run changeset`. Pick the plugin and the bump (patch, minor or major), write a summary for users, and commit the generated `.changeset/*.md` file with the change. The summary becomes the plugin's `CHANGELOG.md` entry and its release notes.
2. **Push to `main`.** Once the tests pass on all three systems, CI releases any pending changesets: it commits "Version packages" to `main`, tags each bumped plugin, and creates its GitHub release. A push with no changesets releases nothing.

To release from your machine instead, run `npm run release` with `gh` signed in. It does the same steps, and CI then finds nothing left to do. `npm run release -- --publish` skips the versioning and only tags and releases what's untagged.

## License

[MIT](LICENSE)
