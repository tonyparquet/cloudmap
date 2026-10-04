import { masterKeyCheck, rewrapEnvelope } from '@cloudmap/security';
import { checkMasterKey, keyVersion, openDb, rewrapAll, setMeta, type Db } from './index.ts';

export { openDb };

/**
 * Rotation de la clé maître (commande CLI `rotate-master-key`) : chaque clé de données (DEK) est
 * déchiffrée avec l'ancienne clé maître puis rechiffrée avec la nouvelle, dans une transaction unique.
 * Les données chiffrées elles-mêmes ne changent pas. Concerne les identifiants mémorisés et les secrets TOTP.
 */
export function rotateMasterKey(
  db: Db,
  oldKey: Buffer,
  newKey: Buffer,
): { credentials: number; totp: number; version: number } {
  const problem = checkMasterKey(db, oldKey);
  if (problem) throw new Error(`Ancienne clé incorrecte : ${problem}`);
  if (oldKey.equals(newKey)) throw new Error('La nouvelle clé maître doit différer de l’ancienne');
  const version = keyVersion(db) + 1;
  let counts = { credentials: 0, totp: 0 };
  db.transaction(() => {
    counts = rewrapAll(db, (env, aad) => rewrapEnvelope(oldKey, newKey, version, env, aad), version);
    setMeta(db, 'master_key_check', masterKeyCheck(newKey));
    setMeta(db, 'master_key_version', String(version));
  })();
  return { ...counts, version };
}
