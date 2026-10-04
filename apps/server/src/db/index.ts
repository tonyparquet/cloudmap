import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { envelopeSchema, masterKeyCheck, upgradeLegacyEnvelope, type Envelope } from '@cloudmap/security';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations/index.ts';

export type Db = Database.Database;

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'app.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    })();
  }
}

export function getMeta(db: Db, key: string): string | undefined {
  return (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)
    ?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** Version courante de la clé maître (incrémentée à chaque rotation). */
export const keyVersion = (db: Db) => Number(getMeta(db, 'master_key_version') ?? '1');

/**
 * Rechiffre chaque enveloppe de la base (identifiants mémorisés, secrets TOTP) avec `rewrap`, à
 * appeler dans une transaction. Renvoie le nombre d'enveloppes de chaque sorte.
 */
export function rewrapAll(
  db: Db,
  rewrap: (env: Envelope, aad: string) => Envelope,
  version?: number,
): { credentials: number; totp: number } {
  const creds = db.prepare('SELECT ref, profile_id, envelope FROM credentials').all() as {
    ref: string;
    profile_id: string;
    envelope: string;
  }[];
  for (const c of creds) {
    const next = rewrap(envelopeSchema.parse(JSON.parse(c.envelope)), `${c.profile_id}|${c.ref}`);
    db.prepare('UPDATE credentials SET envelope = ?, key_version = ? WHERE ref = ?').run(
      JSON.stringify(next),
      version ?? next.v,
      c.ref,
    );
  }
  const users = db.prepare('SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL').all() as {
    id: string;
    totp_secret: string;
  }[];
  for (const u of users) {
    const next = rewrap(envelopeSchema.parse(JSON.parse(u.totp_secret)), `totp|${u.id}`);
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(JSON.stringify(next), u.id);
  }
  return { credentials: creds.length, totp: users.length };
}

/**
 * Vérifie que la clé maître est celle qui a chiffré les données existantes ; enregistre son empreinte
 * au premier démarrage. Données d'avant le renommage en CloudMap : migrées vers la dérivation courante
 * (même clé maître), en une transaction. Renvoie un message d'erreur si la clé ne correspond pas.
 */
export function checkMasterKey(db: Db, masterKey: Buffer): string | undefined {
  const expected = getMeta(db, 'master_key_check');
  const actual = masterKeyCheck(masterKey);
  if (!expected) {
    setMeta(db, 'master_key_check', actual);
    setMeta(db, 'master_key_version', '1');
    return undefined;
  }
  if (expected === actual) return undefined;
  if (expected === masterKeyCheck(masterKey, true)) {
    db.transaction(() => {
      rewrapAll(db, (env, aad) => upgradeLegacyEnvelope(masterKey, env, aad));
      setMeta(db, 'master_key_check', actual);
    })();
    return undefined;
  }
  return 'La clé maître (MASTER_KEY_FILE) ne correspond pas aux données chiffrées existantes de DATA_DIR';
}
