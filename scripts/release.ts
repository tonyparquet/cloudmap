// Publication d'une version : `pnpm release X.Y.Z` (version, CHANGELOG.md, commit, tag vX.Y.Z ; rien n'est
// poussé), ou `pnpm release notes X.Y.Z` (notes de la version, pour la release GitHub de la CI).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changelogSection, releaseChangelog } from '../apps/server/src/changelog.ts';
import { compareVersions } from '../apps/server/src/version.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const changelogFile = join(root, 'CHANGELOG.md');
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const manifests = ['package.json', join('apps', 'desktop', 'package.json')];

const [command, arg] = process.argv.slice(2);

if (command === 'notes') {
  const notes = changelogSection(readFileSync(changelogFile, 'utf8'), arg ?? '');
  if (!notes) throw new Error(`Aucune section pour la version ${arg} dans CHANGELOG.md`);
  process.stdout.write(`${notes}\n`);
} else {
  const version = (command ?? '').replace(/^v/, '');
  const current = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string })
    .version;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Usage : pnpm release X.Y.Z');
  if ((compareVersions(version, current) ?? 0) <= 0)
    throw new Error(`La version ${version} doit être supérieure à la version actuelle ${current}`);
  if (git('status', '--porcelain', '--untracked-files=no'))
    throw new Error(
      'Arbre de travail modifié : validez ou mettez de côté vos changements avant la publication',
    );
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main' && branch !== 'master')
    throw new Error(`Publication depuis main uniquement (branche : ${branch})`);

  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(changelogFile, releaseChangelog(readFileSync(changelogFile, 'utf8'), version, date));
  for (const file of manifests) {
    const path = join(root, file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(/"version": "[^"]+"/, `"version": "${version}"`));
  }
  const notes = changelogSection(readFileSync(changelogFile, 'utf8'), version) ?? '';
  git('add', 'CHANGELOG.md', ...manifests);
  git('commit', '-m', `Version ${version}`);
  git('tag', '-a', `v${version}`, '-m', `Version ${version}\n\n${notes}`);
  console.log(
    `Version ${version} prête (tag v${version}). Publication : git push origin ${branch} --follow-tags`,
  );
}
