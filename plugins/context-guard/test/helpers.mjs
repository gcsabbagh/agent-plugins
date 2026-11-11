// Shared setup for the context-guard tests: finds bash and jq, and builds a
// sandbox (temp HOME/USERPROFILE/TMPDIR) for each case, so nothing touches
// your real config. Needs bash and jq; on Windows, Git Bash (the bash on PATH
// there is usually WSL's).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const pluginDir = path.resolve(here, '..');
export const scriptsDir = path.join(pluginDir, 'scripts');
export const isWin = process.platform === 'win32';
export const fwd = (p) => p.replaceAll('\\', '/');
export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

export function findBash() {
  // An absolute path, so tests that trim PATH can still start bash.
  if (!isWin) return spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim() || undefined;
  const candidates = [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')];
  const where = spawnSync('where', ['git'], { encoding: 'utf8' });
  if (where.status === 0) candidates.push(path.resolve(path.dirname(where.stdout.split(/\r?\n/)[0]), '..', 'bin', 'bash.exe'));
  return candidates.find((c) => fs.existsSync(c));
}
export const bash = findBash();
export const jqLookup = bash && spawnSync(bash, ['-c', 'command -v jq'], { encoding: 'utf8' });
export const hasJq = !!jqLookup && jqLookup.status === 0;
// jq's folder as a native path, for tests that trim PATH down.
export const jqPath = hasJq ? (isWin ? spawnSync(bash, ['-c', 'cygpath -w "$(command -v jq)"'], { encoding: 'utf8' }).stdout.trim() : jqLookup.stdout.trim()) : '';
export const skip = !bash ? 'Git Bash not found' : !hasJq ? 'jq not found' : false;
export const winOnly = !isWin ? 'Windows only' : skip;

// Merges env overrides; Windows env names are case-insensitive (PROGRAMFILES vs
// ProgramFiles), so a differently cased key would otherwise be a duplicate.
export function withEnv(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    for (const existing of Object.keys(out)) if (existing.toLowerCase() === k.toLowerCase()) delete out[existing];
    if (v !== undefined) out[k] = v;
  }
  return out;
}
export const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';

// A temp home with everything the scripts look at pointed into it.
export function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'context-guard-'));
  const tmp = path.join(home, 'tmp');
  fs.mkdirSync(tmp);
  const env = withEnv(process.env, {
    HOME: fwd(home), USERPROFILE: home, TMPDIR: fwd(tmp), CONTEXT_GUARD_THRESHOLD: undefined, CONTEXT_GUARD_DIR: undefined,
  });
  const p = (...parts) => path.join(home, ...parts);
  const write = (rel, data) => {
    fs.mkdirSync(path.dirname(p(rel)), { recursive: true });
    fs.writeFileSync(p(rel), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  };
  const read = (rel) => fs.readFileSync(p(rel), 'utf8');
  const json = (rel) => JSON.parse(read(rel).replace(/^\uFEFF/, ''));
  const exists = (rel) => fs.existsSync(p(rel));
  const sh = (script, args = [], { input = '', extraEnv = {}, cwd } = {}) =>
    spawnSync(bash, [script, ...args], { input, env: withEnv(env, extraEnv), cwd, encoding: 'utf8' });
  const install = (...args) => sh(path.join(scriptsDir, 'install.sh'), args);
  const ctxFile = (id) => path.join(tmp, `claude-ctx-${id}`);
  // Runs a command string through cmd /c, as agy does on Windows.
  const cmd = (command, { input = '', extraEnv = {}, cwd } = {}) =>
    spawnSync('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
      input, cwd, env: withEnv(env, extraEnv), encoding: 'utf8', windowsVerbatimArguments: true,
    });
  return { home, tmp, env, p, write, read, json, exists, sh, install, ctxFile, cmd };
}

export const statusline = path.join(scriptsDir, 'statusline.sh');
export const promptHook = path.join(scriptsDir, 'prompt-hook.sh');

export const claudePayload = (over = {}) => ({
  session_id: 'sess-claude',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  context_window: { used_percentage: 63.4, context_window_size: 200000 },
  cost: { total_cost_usd: 1.234, total_lines_added: 42, total_lines_removed: 7 },
  workspace: { current_dir: fwd(os.tmpdir()) },
  ...over,
});
// Shape captured from agy 1.5.5 (trimmed).
export const agyPayload = (over = {}) => ({
  session_id: 'sess-agy',
  conversation_id: 'sess-agy',
  model: { id: 'Gemini 4 Argon (Medium)', display_name: 'Gemini 4 Argon (Medium)', effort: 'medium' },
  workspace: { current_dir: fwd(os.tmpdir()), project_dir: fwd(os.tmpdir()) },
  context_window: {
    total_input_tokens: 12440, context_window_size: 1048576, used_percentage: 61.18,
    current_usage: { input_tokens: 8667, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
  product: 'antigravity',
  ...over,
});
export const preInvocation = (over = {}) => ({
  conversationId: 'sess-agy', hookEventName: 'PreInvocation', invocationNum: 0, initialNumSteps: 1,
  lastUserInput: 'hi', modelName: 'gemini-4-argon-medium', ...over,
});

// Installs statusline.sh into a sandbox state dir, as the installer would.
export function installedStatusline(s, dir = '.claude/context-guard', mode = 'full') {
  fs.mkdirSync(s.p(dir), { recursive: true });
  fs.copyFileSync(statusline, s.p(dir, 'statusline.sh'));
  fs.writeFileSync(s.p(dir, 'mode'), `${mode}\n`);
  return s.p(dir, 'statusline.sh');
}
export const runStatusline = (s, payload, opts = {}) => {
  const r = s.sh(opts.script ?? installedStatusline(s), [], { input: JSON.stringify(payload), extraEnv: opts.env });
  assert.equal(r.status, 0, r.stderr);
  return { ...r, line: stripAnsi(r.stdout.trim()) };
};

// install.ps1 and get.ps1 run under every PowerShell that's installed: Windows
// PowerShell 5.1 (Windows only) and PowerShell 7 (any OS). A function, so only
// the files that need it pay for starting each one.
export const findPowershells = () => [isWin && 'powershell.exe', 'pwsh']
  .filter(Boolean)
  .filter((exe) => spawnSync(exe, ['-NoProfile', '-Command', 'exit 0']).status === 0);
export const installPs1 = path.join(scriptsDir, 'install.ps1');
