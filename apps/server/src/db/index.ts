import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { masterKeyCheck } from '@carto/security';
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
 * Vérifie que la clé maître est celle qui a chiffré les données existantes ; enregistre son empreinte
 * au premier démarrage. Renvoie un message d'erreur si elle ne correspond pas.
 */
export function checkMasterKey(db: Db, masterKey: Buffer): string | undefined {
  const expected = getMeta(db, 'master_key_check');
  const actual = masterKeyCheck(masterKey);
  if (!expected) {
    setMeta(db, 'master_key_check', actual);
    setMeta(db, 'master_key_version', '1');
    return undefined;
  }
  return expected === actual
    ? undefined
    : 'La clé maître (MASTER_KEY_FILE) ne correspond pas aux données chiffrées existantes de DATA_DIR';
}
