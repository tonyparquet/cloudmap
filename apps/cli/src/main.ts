import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { rawSnapshotSchema } from '@carto/core';
import { getCallerIdentity, isRootArn, scanAccount, SERVICES } from '@carto/scanner';
import { parseMasterKey } from '@carto/security';
import { openDb, rotateMasterKey } from '@carto/server/maintenance';

const USAGE = `Cartographe AWS — outil en ligne de commande

  scan --profile <profil-aws> --regions <r1,r2> [--services <s1,s2>] [--out <dossier>]
      Scan hors-ligne en lecture seule avec la chaîne d'identifiants standard du poste
      (profil ~/.aws, variables d'environnement, SSO…). Écrit snapshot-<compte>-<date>.json,
      importable dans l'interface (page « Import »).

  rotate-master-key --new-key-file <fichier> [--old-key-file <fichier>] [--data-dir <dossier>]
      Rechiffre les clés de données avec une nouvelle clé maître (serveur arrêté).
      Ancienne clé : --old-key-file ou MASTER_KEY_FILE ; données : --data-dir ou DATA_DIR.

  services : ${SERVICES.map((s) => s.key).join(', ')}
`;

function fail(message: string): never {
  process.stderr.write(`Erreur : ${message}\n`);
  process.exit(1);
}

async function scan(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      profile: { type: 'string' },
      regions: { type: 'string' },
      services: { type: 'string' },
      out: { type: 'string', default: '.' },
    },
  });
  const regions = (values.regions ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  if (regions.length === 0) fail('--regions est obligatoire (ex. --regions <région>[,<région>])');
  if (regions.some((r) => !/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/.test(r))) fail('code de région invalide');
  const services = values.services
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = services?.filter((s) => !SERVICES.some((x) => x.key === s));
  if (unknown?.length) fail(`service(s) inconnu(s) : ${unknown.join(', ')}`);

  const credentials = fromNodeProviderChain(values.profile ? { profile: values.profile } : {});
  const identity = await getCallerIdentity(credentials);
  if (isRootArn(identity.arn))
    fail('identifiants du compte racine refusés : utilisez un rôle ou un utilisateur en lecture seule');
  process.stderr.write(`Compte ${identity.account} (${identity.arn}) — régions ${regions.join(', ')}\n`);

  const snapshot = await scanAccount({
    profileId: values.profile ?? 'cli',
    accountId: identity.account,
    regions,
    ...(services ? { services } : {}),
    credentials,
    onProgress: (e) => {
      if (e.type === 'progress')
        process.stderr.write(`[${e.done}/${e.total}] ${e.service} ${e.region} : ${e.found} ressource(s)\n`);
      if (e.type === 'error') process.stderr.write(`  ! ${e.service} ${e.region} : ${e.message}\n`);
    },
  });
  rawSnapshotSchema.parse(snapshot);
  const file = resolve(
    values.out ?? '.',
    `snapshot-${identity.account}-${snapshot.meta.finishedAt.replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(file, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  process.stderr.write(
    `${snapshot.resources.length} ressource(s), ${snapshot.errors.length} erreur(s) d'accès.\n`,
  );
  process.stdout.write(`${file}\n`);
}

function rotate(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      'new-key-file': { type: 'string' },
      'old-key-file': { type: 'string' },
      'data-dir': { type: 'string' },
    },
  });
  const oldFile = values['old-key-file'] ?? process.env.MASTER_KEY_FILE;
  const newFile = values['new-key-file'];
  const dataDir = values['data-dir'] ?? process.env.DATA_DIR ?? '/data';
  if (!oldFile) fail('ancienne clé maître : --old-key-file ou MASTER_KEY_FILE');
  if (!newFile) fail('--new-key-file est obligatoire (générez-la avec : openssl rand -base64 32)');
  const db = openDb(dataDir);
  try {
    const r = rotateMasterKey(
      db,
      parseMasterKey(readFileSync(oldFile, 'utf8')),
      parseMasterKey(readFileSync(newFile, 'utf8')),
    );
    process.stdout.write(
      `Rotation effectuée (version ${r.version}) : ${r.credentials} identifiant(s) et ${r.totp} secret(s) TOTP rechiffrés.\n` +
        'Remplacez maintenant le contenu de MASTER_KEY_FILE par la nouvelle clé, puis redémarrez le serveur.\n',
    );
  } finally {
    db.close();
  }
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'scan') await scan(rest);
  else if (command === 'rotate-master-key') rotate(rest);
  else process.stdout.write(USAGE);
} catch (err) {
  fail((err as Error).message);
}
