import { envelopeSchema, masterKeyCheck, rewrapEnvelope } from '@carto/security';
import { checkMasterKey, keyVersion, openDb, setMeta, type Db } from './index.ts';

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
  let credentials = 0;
  let totp = 0;
  db.transaction(() => {
    const creds = db.prepare('SELECT ref, profile_id, envelope FROM credentials').all() as {
      ref: string;
      profile_id: string;
      envelope: string;
    }[];
    for (const c of creds) {
      const env = envelopeSchema.parse(JSON.parse(c.envelope));
      const next = rewrapEnvelope(oldKey, newKey, version, env, `${c.profile_id}|${c.ref}`);
      db.prepare('UPDATE credentials SET envelope = ?, key_version = ? WHERE ref = ?').run(
        JSON.stringify(next),
        version,
        c.ref,
      );
      credentials++;
    }
    const users = db.prepare('SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL').all() as {
      id: string;
      totp_secret: string;
    }[];
    for (const u of users) {
      const env = envelopeSchema.parse(JSON.parse(u.totp_secret));
      const next = rewrapEnvelope(oldKey, newKey, version, env, `totp|${u.id}`);
      db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(JSON.stringify(next), u.id);
      totp++;
    }
    setMeta(db, 'master_key_check', masterKeyCheck(newKey));
    setMeta(db, 'master_key_version', String(version));
  })();
  return { credentials, totp, version };
}
