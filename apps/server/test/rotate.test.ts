import { randomBytes } from 'node:crypto';
import { decryptEnvelope, envelopeSchema, masterKeyCheck } from '@carto/security';
import { describe, expect, it } from 'vitest';
import { checkMasterKey, openDb } from '../src/db/index.ts';
import { rotateMasterKey } from '../src/db/maintenance.ts';
import { Vault } from '../src/vault.ts';
import { testEnv } from './helpers.ts';

describe('rotation de la clé maître', () => {
  it('rechiffre les clés de données ; l’ancienne clé ne déchiffre plus', () => {
    const { env } = testEnv();
    const db = openDb(env.DATA_DIR as string);
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    expect(checkMasterKey(db, oldKey)).toBeUndefined();
    db.prepare("INSERT INTO profiles (id, data, created_at, updated_at) VALUES ('p1', '{}', 'x', 'x')").run();
    const vault = new Vault(db, oldKey, { memoryTtlMinutes: 60, defaultDurationSeconds: 3600 }, 'none');
    vault.storeEncrypted(
      'p1',
      'ref1',
      'user',
      { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'secret-de-test' },
      'admin',
    );

    expect(() => rotateMasterKey(db, randomBytes(32), newKey)).toThrow(/Ancienne clé incorrecte/);
    const r = rotateMasterKey(db, oldKey, newKey);
    expect(r).toMatchObject({ credentials: 1, version: 2 });

    const row = db.prepare('SELECT envelope, key_version FROM credentials').get() as {
      envelope: string;
      key_version: number;
    };
    const env2 = envelopeSchema.parse(JSON.parse(row.envelope));
    expect(row.key_version).toBe(2);
    expect(JSON.parse(decryptEnvelope(newKey, env2, 'p1|ref1').toString()).secretAccessKey).toBe(
      'secret-de-test',
    );
    expect(() => decryptEnvelope(oldKey, env2, 'p1|ref1')).toThrow();
    expect(checkMasterKey(db, newKey)).toBeUndefined();
    expect(checkMasterKey(db, oldKey)).toMatch(/ne correspond pas/);
    expect(masterKeyCheck(newKey)).not.toBe(masterKeyCheck(oldKey));
    db.close();
  });
});
