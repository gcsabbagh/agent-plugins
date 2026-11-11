// Tests for scripts/release.mjs and scripts/sync-versions.mjs: the whole
// Changesets release in a throwaway repo, with a bare repo as origin and a
// fake gh that records what it would create.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changelogEntry } from '../scripts/release.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasChangesets = fs.existsSync(path.join(repoRoot, 'node_modules', '@changesets', 'cli', 'bin.js'));

describe('changelogEntry', () => {
  const changelog = '# demo\r\n\r\n## 1.1.0\r\n\r\n### Patch Changes\r\n\r\n- Newer.\r\n\r\n## 1.0.0\r\n\r\n- Older.\r\n';
  test('returns one version section without its heading', () => {
    assert.equal(changelogEntry(changelog, '1.1.0'), '### Patch Changes\n\n- Newer.');
    assert.equal(changelogEntry(changelog, '1.0.0'), '- Older.');
  });
  test('missing version: null', () => {
    assert.equal(changelogEntry(changelog, '9.9.9'), null);
  });
});

describe('npm run release', { skip: !hasChangesets && 'run npm ci first' }, () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
    const work = path.join(dir, 'work'), remote = path.join(dir, 'remote.git');
    const git = (cwd, ...args) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
    fs.mkdirSync(work);
    git(work, 'init', '--quiet', '--initial-branch=main');
    git(work, 'config', 'user.name', 'test');
    git(work, 'config', 'user.email', 'test@example.invalid');
    git(work, 'config', 'core.autocrlf', 'false');
    git(work, 'remote', 'add', 'origin', remote);

    const write = (rel, data) => {
      fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
      fs.writeFileSync(path.join(work, rel), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
    };
    write('package.json', { name: 'root', private: true, workspaces: ['plugins/*'] });
    write('.gitignore', 'node_modules/\n');
    for (const f of ['.changeset/config.json', '.changeset/README.md', 'scripts/release.mjs', 'scripts/sync-versions.mjs']) {
      write(f, fs.readFileSync(path.join(repoRoot, f), 'utf8'));
    }
    write('plugins/demo/package.json', { name: 'demo', version: '1.0.0', private: true });
    write('plugins/demo/.claude-plugin/plugin.json', { name: 'demo', version: '1.0.0', description: 'kept as is', repository: 'https://github.com/example/plugins' });
    write('.claude-plugin/marketplace.json', { name: 'example', owner: { name: 'x' }, plugins: [{ name: 'demo', description: 'd', source: './plugins/demo' }, { name: 'other', source: './plugins/other' }] });
    write('plugins/demo/.antigravity-plugin/plugin.json', { name: 'demo', version: '1.0.0' });
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(work, 'node_modules'), 'junction');

    // The version script, as the root package.json defines it.
    const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    write('package.json', { name: 'root', private: true, workspaces: ['plugins/*'], scripts: { 'version-packages': rootPkg.scripts['version-packages'] } });
    // Changesets finds npm workspaces through the lockfile.
    write('package-lock.json', { name: 'root', lockfileVersion: 3, requires: true, packages: { '': { name: 'root', workspaces: ['plugins/*'] } } });

    git(work, 'add', '--all');
    git(work, 'commit', '--quiet', '-m', 'init');
    git(work, 'push', '--quiet', '-u', 'origin', 'main');

    const ghLog = path.join(dir, 'gh.log');
    const fakeGh = path.join(dir, 'fake-gh.mjs');
    // `release view <tag>` succeeds once that release was created;
    // `release create` records the call, or fails when FAKE_GH_FAIL is set.
    fs.writeFileSync(fakeGh, [
      "import fs from 'node:fs';",
      'const args = process.argv.slice(2);',
      `const log = ${JSON.stringify(ghLog)};`,
      "const created = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').map((l) => JSON.parse(l).args[2]) : [];",
      "if (args[1] === 'view') process.exit(created.includes(args[2]) ? 0 : 1);",
      'if (process.env.FAKE_GH_FAIL) process.exit(1);',
      "const notes = fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8');",
      "fs.appendFileSync(log, JSON.stringify({ args, notes }) + '\\n');",
    ].join('\n'));

    const release = (args = [], env = {}) => spawnSync(process.execPath, [path.join(work, 'scripts', 'release.mjs'), ...args], {
      // GITHUB_ACTIONS cleared: CI sets it, and it changes what release.mjs does.
      cwd: work, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', RELEASE_FAKE_GH: fakeGh, ...env },
    });
    const ghCalls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
    return { dir, work, remote, git, write, release, ghCalls };
  }

  test('versions a changeset, pushes the commit and tag, and creates the release from the CHANGELOG', () => {
    const t = setup();
    t.write('.changeset/brave-demo.md', '---\n"demo": patch\n---\n\nAdd a demo feature.\n');
    t.git(t.work, 'add', '--all');
    t.git(t.work, 'commit', '--quiet', '-m', 'add changeset');
    t.git(t.work, 'push', '--quiet');

    const r = t.release();
    assert.equal(r.status, 0, r.stdout + r.stderr);

    assert.equal(t.git(t.remote, 'log', '-1', '--format=%s', 'main'), 'Version packages');
    const remoteFile = (rel) => t.git(t.remote, 'show', `main:${rel}`);
    assert.equal(JSON.parse(remoteFile('plugins/demo/package.json')).version, '1.0.1');
    assert.equal(JSON.parse(remoteFile('plugins/demo/.claude-plugin/plugin.json')).version, '1.0.1');
    assert.equal(JSON.parse(remoteFile('plugins/demo/.claude-plugin/plugin.json')).description, 'kept as is');
    const marketplace = JSON.parse(remoteFile('.claude-plugin/marketplace.json'));
    assert.deepEqual(marketplace.plugins[0].source, {
      source: 'git-subdir', url: 'https://github.com/example/plugins.git', path: 'plugins/demo', ref: 'demo@1.0.1',
    }, 'Claude Code installs the release tag');
    assert.equal(marketplace.plugins[0].description, 'd', 'the rest of the entry is kept');
    assert.equal(marketplace.plugins[1].source, './plugins/other', 'entries without a plugin package are left alone');
    assert.equal(JSON.parse(remoteFile('plugins/demo/.antigravity-plugin/plugin.json')).version, '1.0.1');
    assert.match(remoteFile('plugins/demo/CHANGELOG.md'), /## 1\.0\.1[\s\S]*Add a demo feature\./);
    assert.equal(fs.existsSync(path.join(t.work, '.changeset', 'brave-demo.md')), false, 'changeset consumed');
    assert.match(t.git(t.remote, 'tag', '--list'), /^demo@1\.0\.1$/m);

    const calls = t.ghCalls();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 6), ['release', 'create', 'demo@1.0.1', '--verify-tag', '--title', 'demo 1.0.1']);
    assert.match(calls[0].notes, /Add a demo feature\./);
    assert.doesNotMatch(calls[0].notes, /## 1\.0\.1/, 'heading left out, the title has the version');

    const again = t.release();
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /nothing new to release/);
    assert.equal(t.ghCalls().length, 1, 'no second release');
  });

  test('--publish only tags and releases, never versions', () => {
    const t = setup();
    t.write('.changeset/later.md', '---\n"demo": minor\n---\n\nNot yet.\n');
    t.git(t.work, 'add', '--all');
    t.git(t.work, 'commit', '--quiet', '-m', 'pending changeset');
    t.git(t.work, 'push', '--quiet');
    const r = t.release(['--publish']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.work, 'plugins/demo/package.json'), 'utf8')).version, '1.0.0', 'changeset left for the Version packages PR');
    // 1.0.0 had no tag yet, so it gets one, with its fallback notes.
    assert.match(t.git(t.remote, 'tag', '--list'), /^demo@1\.0\.0$/m);
    assert.equal(t.ghCalls()[0].notes.trim(), 'demo 1.0.0');
  });

  test('refuses to version with uncommitted changes, or when main and origin/main differ', () => {
    const t = setup();
    t.write('scratch.txt', 'dirty\n');
    let r = t.release();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /commit or stash/);
    fs.rmSync(path.join(t.work, 'scratch.txt'));
    t.git(t.work, 'commit', '--quiet', '--allow-empty', '-m', 'unpushed');
    r = t.release();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /main and origin\/main differ/);
    assert.equal(t.ghCalls().length, 0);
  });

  test('in CI, a run for an older push steps aside once main has moved on', () => {
    const t = setup();
    t.write('.changeset/ci.md', '---\n"demo": patch\n---\n\nFrom CI.\n');
    t.git(t.work, 'add', '--all');
    t.git(t.work, 'commit', '--quiet', '-m', 'add changeset');
    t.git(t.work, 'push', '--quiet');
    // Someone pushes again before this run gets going.
    t.git(t.work, 'commit', '--quiet', '--allow-empty', '-m', 'newer push');
    t.git(t.work, 'push', '--quiet');
    t.git(t.work, 'reset', '--quiet', '--hard', 'HEAD~1');
    const r = t.release([], { GITHUB_ACTIONS: 'true' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /main has moved on/);
    assert.equal(t.git(t.remote, 'log', '-1', '--format=%s', 'main'), 'newer push', 'nothing pushed');
    assert.equal(t.ghCalls().length, 0);
  });

  test('a release that failed halfway is completed by the next run', () => {
    const t = setup();
    t.write('.changeset/half.md', '---\n"demo": patch\n---\n\nHalf done.\n');
    t.git(t.work, 'add', '--all');
    t.git(t.work, 'commit', '--quiet', '-m', 'add changeset');
    t.git(t.work, 'push', '--quiet');

    const failed = t.release([], { FAKE_GH_FAIL: '1' });
    assert.equal(failed.status, 1, 'gh release create failed');
    assert.match(t.git(t.remote, 'tag', '--list'), /^demo@1\.0\.1$/m, 'the tag got pushed');
    assert.equal(t.ghCalls().length, 0);

    // A fresh run, as CI does after the failure: the tag exists, the release doesn't.
    const retry = t.release(['--publish']);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.equal(t.ghCalls().length, 1);
    assert.match(t.ghCalls()[0].notes, /Half done\./);
  });
});
