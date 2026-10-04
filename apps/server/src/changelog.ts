/** Journal des modifications (CHANGELOG.md, format « Keep a Changelog », en français). */

const UNRELEASED = '## [Non publié]';
const heading = (version: string) => new RegExp(`^## \\[${version.replace(/[.]/g, '\\.')}\\][^\\n]*$`, 'm');

/** Contenu de la section d'une version (sans son titre) ; `undefined` si elle n'existe pas. */
export function changelogSection(markdown: string, version: string): string | undefined {
  const m = heading(version.replace(/^v/, '')).exec(markdown);
  if (!m) return undefined;
  const rest = markdown.slice(m.index + m[0].length);
  const next = rest.search(/^## \[/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** Publication : les entrées « Non publié » deviennent la section `version` datée, une section vide les remplace. */
export function releaseChangelog(markdown: string, version: string, date: string): string {
  if (heading(version).test(markdown)) throw new Error(`La version ${version} figure déjà dans le journal`);
  const i = markdown.indexOf(UNRELEASED);
  if (i === -1) throw new Error(`Section « ${UNRELEASED} » absente du journal`);
  const pending = changelogSection(markdown, 'Non publié') ?? '';
  if (!pending) throw new Error('Aucune entrée « Non publié » à publier');
  const after = markdown.slice(i + UNRELEASED.length);
  const next = after.search(/^## \[/m);
  const tail = next === -1 ? '' : after.slice(next);
  const out =
    `${markdown.slice(0, i)}${UNRELEASED}\n\n## [${version}] - ${date}\n\n${pending}\n\n${tail}`.replace(
      /\n{3,}/g,
      '\n\n',
    );
  // Liens de comparaison en fin de journal : « Non publié » repart de la nouvelle version.
  return out.replace(
    /^\[Non publié\]: (\S+)\/compare\/v(\S+)\.\.\.HEAD$/m,
    (_m, base: string, previous: string) =>
      `[Non publié]: ${base}/compare/v${version}...HEAD\n[${version}]: ${base}/compare/v${previous}...v${version}`,
  );
}
