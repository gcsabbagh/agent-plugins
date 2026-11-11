// install.ps1 under every PowerShell found.
import { test, describe } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  isWin, bash, skip, withEnv, pathKey, sandbox, findPowershells, installPs1,
} from './helpers.mjs';

const powershells = findPowershells();

describe('install.ps1', { skip: skip || (powershells.length === 0 && 'no PowerShell found') }, () => {
  const ps = (exe, s, args, extraEnv = {}) =>
    spawnSync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installPs1, ...args], { env: withEnv(s.env, extraEnv), encoding: 'utf8' });

  for (const exe of powershells) {
    test(`${exe}: installs with the right bash and passes arguments through`, () => {
      const s = sandbox();
      const r = ps(exe, s, ['--agy', '--nudge-only']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /installed \(mode: nudge-only\)/);
      assert.equal(s.read('.gemini/context-guard/mode').trim(), 'nudge-only');
      assert.ok(s.json('.gemini/config/hooks.json')['context-guard']);
    });

    test(`${exe}: returns the installer's exit code`, () => {
      const s = sandbox();
      const r = ps(exe, s, ['--bogus']);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /unknown option '--bogus'/);
    });

    test(`${exe}: CONTEXT_GUARD_BASH is used, and a wrong one is an error`, { skip: !isWin && 'Windows only' }, () => {
      const s = sandbox();
      assert.equal(ps(exe, s, ['--agy'], { CONTEXT_GUARD_BASH: bash }).status, 0);
      const r = ps(exe, s, ['--agy'], { CONTEXT_GUARD_BASH: s.p('nope', 'bash.exe') });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /CONTEXT_GUARD_BASH points to/);
    });

    test(`${exe}: no Git Bash: clear error, nothing installed`, { skip: !isWin && 'Windows only' }, () => {
      const s = sandbox();
      const r = ps(exe, s, ['--agy'], { ProgramFiles: s.p('no-git'), ProgramW6432: s.p('no-git'), [pathKey]: `${process.env.SystemRoot}\\System32;${path.dirname(spawnSync('where', [exe], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0])}` });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Git Bash not found/);
      assert.equal(s.exists('.gemini'), false);
    });
  }
});
