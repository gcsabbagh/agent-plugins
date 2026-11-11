// The installer for every supported agent, both agy routes, and the manifests.
import { test, describe } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  here, pluginDir, scriptsDir, isWin, fwd, bash, skip, sandbox, statusline, preInvocation,
} from './helpers.mjs';

describe('installer: Claude Code', { skip }, () => {
  test('fresh install creates settings and copies the statusline', () => {
    const s = sandbox();
    const r = s.install();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(s.json('.claude/settings.json').statusLine, { type: 'command', command: 'bash ~/.claude/context-guard/statusline.sh' });
    assert.ok(s.exists('.claude/context-guard/statusline.sh'));
    assert.equal(s.read('.claude/context-guard/mode').trim(), 'full');
    assert.match(r.stdout, /restart Claude Code/);
    assert.equal(s.exists('.gemini'), false, 'leaves agy alone');
  });

  test('keeps other settings, saves the previous statusline, backs up once', () => {
    const s = sandbox();
    s.write('.claude/settings.json', { env: { A: '1' }, statusLine: { type: 'command', command: 'echo mine', padding: 2 } });
    assert.equal(s.install().status, 0);
    const settings = s.json('.claude/settings.json');
    assert.deepEqual(settings.env, { A: '1' });
    assert.equal(settings.statusLine.padding, 2);
    assert.match(s.read('.claude/context-guard/prev-statusline.sh'), /^echo mine$/m);
    assert.equal(s.json('.claude/settings.json.bak-context-guard').statusLine.command, 'echo mine');

    assert.equal(s.install('--nudge-only').status, 0);
    assert.match(s.read('.claude/context-guard/prev-statusline.sh'), /^echo mine$/m, 're-run does not save our own command as previous');
    assert.equal(s.json('.claude/settings.json.bak-context-guard').statusLine.command, 'echo mine', 'backup stays the original');
    assert.equal(s.read('.claude/context-guard/mode').trim(), 'nudge-only');
  });

  test('refuses invalid JSON and leaves it untouched', () => {
    const s = sandbox();
    s.write('.claude/settings.json', '{ nope');
    const r = s.install();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(s.read('.claude/settings.json'), '{ nope');
  });

  test('the old --quiet and -q flags are rejected, nothing written', () => {
    for (const flag of ['--quiet', '-q']) {
      const s = sandbox();
      const r = s.install(flag);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /supported: --agy, --claude, --nudge-only/);
      assert.equal(s.exists('.claude'), false);
    }
  });

  test('--claude installs the same as no agent flag', () => {
    const s = sandbox();
    assert.equal(s.install('--claude').status, 0);
    const explicit = s.json('.claude/settings.json').statusLine;
    const t = sandbox();
    assert.equal(t.install().status, 0);
    assert.deepEqual(explicit, t.json('.claude/settings.json').statusLine);
    assert.equal(s.exists('.gemini'), false);
  });

  test('unknown option: exit 2', () => {
    const s = sandbox();
    const r = s.install('--bogus');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown option '--bogus'/);
  });

  test('jq missing: clear error, nothing written', () => {
    const s = sandbox();
    const r = s.sh(path.join(scriptsDir, 'install.sh'), [], { extraEnv: { PATH: fwd(path.dirname(bash)) } });
    if (r.status === 0) return; // jq lives next to bash here; nothing to check
    assert.match(r.stderr, /jq is required/);
    assert.equal(s.exists('.claude'), false);
  });
});

describe('installer: agy, script route', { skip }, () => {
  const orca = { 'orca-status': { Stop: [{ type: 'command', command: 'orca-stop.cmd' }] } };

  test('statusline + PreInvocation hook, other hooks and settings kept, BOM ok', () => {
    const s = sandbox();
    s.write('.gemini/antigravity-cli/settings.json', '\uFEFF' + JSON.stringify({ colorScheme: 'tokyo night' }));
    s.write('.gemini/config/hooks.json', orca);
    const r = s.install('--agy');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /restart agy/);

    const settings = s.json('.gemini/antigravity-cli/settings.json');
    assert.equal(settings.colorScheme, 'tokyo night');
    const hooks = s.json('.gemini/config/hooks.json');
    assert.deepEqual(hooks['orca-status'], orca['orca-status']);
    const hook = hooks['context-guard'].PreInvocation;
    assert.equal(hook.length, 1);
    assert.equal(hook[0].timeout, 10);

    for (const f of ['statusline.sh', 'prompt-hook.sh', 'agy.cmd', 'mode']) assert.ok(s.exists('.gemini/context-guard', f), f);
    const dir = fwd(s.p('.gemini/context-guard'));
    if (isWin) {
      assert.equal(settings.statusLine.command, `${dir}/agy.cmd statusline`);
      assert.equal(hook[0].command, `${dir}/agy.cmd prompt-hook --agy`);
    } else {
      assert.equal(settings.statusLine.command, 'bash ~/.gemini/context-guard/statusline.sh');
      assert.equal(hook[0].command, 'bash ~/.gemini/context-guard/prompt-hook.sh --agy');
    }
    assert.equal(s.exists('.claude'), false, 'leaves Claude alone');
    assert.ok(s.exists('.gemini/config/hooks.json.bak-context-guard'));
  });

  test('re-running is idempotent', () => {
    const s = sandbox();
    s.write('.gemini/antigravity-cli/settings.json', { statusLine: { type: 'command', command: 'echo theirs' } });
    s.install('--agy');
    const first = { settings: s.read('.gemini/antigravity-cli/settings.json'), hooks: s.read('.gemini/config/hooks.json') };
    s.install('--agy');
    assert.equal(s.read('.gemini/antigravity-cli/settings.json'), first.settings);
    assert.equal(s.read('.gemini/config/hooks.json'), first.hooks);
    assert.match(s.read('.gemini/context-guard/prev-statusline.sh'), isWin ? /cmd \/\/c/ : /^echo theirs$/m);
  });

  test('nudge-only sets stack_with_default; switching back to full removes it', () => {
    const s = sandbox();
    s.install('--agy', '--nudge-only');
    assert.equal(s.json('.gemini/antigravity-cli/settings.json').statusLine.stack_with_default, true);
    s.install('--agy');
    assert.equal(s.json('.gemini/antigravity-cli/settings.json').statusLine.stack_with_default, undefined);
  });

  test('full mode keeps a stack_with_default the user set', () => {
    const s = sandbox();
    s.write('.gemini/antigravity-cli/settings.json', { statusLine: { type: 'command', command: 'x', stack_with_default: true } });
    s.install('--agy');
    assert.equal(s.json('.gemini/antigravity-cli/settings.json').statusLine.stack_with_default, true);
  });

  test('invalid hooks.json: refuses before changing anything', () => {
    const s = sandbox();
    s.write('.gemini/config/hooks.json', '{ broken');
    const r = s.install('--agy');
    assert.equal(r.status, 1);
    assert.equal(s.read('.gemini/config/hooks.json'), '{ broken');
    assert.equal(s.exists('.gemini/antigravity-cli/settings.json.bak-context-guard') && s.json('.gemini/antigravity-cli/settings.json').statusLine, undefined);
  });
});

describe('installer: agy, plugin route', { skip }, () => {
  // Mimics `agy plugin install`, which copies the plugin folder here.
  const fakePluginInstall = (s) => {
    const dest = s.p('.gemini/config/plugins/context-guard');
    fs.cpSync(pluginDir, dest, { recursive: true, filter: (src) => !src.includes(`${path.sep}test`) });
    return dest;
  };

  test('uses the plugin copy and drops a hook left by a script install', () => {
    const s = sandbox();
    s.write('.gemini/config/hooks.json', { 'orca-status': {} });
    s.install('--agy');
    assert.ok(s.json('.gemini/config/hooks.json')['context-guard']);

    const dest = fakePluginInstall(s);
    const r = s.install('--agy');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /using the agy plugin's hook/);
    const hooks = s.json('.gemini/config/hooks.json');
    assert.equal(hooks['context-guard'], undefined);
    assert.ok(hooks['orca-status']);
    const command = s.json('.gemini/antigravity-cli/settings.json').statusLine.command;
    assert.equal(command, isWin
      ? `${fwd(dest)}/scripts/agy.cmd statusline`
      : 'CONTEXT_GUARD_DIR=~/.gemini/context-guard bash ~/.gemini/config/plugins/context-guard/scripts/statusline.sh');
    assert.ok(s.exists('.gemini/context-guard/mode'), 'state stays outside the plugin folder');
  });

  test('plugin hooks.json: valid for agy and points at the shared scripts', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(pluginDir, 'hooks.json'), 'utf8'));
    const [h] = hooks['context-guard'].PreInvocation;
    assert.equal(h.command, 'scripts\\agy.cmd prompt-hook --agy || bash scripts/prompt-hook.sh --agy');
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, '.antigravity-plugin', 'plugin.json'), 'utf8'));
    const claude = JSON.parse(fs.readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(manifest.name, claude.name);
    assert.equal(manifest.version, claude.version, 'keep both manifests on the same version');
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, claude.name, 'package.json names the plugin, which Changesets uses for the context-guard@<version> tags');
    assert.equal(pkg.version, claude.version, 'Changesets bumps package.json; scripts/sync-versions.mjs copies it into the manifests');
    assert.equal(manifest.description, claude.description);
  });

  test('plugin hook command, sh branch (macOS/Linux): falls through to bash', () => {
    const s = sandbox();
    fs.writeFileSync(s.ctxFile('sess-agy'), '70\n');
    const shBin = isWin ? path.join(path.dirname(bash), '..', 'usr', 'bin', 'sh.exe') : 'sh';
    const command = JSON.parse(fs.readFileSync(path.join(pluginDir, 'hooks.json'), 'utf8'))['context-guard'].PreInvocation[0].command;
    const r = spawnSync(shBin, ['-c', command], { cwd: pluginDir, input: JSON.stringify(preInvocation()), env: s.env, encoding: 'utf8' });
    assert.match(JSON.parse(r.stdout).injectSteps[0].systemMessage.systemMessage, /at 70%/);
  });

  test('agy plugin validate passes (when agy is installed)', { skip: spawnSync('agy', ['--version'], { shell: isWin }).status !== 0 && 'agy not installed' }, () => {
    const r = spawnSync('agy', ['plugin', 'validate', pluginDir], { encoding: 'utf8', shell: isWin });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /hooks 1/);
  });
});
