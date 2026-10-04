import { readFileSync } from 'node:fs';

declare const __CARTO_VERSION__: string | undefined;

/** Version du produit : injectée à la construction (esbuild), sinon lue dans le package.json racine. */
export const APP_VERSION: string =
  typeof __CARTO_VERSION__ === 'string'
    ? __CARTO_VERSION__
    : (
        JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
          version: string;
        }
      ).version;

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Comparaison semver (version préliminaire < version finale) ; `null` si l'une est invalide. */
export function compareVersions(a: string, b: string): number | null {
  const x = SEMVER.exec(a.trim());
  const y = SEMVER.exec(b.trim());
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return Math.sign(d);
  }
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  return x[4] < y[4] ? -1 : 1;
}
