// Tests for the context-guard scripts (statusline, prompt hook, installer) for
// both Claude Code and agy. Every run uses a temp HOME/USERPROFILE/TMPDIR, so
// nothing touches your real config. Needs bash and jq; on Windows, Git Bash
// (the bash on PATH there is usually WSL's). Windows-only cases run the real
// .cmd launchers through cmd, the way agy runs them.
import { test, describe, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..');
const scriptsDir = path.join(pluginDir, 'scripts');
const isWin = process.platform === 'win32';
const fwd = (p) => p.replaceAll('\\', '/');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function findBash() {
  // An absolute path, so tests that trim PATH can still start bash.
  if (!isWin) return spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim() || undefined;
  const candidates = [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')];
  const where = spawnSync('where', ['git'], { encoding: 'utf8' });
  if (where.status === 0) candidates.push(path.resolve(path.dirname(where.stdout.split(/\r?\n/)[0]), '..', 'bin', 'bash.exe'));
  return candidates.find((c) => fs.existsSync(c));
}
const bash = findBash();
const jqLookup = bash && spawnSync(bash, ['-c', 'command -v jq'], { encoding: 'utf8' });
const hasJq = !!jqLookup && jqLookup.status === 0;
// jq's folder as a native path, for tests that trim PATH down.
const jqPath = hasJq ? (isWin ? spawnSync(bash, ['-c', 'cygpath -w "$(command -v jq)"'], { encoding: 'utf8' }).stdout.trim() : jqLookup.stdout.trim()) : '';
const skip = !bash ? 'Git Bash not found' : !hasJq ? 'jq not found' : false;
const winOnly = !isWin ? 'Windows only' : skip;

// Merges env overrides; Windows env names are case-insensitive (PROGRAMFILES vs
// ProgramFiles), so a differently cased key would otherwise be a duplicate.
function withEnv(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    for (const existing of Object.keys(out)) if (existing.toLowerCase() === k.toLowerCase()) delete out[existing];
    if (v !== undefined) out[k] = v;
  }
  return out;
}
const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';

// A temp home with everything the scripts look at pointed into it.
function sandbox() {
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

const statusline = path.join(scriptsDir, 'statusline.sh');
const promptHook = path.join(scriptsDir, 'prompt-hook.sh');

const claudePayload = (over = {}) => ({
  session_id: 'sess-claude',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  context_window: { used_percentage: 63.4, context_window_size: 200000 },
  cost: { total_cost_usd: 1.234, total_lines_added: 42, total_lines_removed: 7 },
  workspace: { current_dir: fwd(os.tmpdir()) },
  ...over,
});
// Shape captured from agy 1.5.5 (trimmed).
const agyPayload = (over = {}) => ({
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
const preInvocation = (over = {}) => ({
  conversationId: 'sess-agy', hookEventName: 'PreInvocation', invocationNum: 0, initialNumSteps: 1,
  lastUserInput: 'hi', modelName: 'gemini-4-argon-medium', ...over,
});

// Installs statusline.sh into a sandbox state dir, as the installer would.
function installedStatusline(s, dir = '.claude/context-guard', mode = 'full') {
  fs.mkdirSync(s.p(dir), { recursive: true });
  fs.copyFileSync(statusline, s.p(dir, 'statusline.sh'));
  fs.writeFileSync(s.p(dir, 'mode'), `${mode}\n`);
  return s.p(dir, 'statusline.sh');
}
const runStatusline = (s, payload, opts = {}) => {
  const r = s.sh(opts.script ?? installedStatusline(s), [], { input: JSON.stringify(payload), extraEnv: opts.env });
  assert.equal(r.status, 0, r.stderr);
  return { ...r, line: stripAnsi(r.stdout.trim()) };
};

describe('statusline', { skip }, () => {
  test('Claude payload: model, ctx, cost, lines, records ctx %', () => {
    const s = sandbox();
    const { line } = runStatusline(s, claudePayload());
    assert.match(line, /^Opus 5\.5  ctx 63%  \$1\.23  \+42 -7/);
    assert.equal(fs.readFileSync(s.ctxFile('sess-claude'), 'utf8').trim(), '63');
  });

  test('falls back to current_usage / context_window_size', () => {
    const s = sandbox();
    const payload = claudePayload({
      context_window: { context_window_size: 20000, current_usage: { input_tokens: 1000, cache_creation_input_tokens: 1000, cache_read_input_tokens: 8000 } },
    });
    assert.match(runStatusline(s, payload).line, /ctx 50%/);
  });

  test('no context info: shows ctx -- and records nothing', () => {
    const s = sandbox();
    const { line } = runStatusline(s, claudePayload({ context_window: undefined }));
    assert.match(line, /ctx --/);
    assert.equal(fs.existsSync(s.ctxFile('sess-claude')), false);
  });

  test('model falls back to id, then ?', () => {
    const s = sandbox();
    assert.match(runStatusline(s, claudePayload({ model: { id: 'only-id' } })).line, /^only-id /);
    assert.match(runStatusline(s, claudePayload({ model: undefined })).line, /^\? /);
  });

  test('colors: green < 50 <= yellow < 80 <= red', () => {
    const s = sandbox();
    const color = (pct) => runStatusline(s, claudePayload({ context_window: { used_percentage: pct } })).stdout.match(/\x1b\[(\d+)mctx/)[1];
    assert.equal(color(49.9), '32');
    assert.equal(color(50), '33');
    assert.equal(color(79), '33');
    assert.equal(color(80), '31');
  });

  test('colors follow CONTEXT_GUARD_THRESHOLD: yellow from it, red from 80; invalid values fall back to 50', () => {
    const s = sandbox();
    const color = (pct, threshold) => runStatusline(s, claudePayload({ context_window: { used_percentage: pct } }), { env: { CONTEXT_GUARD_THRESHOLD: threshold } }).stdout.match(/\x1b\[(\d+)mctx/)[1];
    assert.equal(color(0, '1'), '32');
    assert.equal(color(1, '1'), '33');
    assert.equal(color(79, '1'), '33');
    assert.equal(color(80, '1'), '31');
    assert.equal(color(85, '90'), '31', 'red from 80 even when the threshold is higher');
    assert.equal(color(79, '90'), '32');
    assert.equal(color(49, 'abc'), '32');
    assert.equal(color(50, 'abc'), '33');
  });

  test('agy payload: cost null and no line counts, so neither is shown', () => {
    const s = sandbox();
    const { line } = runStatusline(s, agyPayload({ cost: null }), { script: installedStatusline(s, '.gemini/context-guard') });
    assert.match(line, /^Gemini 4 Argon \(Medium\)  ctx 61%/);
    assert.doesNotMatch(line, /\$|\+\d/);
    assert.equal(fs.readFileSync(s.ctxFile('sess-agy'), 'utf8').trim(), '61');
  });

  test('cost as a bare number is shown', () => {
    const s = sandbox();
    assert.match(runStatusline(s, agyPayload({ cost: 0.5 })).line, /\$0\.50/);
  });

  test('permission mode (cycle_mode) leads the line when sent', () => {
    const s = sandbox();
    const r = runStatusline(s, agyPayload({ cycle_mode: 'plan' }));
    assert.match(r.line, /^plan · Gemini 4 Argon \(Medium\)  ctx 61%/);
    assert.match(r.stdout, /\x1b\[38;5;209mplan/, 'in orange');
  });

  test('quota: the lowest window left is shown, named 5h, wk or by its key', () => {
    const s = sandbox();
    const quota = (q) => runStatusline(s, agyPayload({ quota: q })).line;
    assert.match(quota({ 'gemini-5h': { remaining_fraction: 0.97 }, 'gemini-argon-wtu-weekly': { remaining_fraction: 0.4993 }, 'bad': 'x' }), /ctx 61%  quota 49% wk$/);
    assert.match(quota({ 'gemini-5h': { remaining_fraction: 0.3 }, 'gemini-weekly': { remaining_fraction: 0.9 } }), /quota 30% 5h/);
    assert.match(quota({ 'monthly-pool': { remaining_fraction: 0.6 } }), /quota 60% monthly-pool/);
    assert.doesNotMatch(quota({}), /quota/);
    assert.doesNotMatch(quota('nonsense'), /quota/);
  });

  test('quota: yellow under 25%, red under 10%, hidden when cost is sent', () => {
    const s = sandbox();
    const color = (f) => runStatusline(s, agyPayload({ quota: { 'gemini-5h': { remaining_fraction: f } } })).stdout.match(/(\x1b\[(\d+)m)?quota/)[2];
    assert.equal(color(0.25), undefined);
    assert.equal(color(0.24), '33');
    assert.equal(color(0.09), '31');
    assert.doesNotMatch(runStatusline(s, claudePayload({ quota: { 'gemini-5h': { remaining_fraction: 0.5 } } })).line, /quota/);
  });

  test('lines changed: from git diff when the agent sends none, else the agent\'s own', () => {
    const s = sandbox();
    const repo = s.p('repo');
    fs.mkdirSync(repo);
    const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    git('add', '.'); git('commit', '-q', '-m', 'init');
    const ws = { workspace: { current_dir: fwd(repo) } };
    assert.match(runStatusline(s, agyPayload(ws)).line, /ctx 61%  main$/, 'clean repo: no lines');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n2\nthree\nfour\nfive\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'staged\n');
    git('add', 'b.txt');
    assert.match(runStatusline(s, agyPayload(ws)).line, /ctx 61%  \+4 -1  main$/, 'unstaged and staged changes');
    assert.match(runStatusline(s, claudePayload(ws)).line, /\+42 -7  main$/, 'agent-reported counts win');
  });

  test('git branch of the workspace is shown', () => {
    const s = sandbox();
    const repo = s.p('repo');
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '-q', '-b', 'feature-x', repo]);
    assert.match(runStatusline(s, claudePayload({ workspace: { current_dir: fwd(repo) } })).line, /feature-x$/);
  });

  test('nudge-only mode prints only the previous statusline, which receives the same stdin', () => {
    const s = sandbox();
    const script = installedStatusline(s, '.claude/context-guard', 'nudge-only');
    s.write('.claude/context-guard/prev-statusline.sh', '#!/usr/bin/env bash\njq -r \'"prev:" + .session_id\'\n');
    const { line } = runStatusline(s, claudePayload(), { script });
    assert.equal(line, 'prev:sess-claude');
    assert.ok(fs.existsSync(s.ctxFile('sess-claude')), 'ctx % still recorded in nudge-only mode');
  });

  test('nudge-only mode with no previous statusline prints nothing', () => {
    const s = sandbox();
    const { stdout } = runStatusline(s, claudePayload(), { script: installedStatusline(s, '.claude/context-guard', 'nudge-only') });
    assert.equal(stdout, '');
  });

  test('full mode runs the previous statusline but hides its output', () => {
    const s = sandbox();
    const script = installedStatusline(s);
    s.write('.claude/context-guard/prev-statusline.sh', `#!/usr/bin/env bash\ncat > "${fwd(s.p('prev-ran'))}"\necho hidden\n`);
    const { line } = runStatusline(s, claudePayload(), { script });
    assert.doesNotMatch(line, /hidden/);
    assert.ok(s.exists('prev-ran'));
  });

  test('CONTEXT_GUARD_DIR (with backslashes) overrides the state dir', () => {
    const s = sandbox();
    const script = installedStatusline(s, 'elsewhere', 'full');
    fs.mkdirSync(s.p('state'));
    fs.writeFileSync(s.p('state', 'mode'), 'nudge-only\n');
    const { stdout } = runStatusline(s, claudePayload(), { script, env: { CONTEXT_GUARD_DIR: s.p('state').replaceAll('/', '\\') } });
    assert.equal(stdout, '', 'reads mode from CONTEXT_GUARD_DIR');
  });

  test('without jq it says so instead of failing', () => {
    const s = sandbox();
    const r = s.sh(installedStatusline(s), [], { input: '{}', extraEnv: { PATH: '/nonexistent' } });
    // bash itself still runs; only command lookups fail.
    assert.match(r.stdout, /jq not found/);
  });
});

describe('prompt hook (Claude Code)', { skip }, () => {
  const run = (s, input, extraEnv) => {
    const r = s.sh(promptHook, [], { input: JSON.stringify(input), extraEnv });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const ctx = (s, id, pct) => fs.writeFileSync(s.ctxFile(id), `${pct}\n`);

  test('below the threshold: no output', () => {
    const s = sandbox();
    ctx(s, 'a', 49);
    assert.equal(run(s, { session_id: 'a' }), '');
  });

  test('at the threshold: additionalContext with a /compact keep: line', () => {
    const s = sandbox();
    ctx(s, 'a', 50);
    const out = JSON.parse(run(s, { session_id: 'a' }));
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext, /context window is at 50%/);
    assert.match(out.hookSpecificOutput.additionalContext, /\n\/compact keep: </);
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /above 80%/);
  });

  test('at 80% and up: also asks to save state to a file', () => {
    const s = sandbox();
    ctx(s, 'a', 80);
    assert.match(JSON.parse(run(s, { session_id: 'a' })).hookSpecificOutput.additionalContext, /above 80%/);
  });

  test('CONTEXT_GUARD_THRESHOLD is honored; invalid values fall back to 50', () => {
    const s = sandbox();
    ctx(s, 'a', 30);
    assert.notEqual(run(s, { session_id: 'a' }, { CONTEXT_GUARD_THRESHOLD: '30' }), '');
    assert.equal(run(s, { session_id: 'a' }, { CONTEXT_GUARD_THRESHOLD: '31' }), '');
    assert.equal(run(s, { session_id: 'a' }, { CONTEXT_GUARD_THRESHOLD: 'abc' }), '');
    ctx(s, 'a', 50);
    assert.notEqual(run(s, { session_id: 'a' }, { CONTEXT_GUARD_THRESHOLD: 'abc' }), '');
  });

  test('no session id, no ctx file, or garbage in it: no output', () => {
    const s = sandbox();
    assert.equal(run(s, {}), '');
    assert.equal(run(s, { session_id: 'missing' }), '');
    fs.writeFileSync(s.ctxFile('junk'), 'n/a\n');
    assert.equal(run(s, { session_id: 'junk' }), '');
  });
});

describe('prompt hook (agy)', { skip }, () => {
  const run = (s, input, extraEnv) => {
    const r = s.sh(promptHook, ['--agy'], { input: JSON.stringify(input), extraEnv });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const ctx = (s, pct) => fs.writeFileSync(s.ctxFile('sess-agy'), `${pct}\n`);

  test('first call of a turn at the threshold: injects a systemMessage', () => {
    const s = sandbox();
    ctx(s, 61);
    const out = run(s, preInvocation());
    const msg = out.injectSteps[0].systemMessage.systemMessage;
    assert.match(msg, /context window is at 61%/);
    assert.match(msg, /\n\/compact Next: <the next step>\. Keep in mind: </);
    assert.equal(out.terminationBehavior, undefined, 'never stops the turn');
  });

  test('later calls in the same turn: {}', () => {
    const s = sandbox();
    ctx(s, 90);
    assert.deepEqual(run(s, preInvocation({ invocationNum: 1 })), {});
    assert.deepEqual(run(s, preInvocation({ invocationNum: 7 })), {});
  });

  test('every no-op path still prints {}', () => {
    const s = sandbox();
    assert.deepEqual(run(s, preInvocation({ conversationId: undefined })), {});
    assert.deepEqual(run(s, preInvocation()), {}, 'no ctx file');
    ctx(s, 10);
    assert.deepEqual(run(s, preInvocation()), {}, 'below threshold');
  });

  test('prints {} even without jq', () => {
    const s = sandbox();
    const r = s.sh(promptHook, ['--agy'], { input: '{}', extraEnv: { PATH: '/nonexistent' } });
    assert.equal(r.stdout.trim(), '{}');
  });

  test('80%+ wording and the threshold work as for Claude', () => {
    const s = sandbox();
    ctx(s, 85);
    assert.match(run(s, preInvocation()).injectSteps[0].systemMessage.systemMessage, /above 80%/);
    ctx(s, 40);
    assert.ok(run(s, preInvocation(), { CONTEXT_GUARD_THRESHOLD: '40' }).injectSteps);
  });

  test('statusline and hook agree on the session file', () => {
    const s = sandbox();
    runStatusline(s, agyPayload({ context_window: { used_percentage: 72 } }));
    assert.match(run(s, preInvocation()).injectSteps[0].systemMessage.systemMessage, /at 72%/);
  });
});

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

// install.ps1 under every PowerShell that's installed: Windows PowerShell 5.1
// (Windows only) and PowerShell 7 (any OS).
const powershells = [isWin && 'powershell.exe', 'pwsh']
  .filter(Boolean)
  .filter((exe) => spawnSync(exe, ['-NoProfile', '-Command', 'exit 0']).status === 0);
const installPs1 = path.join(scriptsDir, 'install.ps1');

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
