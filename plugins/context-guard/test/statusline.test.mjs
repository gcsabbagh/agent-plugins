// The status line and the prompt hook, for every supported agent.
import { test, describe } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  fwd, bash, skip, sandbox, statusline, promptHook, claudePayload, agyPayload, preInvocation, installedStatusline, runStatusline,
} from './helpers.mjs';

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
