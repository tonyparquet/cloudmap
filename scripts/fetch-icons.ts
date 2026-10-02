/**
 * Récupère le pack officiel « AWS Architecture Icons » et copie les SVG utiles dans
 * config/icons/aws/<nom>.svg selon config/icons/map.yaml.
 * URL du pack : AWS_ICONS_URL, sinon découverte sur la page officielle des icônes.
 * En cas d'échec, l'application utilise les icônes génériques de config/icons/generic/ (sortie 0).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const configDir = process.env.CONFIG_DIR ?? join(root, 'config');
const ICONS_PAGE = 'https://aws.amazon.com/architecture/icons/';

async function packUrl(): Promise<string> {
  if (process.env.AWS_ICONS_URL) return process.env.AWS_ICONS_URL;
  const html = await (await fetch(ICONS_PAGE, { redirect: 'follow' })).text();
  const m = /https:\/\/[^"'\s]+Asset-Package[^"'\s]*\.zip/i.exec(html);
  if (!m) throw new Error('lien du pack introuvable sur la page officielle');
  return m[0];
}

async function main(): Promise<void> {
  const map = parse(readFileSync(join(configDir, 'icons', 'map.yaml'), 'utf8')) as Record<string, string>;
  const url = await packUrl();
  if (!url.startsWith('https://')) throw new Error('URL du pack non HTTPS');
  console.log(`Téléchargement de ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()), {
    filter: (f) => f.name.toLowerCase().endsWith('.svg'),
  });
  const byName = new Map(Object.entries(files).map(([path, data]) => [basename(path).toLowerCase(), data]));
  const out = join(configDir, 'icons', 'aws');
  mkdirSync(out, { recursive: true });
  let copied = 0;
  for (const [icon, file] of Object.entries(map)) {
    if (!/^[\w-]{1,40}$/.test(icon)) continue;
    const data = byName.get(file.toLowerCase());
    if (!data) {
      console.warn(`  absent du pack : ${file} (icône « ${icon} » : repli générique)`);
      continue;
    }
    writeFileSync(join(out, `${icon}.svg`), data);
    copied++;
  }
  console.log(`${copied} icône(s) copiée(s) dans ${out}`);
}

main().catch((err: Error) => {
  console.warn(`Pack d'icônes AWS indisponible (${err.message}) : les icônes génériques seront utilisées.`);
});
