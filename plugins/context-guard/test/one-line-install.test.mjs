// The one-line installers, get.sh and get.ps1.
import { test, describe, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import {
  pluginDir, scriptsDir, isWin, bash, skip, withEnv, pathKey, sandbox, findPowershells,
} from './helpers.mjs';

const powershells = findPowershells();

// get.sh and get.ps1 (the one-line installers) against a local server that
// stands in for GitHub: a releases list, and a source archive of this working
// tree under any tag. A fake agy on PATH covers --agy-plugin.
describe('one-line install (get.sh, get.ps1)', { skip }, () => {
  let server, base, releases, requests, stage, fakeBin;
  const releaseList = [
    { tag_name: 'other-plugin@2.0.0', draft: false, prerelease: false },
    { tag_name: 'context-guard@9.0.0', draft: true, prerelease: false },
    { tag_name: 'context-guard@8.0.0-rc.1', draft: false, prerelease: true },
    { tag_name: 'context-guard@1.2.0', draft: false, prerelease: false },
    { tag_name: 'context-guard@1.1.0', draft: false, prerelease: false },
  ];

  beforeAll(async () => {
    // GitHub's archive layout: one top folder holding the whole repo.
    stage = fs.mkdtempSync(path.join(os.tmpdir(), 'context-guard-get-'));
    fs.cpSync(pluginDir, path.join(stage, 'agent-plugins-x', 'plugins', 'context-guard'), { recursive: true });
    const tar = spawnSync(bash, ['-c', 'tar -czf src.tar.gz agent-plugins-x'], { cwd: stage, encoding: 'utf8' });
    assert.equal(tar.status, 0, tar.stderr);
    const archive = fs.readFileSync(path.join(stage, 'src.tar.gz'));

    // Fake agy: `agy plugin install <dir>` copies <dir> where agy would.
    fakeBin = path.join(stage, 'bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'agy-fake.sh'), [
      '#!/usr/bin/env bash',
      'echo "$*" >> "$HOME/agy-calls"',
      '[ "$1 $2" = "plugin install" ] || exit 3',
      'src=$3; command -v cygpath >/dev/null && src=$(cygpath -u "$src")',
      'mkdir -p "$HOME/.gemini/config/plugins" && cp -R "$src" "$HOME/.gemini/config/plugins/context-guard"',
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(fakeBin, 'agy'), '#!/usr/bin/env bash\nexec bash "$(dirname "$0")/agy-fake.sh" "$@"\n');
    fs.chmodSync(path.join(fakeBin, 'agy'), 0o755);
    if (isWin) fs.writeFileSync(path.join(fakeBin, 'agy.cmd'), `@"${bash}" "%~dp0agy-fake.sh" %*\r\n`);

    server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url);
      requests.push(url);
      if (url === '/releases') return res.end(JSON.stringify(releases));
      const m = url.match(/^\/archive\/(.+)\.tar\.gz$/);
      if (m && m[1] !== 'context-guard@0.0.404') { res.setHeader('content-type', 'application/gzip'); return res.end(archive); }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => {
    server?.close();
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
  });

  // Async, since the server runs on this process's event loop.
  const run = (cmd, args, s, { input = '', extraEnv = {} } = {}) => new Promise((resolve) => {
    const env = withEnv(s.env, {
      CONTEXT_GUARD_RELEASES_URL: `${base}/releases`, CONTEXT_GUARD_ARCHIVE_BASE: `${base}/archive`,
      TEMP: s.tmp, TMP: s.tmp, ...extraEnv,
    });
    const p = spawn(cmd, args, { env });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
    p.stdin.end(input);
  });
  const withAgy = (s) => ({ [pathKey]: `${fakeBin}${path.delimiter}${s.env[pathKey]}` });
  const getSh = path.join(scriptsDir, 'get.sh');
  const getPs1 = path.join(scriptsDir, 'get.ps1');
  // Only what get.sh (mktemp -d: tmp.*) and get.ps1 (context-guard-*) create.
  // pwsh on macOS leaves files of its own in TMPDIR.
  const tmpLeft = (s) => fs.readdirSync(s.tmp).filter((n) => /^(tmp\.|context-guard-)/.test(n)).length;

  test('get.sh piped to bash: installs the newest published context-guard release', async () => {
    releases = releaseList; requests = [];
    const s = sandbox();
    const r = await run(bash, ['-s', '--', '--agy', '--nudge-only'], s, { input: fs.readFileSync(getSh, 'utf8') });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(requests, ['/releases', '/archive/context-guard@1.2.0.tar.gz'], 'skips other plugins, drafts and prereleases');
    assert.match(r.stderr, /downloading context-guard@1\.2\.0/);
    assert.equal(s.read('.gemini/context-guard/mode').trim(), 'nudge-only');
    assert.ok(s.json('.gemini/config/hooks.json')['context-guard']);
    assert.equal(tmpLeft(s), 0, 'temp folder removed');
  });

  test('get.sh --version installs that release without listing releases', async () => {
    releases = releaseList; requests = [];
    const s = sandbox();
    const r = await run(bash, [getSh, '--version', '1.0.0', '--agy'], s);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(requests, ['/archive/context-guard@1.0.0.tar.gz']);
  });

  test('get.sh: no context-guard release, or a failed download, is a clear error', async () => {
    releases = [releaseList[0]]; requests = [];
    const s = sandbox();
    let r = await run(bash, [getSh, '--agy'], s);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no context-guard release found/);
    r = await run(bash, [getSh, '--version', '0.0.404', '--agy'], s);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /couldn't download context-guard@0\.0\.404/);
    assert.equal(s.exists('.gemini'), false);
    assert.equal(tmpLeft(s), 0);
  });

  test("get.sh returns the installer's exit code, and points Claude Code users to the plugin", async () => {
    releases = releaseList;
    const s = sandbox();
    const bad = await run(bash, [getSh, '--bogus'], s);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown option '--bogus'/);
    const claude = await run(bash, [getSh, '--claude'], s);
    assert.equal(claude.status, 0, claude.stderr);
    assert.match(claude.stderr, /\/plugin install context-guard@gcsabbagh-agent-plugins/);
  });

  test('get.sh --agy-plugin: agy plugin install, then the installer from the installed plugin', async () => {
    releases = releaseList;
    const s = sandbox();
    const r = await run(bash, [getSh, '--agy-plugin'], s, { extraEnv: withAgy(s) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.read('agy-calls'), /^plugin install /);
    assert.match(s.json('.gemini/antigravity-cli/settings.json').statusLine.command, /config\/plugins\/context-guard\/scripts/);
    assert.equal(s.json('.gemini/config/hooks.json')['context-guard'], undefined, 'the plugin brings the hook');
  });

  for (const exe of powershells) {
    const ps = (s, args, opts) => run(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', getPs1, ...args], s, opts);

    test(`${exe}: get.ps1 installs the newest release and passes arguments through`, async () => {
      releases = releaseList; requests = [];
      const s = sandbox();
      const r = await ps(s, ['--agy', '--nudge-only']);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(requests, ['/releases', '/archive/context-guard@1.2.0.tar.gz']);
      assert.equal(s.read('.gemini/context-guard/mode').trim(), 'nudge-only');
      assert.equal(tmpLeft(s), 0, 'temp folder removed');
    });

    test(`${exe}: get.ps1 as a script block (the irm one-liner) keeps the session and sets $LASTEXITCODE`, async () => {
      releases = releaseList;
      const s = sandbox();
      const sb = `& ([scriptblock]::Create((Get-Content -Raw '${getPs1}'))) --version 0.0.404 --agy; "code=$LASTEXITCODE"`;
      const r = await run(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', sb], s);
      assert.match(r.stdout, /code=1/, r.stderr);
      assert.match(r.stderr, /couldn't download context-guard@0\.0\.404/);
    });

    test(`${exe}: get.ps1 returns the installer's exit code`, async () => {
      releases = releaseList;
      const r = await ps(sandbox(), ['--bogus']);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /unknown option '--bogus'/);
    });

    test(`${exe}: get.ps1 --agy-plugin`, { skip: !isWin && 'the fake agy is a .cmd' }, async () => {
      releases = releaseList;
      const s = sandbox();
      const r = await ps(s, ['--agy-plugin'], { extraEnv: withAgy(s) });
      assert.equal(r.status, 0, r.stderr);
      assert.match(s.json('.gemini/antigravity-cli/settings.json').statusLine.command, /config\/plugins\/context-guard\/scripts/);
    });
  }
});
