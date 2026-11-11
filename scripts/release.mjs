// Releases plugins with Changesets, the same way on your machine and in CI.
//
//   npm run release               Versions any pending changesets (bumps,
//                                 CHANGELOGs, manifests, the marketplace's
//                                 pinned ref), commits "Version packages" and
//                                 pushes main, then publishes (below). CI runs
//                                 this on every push to main.
//   npm run release -- --publish  Publish only: tags and releases what is
//                                 untagged, without versioning.
//
// Publishing runs `changeset publish`, which tags each plugin whose version
// has no <plugin>@<version> tag yet (plugins are private packages, so nothing
// goes to npm). Then, for each plugin's current version, it pushes the tag if
// origin lacks it, and creates the GitHub release if there is none, titled
// "<plugin> <version>", with that version's CHANGELOG entry as the notes. So
// a run that failed halfway is completed by the next one, and a run with
// nothing new does nothing.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const changesetBin = path.join(root, 'node_modules', '@changesets', 'cli', 'bin.js');
const publishOnly = process.argv.includes('--publish');

function run(cmd, args, { capture = false, shell = false } = {}) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', shell });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    if (capture) process.stderr.write(r.stderr ?? '');
    throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
  }
  return capture ? r.stdout.trim() : '';
}
const git = (...args) => run('git', args, { capture: true });
// The tests stand in a fake gh, a Node script, since a .cmd can't run here
// without a shell on Windows.
const ghCommand = (args) => (process.env.RELEASE_FAKE_GH ? [process.execPath, [process.env.RELEASE_FAKE_GH, ...args]] : ['gh', args]);
const gh = (...args) => run(...ghCommand(args));
const ghSucceeds = (...args) => spawnSync(...ghCommand(args), { cwd: root, stdio: 'ignore' }).status === 0;
const tags = () => new Set(git('tag', '--list').split('\n').filter(Boolean));

// Each plugin's name, version and folder, from plugins/*/package.json.
function plugins() {
  const list = [];
  for (const dir of fs.readdirSync(path.join(root, 'plugins'))) {
    const pkg = path.join(root, 'plugins', dir, 'package.json');
    if (!fs.existsSync(pkg)) continue;
    const { name, version } = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    list.push({ name, version, dir: path.join(root, 'plugins', dir) });
  }
  return list;
}

// The "## <version>" section of a CHANGELOG, without its heading.
export function changelogEntry(changelog, version) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

function pendingChangesets() {
  return fs.readdirSync(path.join(root, '.changeset')).filter((f) => f.endsWith('.md') && f !== 'README.md');
}

function versionPackages() {
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') throw new Error('release from main');
  if (git('status', '--porcelain')) throw new Error('commit or stash your changes first');
  run('git', ['fetch', '--quiet', 'origin', 'main']);
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
    // In CI, a newer push is already queued and its run will release.
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log('release: main has moved on, leaving this to the run for the newer push');
      return false;
    }
    throw new Error('main and origin/main differ: pull or push first');
  }

  const pending = pendingChangesets();
  if (pending.length === 0) {
    console.log('release: no changesets to version, publishing what is untagged');
    return true;
  }
  console.log(`release: versioning ${pending.length} changeset(s)`);
  run('npm', ['run', '--silent', 'version-packages'], { shell: process.platform === 'win32' });
  run('git', ['add', '--all']);
  run('git', ['commit', '--quiet', '-m', 'Version packages']);
  run('git', ['push', '--quiet', 'origin', 'main']);
  return true;
}

function publish() {
  run(process.execPath, [changesetBin, 'publish']);
  const local = tags();
  let released = 0;
  for (const { name, version, dir } of plugins()) {
    const tag = `${name}@${version}`;
    if (!local.has(tag)) continue;
    if (!git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) run('git', ['push', '--quiet', 'origin', `refs/tags/${tag}`]);
    if (ghSucceeds('release', 'view', tag)) continue;
    const changelog = path.join(dir, 'CHANGELOG.md');
    const notes = (fs.existsSync(changelog) && changelogEntry(fs.readFileSync(changelog, 'utf8'), version)) || `${name} ${version}`;
    const notesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'release-')), 'notes.md');
    fs.writeFileSync(notesFile, notes + '\n');
    gh('release', 'create', tag, '--verify-tag', '--title', `${name} ${version}`, '--notes-file', notesFile);
    console.log(`release: ${tag} released`);
    released++;
  }
  if (released === 0) console.log('release: nothing new to release');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (publishOnly || versionPackages()) publish();
  } catch (e) {
    console.error(`release: ${e.message}`);
    process.exit(1);
  }
}
