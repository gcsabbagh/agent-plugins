// Windows only: the .cmd launchers and the plugin's hook command, run
// through cmd the way agy runs them, and the handoff from WSL's bash.
import { test, describe } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  pluginDir, scriptsDir, isWin, fwd, bash, jqPath, skip, winOnly, pathKey, sandbox, statusline, agyPayload, preInvocation,
} from './helpers.mjs';

describe('Windows launchers through cmd', { skip: winOnly }, () => {
  test('agy.cmd runs the statusline with state in %USERPROFILE%\\.gemini\\context-guard', () => {
    const s = sandbox();
    s.install('--agy', '--nudge-only');
    s.write('.gemini/context-guard/prev-statusline.sh', '#!/usr/bin/env bash\necho prev-out\n');
    const command = s.json('.gemini/antigravity-cli/settings.json').statusLine.command;
    const r = s.cmd(command, { input: JSON.stringify(agyPayload()) });
    assert.equal(r.stdout.trim(), 'prev-out', r.stderr);
    assert.equal(fs.readFileSync(s.ctxFile('sess-agy'), 'utf8').trim(), '61');
  });

  test('a previous cmd statusline keeps working through prev-statusline.cmd', () => {
    const s = sandbox();
    s.write('.gemini/antigravity-cli/settings.json', { statusLine: { type: 'command', command: 'echo from-cmd' } });
    s.install('--agy', '--nudge-only');
    const r = s.cmd(s.json('.gemini/antigravity-cli/settings.json').statusLine.command, { input: JSON.stringify(agyPayload()) });
    assert.equal(r.stdout.trim(), 'from-cmd', r.stderr);
  });

  test('agy.cmd runs the hook from the script install', () => {
    const s = sandbox();
    s.install('--agy');
    fs.writeFileSync(s.ctxFile('sess-agy'), '66\n');
    const [h] = s.json('.gemini/config/hooks.json')['context-guard'].PreInvocation;
    const r = s.cmd(h.command, { input: JSON.stringify(preInvocation()) });
    assert.match(JSON.parse(r.stdout).injectSteps[0].systemMessage.systemMessage, /at 66%/, r.stderr);
    const later = s.cmd(h.command, { input: JSON.stringify(preInvocation({ invocationNum: 1 })) });
    assert.deepEqual(JSON.parse(later.stdout), {});
  });

  test('plugin hook command, cmd branch: runs agy.cmd from the plugin folder, never WSL', () => {
    const s = sandbox();
    fs.writeFileSync(s.ctxFile('sess-agy'), '70\n');
    const command = JSON.parse(fs.readFileSync(path.join(pluginDir, 'hooks.json'), 'utf8'))['context-guard'].PreInvocation[0].command;
    // Without WindowsApps (where WSL's bash.exe lives) on PATH, the `|| bash`
    // fallback would fail, so an answer must have come from agy.cmd.
    const noWsl = process.env[pathKey].split(';').filter((d) => !/WindowsApps/i.test(d)).join(';');
    const r = s.cmd(command, { cwd: pluginDir, input: JSON.stringify(preInvocation()), extraEnv: { [pathKey]: noWsl } });
    assert.match(JSON.parse(r.stdout).injectSteps[0].systemMessage.systemMessage, /at 70%/, r.stderr);
  });

  test('agy.cmd without Git Bash: hook prints {}, statusline prints nothing, both exit 0', () => {
    const s = sandbox();
    s.install('--agy');
    const launcher = s.p('.gemini/context-guard/agy.cmd');
    // 64-bit cmd rebuilds ProgramFiles from ProgramW6432, so fake both.
    const env = { ProgramFiles: s.p('no-git'), ProgramW6432: s.p('no-git'), [pathKey]: `${process.env.SystemRoot}\\System32` };
    const hook = s.cmd(`${fwd(launcher)} prompt-hook --agy`, { input: '{}', extraEnv: env });
    assert.equal(hook.status, 0);
    assert.equal(hook.stdout.trim(), '{}');
    const sl = s.cmd(`${fwd(launcher)} statusline`, { input: '{}', extraEnv: env });
    assert.equal(sl.status, 0);
    assert.equal(sl.stdout.trim(), '');
  });

  test('CONTEXT_GUARD_BASH wins over the default lookup', () => {
    const s = sandbox();
    s.install('--agy');
    fs.writeFileSync(s.ctxFile('sess-agy'), '64\n');
    const launcher = fwd(s.p('.gemini/context-guard/agy.cmd'));
    // No Git in ProgramFiles or on PATH: only the override can find bash.
    const env = { ProgramFiles: s.p('no-git'), ProgramW6432: s.p('no-git'), [pathKey]: `${process.env.SystemRoot}\\System32;${path.dirname(jqPath)}`, CONTEXT_GUARD_BASH: bash };
    const r = s.cmd(`${launcher} prompt-hook --agy`, { input: JSON.stringify(preInvocation()), extraEnv: env });
    assert.match(JSON.parse(r.stdout).injectSteps[0].systemMessage.systemMessage, /at 64%/, r.stderr);
  });

  test('CONTEXT_GUARD_BASH pointing nowhere: says so, hook prints {}', () => {
    const s = sandbox();
    s.install('--agy');
    const r = s.cmd(`${fwd(s.p('.gemini/context-guard/agy.cmd'))} prompt-hook --agy`, { input: '{}', extraEnv: { CONTEXT_GUARD_BASH: s.p('nope', 'bash.exe') } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '{}');
    assert.match(r.stderr, /CONTEXT_GUARD_BASH points to/);
  });

  test('installer refuses a launcher path with a space', () => {
    const s = sandbox();
    const spaced = path.join(s.home, 'with space');
    fs.mkdirSync(spaced);
    const r = spawnSync(bash, [path.join(scriptsDir, 'install.sh'), '--agy'], { env: { ...s.env, HOME: fwd(spaced), USERPROFILE: spaced }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /contains a space/);
  });

  // Under WSL, install.sh hands off to the real powershell.exe, which would
  // install into the real Windows home, so these put a fake one (or none) on
  // PATH inside WSL. `setup` runs first, with a WSL temp dir in $t and the
  // installer's WSL path in $sh, which it may change.
  const wslSkip = (isWin && spawnSync('wsl.exe', ['-e', 'true']).status !== 0) ? 'WSL not available' : winOnly;
  const wslInstall = (setup, ...args) => {
    const sh = fwd(path.join(scriptsDir, 'install.sh'));
    const script = `t=$(mktemp -d); trap 'rm -rf "$t"' EXIT; sh=$(wslpath -a "$0"); ${setup}; bash "$sh" "$@"`;
    return spawnSync('wsl.exe', ['-e', 'bash', '-c', script, sh, ...args], { encoding: 'utf8' });
  };

  test('installer under WSL bash hands off to install.ps1 via powershell.exe', { skip: wslSkip }, () => {
    // printf, not echo: dash's echo would read the \a in "\agent-plugins".
    const fake = `cat > "$t/powershell.exe" <<'EOF'
#!/bin/sh
printf 'ARGS %s\\n' "$*"
exit 7
EOF
chmod +x "$t/powershell.exe"; export PATH="$t:$PATH"`;
    const r = wslInstall(fake, '--agy', '--nudge-only');
    assert.equal(r.status, 7, 'returns the Windows installer\'s exit code');
    assert.match(r.stderr, /running the Windows installer instead/);
    const ps1 = path.join(scriptsDir, 'install.ps1').replace(/^[a-z]:/, (d) => d.toUpperCase());
    assert.equal(r.stdout.trim(), `ARGS -NoProfile -ExecutionPolicy Bypass -File ${ps1} --agy --nudge-only`);
  });

  test('installer under WSL bash without powershell.exe refuses with the install.ps1 hint', { skip: wslSkip }, () => {
    const r = wslInstall('export PATH=/usr/bin:/bin', '--agy');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /WSL's bash/);
    assert.match(r.stderr, /install\.ps1" --agy/, 'points to the PowerShell wrapper with the same arguments');
  });

  test('installer under WSL bash outside a Windows drive refuses, even with powershell.exe', { skip: wslSkip }, () => {
    const r = wslInstall('cp "$sh" "$t/install.sh"; sh="$t/install.sh"', '--agy');
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /running the Windows installer/);
    assert.match(r.stderr, /would install into WSL/);
  });
});
