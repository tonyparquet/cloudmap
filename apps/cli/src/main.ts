import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { providerIdProblems, rawSnapshotSchema, type RawSnapshot } from '@carto/core';
import {
  AZURE_SERVICES,
  azureTokenFromPasted,
  GCP_SERVICES,
  gcpTokenFromPasted,
  getCallerIdentity,
  isRootArn,
  scanAccount,
  scanAzure,
  scanGcp,
  SERVICES,
  type ScanEvent,
} from '@carto/scanner';
import { parseMasterKey } from '@carto/security';
import { openDb, rotateMasterKey } from '@carto/server/maintenance';

const USAGE = `Cartographe AWS — outil en ligne de commande

  scan --profile <profil-aws> --regions <r1,r2> [--services <s1,s2>] [--out <dossier>]
      Scan hors-ligne en lecture seule avec la chaîne d'identifiants standard du poste
      (profil ~/.aws, variables d'environnement, SSO…). Écrit snapshot-<compte>-<date>.json,
      importable dans l'interface (page « Import »).

  scan --provider azure|gcp --account <abonnement|projet> --regions <r1,r2> [--services …] [--out …]
      Azure / Google Cloud : jeton d'accès lu dans la variable CARTO_ACCESS_TOKEN (jamais en argument) :
        CARTO_ACCESS_TOKEN=$(az account get-access-token --resource https://management.azure.com --query accessToken -o tsv)
        CARTO_ACCESS_TOKEN=$(gcloud auth print-access-token)

  rotate-master-key --new-key-file <fichier> [--old-key-file <fichier>] [--data-dir <dossier>]
      Rechiffre les clés de données avec une nouvelle clé maître (serveur arrêté).
      Ancienne clé : --old-key-file ou MASTER_KEY_FILE ; données : --data-dir ou DATA_DIR.

  services AWS : ${SERVICES.map((s) => s.key).join(', ')}
  services Azure : ${AZURE_SERVICES.map((s) => s.key).join(', ')}
  services Google Cloud : ${GCP_SERVICES.map((s) => s.key).join(', ')}
`;

const onProgress = (e: ScanEvent) => {
  if (e.type === 'progress')
    process.stderr.write(`[${e.done}/${e.total}] ${e.service} ${e.region} : ${e.found} ressource(s)\n`);
  if (e.type === 'error') process.stderr.write(`  ! ${e.service} ${e.region} : ${e.message}\n`);
};

function fail(message: string): never {
  process.stderr.write(`Erreur : ${message}\n`);
  process.exit(1);
}

async function scan(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      profile: { type: 'string' },
      provider: { type: 'string', default: 'aws' },
      account: { type: 'string' },
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
  const provider = values.provider;
  if (provider !== 'aws' && provider !== 'azure' && provider !== 'gcp')
    fail('--provider : aws, azure ou gcp');
  const accountId = values.account?.trim() ?? '';
  const problems = providerIdProblems({
    provider,
    accountId: provider === 'aws' ? '000000000000' : accountId,
    regions,
  });
  if (problems.length) fail(problems.join(' ; '));
  const services = values.services
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const known = { aws: SERVICES, azure: AZURE_SERVICES, gcp: GCP_SERVICES }[provider];
  const unknown = services?.filter((s) => !known.some((x) => x.key === s));
  if (unknown?.length) fail(`service(s) inconnu(s) : ${unknown.join(', ')}`);
  const common = {
    profileId: values.profile ?? 'cli',
    regions,
    ...(services ? { services } : {}),
    onProgress,
  };

  let snapshot: RawSnapshot;
  if (provider === 'aws') snapshot = await scanAws(values.profile, common);
  else {
    const token = process.env.CARTO_ACCESS_TOKEN?.trim();
    if (!token) fail("variable CARTO_ACCESS_TOKEN absente (voir l'aide : pnpm cli)");
    process.stderr.write(
      `${provider === 'azure' ? 'Abonnement' : 'Projet'} ${accountId} — régions ${regions.join(', ')}\n`,
    );
    // Accès au compte vérifié par le scanner (refus explicite si le jeton n'y a pas accès).
    snapshot =
      provider === 'azure'
        ? await scanAzure({ ...common, accountId, credentials: azureTokenFromPasted(token) })
        : await scanGcp({ ...common, accountId, credentials: gcpTokenFromPasted(token) });
  }
  rawSnapshotSchema.parse(snapshot);
  const file = resolve(
    values.out ?? '.',
    `snapshot-${snapshot.meta.accountId}-${snapshot.meta.finishedAt.replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(file, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  process.stderr.write(
    `${snapshot.resources.length} ressource(s), ${snapshot.errors.length} erreur(s) d'accès.\n`,
  );
  process.stdout.write(`${file}\n`);
}

async function scanAws(
  profile: string | undefined,
  common: { profileId: string; regions: string[]; services?: string[]; onProgress: typeof onProgress },
): Promise<RawSnapshot> {
  const credentials = fromNodeProviderChain(profile ? { profile } : {});
  const identity = await getCallerIdentity(credentials);
  if (isRootArn(identity.arn))
    fail('identifiants du compte racine refusés : utilisez un rôle ou un utilisateur en lecture seule');
  process.stderr.write(
    `Compte ${identity.account} (${identity.arn}) — régions ${common.regions.join(', ')}\n`,
  );
  return scanAccount({ ...common, accountId: identity.account, credentials });
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
