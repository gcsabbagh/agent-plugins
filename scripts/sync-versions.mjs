// Runs after `changeset version` (npm run version-packages). For each plugin
// with a package.json, which Changesets bumps:
//   - copies its version into the agent manifests that also carry it
//   - pins its Claude Code marketplace entry to its release tag,
//     <plugin>@<version>, so Claude Code installs exactly the release instead
//     of whatever main has. The tag is created on the same "Version packages"
//     commit, right after.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifests = ['.claude-plugin/plugin.json', '.antigravity-plugin/plugin.json'];
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

const plugins = new Map();
for (const dir of fs.readdirSync(path.join(root, 'plugins'))) {
  const pkgFile = path.join(root, 'plugins', dir, 'package.json');
  if (!fs.existsSync(pkgFile)) continue;
  const { name, version } = readJson(pkgFile);
  let repository;
  for (const rel of manifests) {
    const file = path.join(root, 'plugins', dir, rel);
    if (!fs.existsSync(file)) continue;
    const manifest = readJson(file);
    repository ??= manifest.repository;
    if (manifest.version === version) continue;
    manifest.version = version;
    writeJson(file, manifest);
    console.log(`${name}: ${rel} -> ${version}`);
  }
  plugins.set(name, { dir, version, repository });
}

const marketplaceFile = path.join(root, '.claude-plugin', 'marketplace.json');
if (fs.existsSync(marketplaceFile)) {
  const marketplace = readJson(marketplaceFile);
  let changed = false;
  for (const entry of marketplace.plugins ?? []) {
    const plugin = plugins.get(entry.name);
    if (!plugin?.repository) continue;
    // A full https URL: Claude Code clones it without credentials, where
    // owner/repo shorthand tries SSH first.
    const url = plugin.repository.endsWith('.git') ? plugin.repository : `${plugin.repository}.git`;
    const source = { source: 'git-subdir', url, path: `plugins/${plugin.dir}`, ref: `${entry.name}@${plugin.version}` };
    if (JSON.stringify(entry.source) === JSON.stringify(source)) continue;
    entry.source = source;
    changed = true;
    console.log(`${entry.name}: marketplace entry -> ${source.ref}`);
  }
  if (changed) writeJson(marketplaceFile, marketplace);
}
