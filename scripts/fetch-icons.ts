/**
 * Récupère les packs d'icônes officiels AWS, Azure et Google Cloud et copie les SVG utiles dans
 * config/icons/<fournisseur>/<nom>.svg selon config/icons/map.yaml.
 * URL par fournisseur : AWS_ICONS_URL / AZURE_ICONS_URL / GCP_ICONS_URL, sinon découverte sur la
 * page officielle. En cas d'échec d'un pack, l'application utilise les icônes génériques de
 * config/icons/generic/ (repli par catégorie) : la récupération d'un pack n'est jamais bloquante.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const configDir = process.env.CONFIG_DIR ?? join(root, 'config');

/** Normalise un nom de base de fichier du pack et une valeur de map vers une clé commune. */
type Norm = (s: string) => string;

interface Provider {
  /** URL du pack (ou découverte depuis la page officielle). */
  url: () => Promise<string>;
  norm: Norm;
}

async function discover(pageUrl: string, re: RegExp): Promise<string> {
  const html = await (await fetch(pageUrl, { redirect: 'follow' })).text();
  const m = re.exec(html);
  if (!m) throw new Error(`lien du pack introuvable sur ${pageUrl}`);
  return m[0];
}

const PROVIDERS: Record<string, Provider> = {
  aws: {
    url: () =>
      process.env.AWS_ICONS_URL
        ? Promise.resolve(process.env.AWS_ICONS_URL)
        : discover(
            'https://aws.amazon.com/architecture/icons/',
            /https:\/\/[^"'\s]+(?:Icon-package|Asset-Package)[^"'\s]*\.zip/i,
          ),
    // Nom de fichier exact (avec .svg).
    norm: (s) => s.toLowerCase().trim(),
  },
  azure: {
    url: () =>
      process.env.AZURE_ICONS_URL
        ? Promise.resolve(process.env.AZURE_ICONS_URL)
        : discover(
            'https://learn.microsoft.com/en-us/azure/architecture/icons/',
            /https:\/\/[^"'\s]+Azure_Public_Service_Icons[^"'\s]*\.zip/i,
          ),
    // Fichiers `NNNNN-icon-service-<Suffixe>.svg` : on ignore le préfixe numérique et l'extension.
    norm: (s) =>
      s
        .toLowerCase()
        .replace(/^\d+-icon-service-/, '')
        .replace(/\.svg$/, '')
        .trim(),
  },
  gcp: {
    url: () =>
      Promise.resolve(
        process.env.GCP_ICONS_URL ??
          'https://services.google.com/fh/files/misc/google-cloud-legacy-icons.zip',
      ),
    // Nom de base sans extension (`compute_engine.svg` → `compute_engine`).
    norm: (s) =>
      s
        .toLowerCase()
        .replace(/\.svg$/, '')
        .trim(),
  },
};

async function fetchPack(provider: string, icons: Record<string, string>): Promise<void> {
  const def = PROVIDERS[provider];
  if (!def) {
    console.warn(`  fournisseur inconnu dans map.yaml : ${provider} (ignoré)`);
    return;
  }
  const url = await def.url();
  if (!url.startsWith('https://')) throw new Error('URL du pack non HTTPS');
  console.log(`[${provider}] téléchargement de ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()), {
    filter: (f) => f.name.toLowerCase().endsWith('.svg'),
  });
  // Clé normalisée → contenu. En cas de doublon, la première occurrence suffit.
  const byKey = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(files)) {
    const key = def.norm(basename(path));
    if (!byKey.has(key)) byKey.set(key, data);
  }
  const out = join(configDir, 'icons', provider);
  mkdirSync(out, { recursive: true });
  let copied = 0;
  for (const [icon, value] of Object.entries(icons)) {
    if (!/^[\w-]{1,40}$/.test(icon)) continue;
    const data = byKey.get(def.norm(value));
    if (!data) {
      console.warn(`  absent du pack : « ${value} » (icône « ${icon} » : repli générique)`);
      continue;
    }
    writeFileSync(join(out, `${icon}.svg`), data);
    copied++;
  }
  console.log(`[${provider}] ${copied}/${Object.keys(icons).length} icône(s) copiée(s) dans ${out}`);
}

async function main(): Promise<void> {
  const map = parse(readFileSync(join(configDir, 'icons', 'map.yaml'), 'utf8')) as Record<
    string,
    Record<string, string>
  >;
  for (const [provider, icons] of Object.entries(map)) {
    if (!icons || typeof icons !== 'object') continue;
    await fetchPack(provider, icons).catch((err: Error) =>
      console.warn(`[${provider}] pack indisponible (${err.message}) : icônes génériques utilisées.`),
    );
  }
}

main().catch((err: Error) => {
  console.warn(
    `Récupération des icônes impossible (${err.message}) : les icônes génériques seront utilisées.`,
  );
});
