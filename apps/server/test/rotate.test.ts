import { randomBytes } from 'node:crypto';
import { decryptEnvelope, envelopeSchema, masterKeyCheck } from '@cloudmap/security';
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

  it('données d’avant le renommage en CloudMap : migrées au démarrage, même clé maître', () => {
    // Enveloppes et empreinte produites par la version 1.1.0 (sel et libellé d'origine).
    const key = Buffer.from('BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=', 'base64');
    const legacy = {
      check: 'bCTc/00l7BE6i/6v4ePQwztWuCT0rQLv1KhR/mm1od4=',
      credential: {
        v: 1,
        iv: 'MFkI53l5PYcbVbla',
        ct: 'mTshVT3YLrest+drSkUKjnV13CPjDm2qCFrFOBLiS/iN37EcNVBp1T2lNIkh6HKONMZ6P/iwIIQHVuR/POTGkw==',
        tag: 'RzUcyUcuLhQoItJI9Gwkuw==',
        dekIv: 'djCu8xMyyg0nYbYw',
        dek: 'IZD6e9wUEh2sDeq2gkDPT/eSMiijPyJJWx730dfOO+A=',
        dekTag: 'c9c6fbBrTdt87fLLbHG1Zw==',
      },
      totp: {
        v: 1,
        iv: '9tAtPoKOKQQyfrh3',
        ct: '2xHfCoNsGz3QdLlwmE5qMg==',
        tag: 'pI3lk1lx/Fw9B1AhkeujvA==',
        dekIv: '4G3I2MdhmgXahuGZ',
        dek: '3pgcMQ8PTShrczJp14SQoI+kzgVH4OJo0oZY59Fa+Pc=',
        dekTag: 'vQYinyyjNoSBfOQKqvaI1A==',
      },
    };
    const { env } = testEnv();
    const db = openDb(env.DATA_DIR as string);
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('master_key_check', ?), ('master_key_version', '1')",
    ).run(legacy.check);
    db.prepare("INSERT INTO profiles (id, data, created_at, updated_at) VALUES ('p1', '{}', 'x', 'x')").run();
    db.prepare(
      "INSERT INTO credentials (ref, profile_id, kind, envelope, key_version, created_at) VALUES ('ref1', 'p1', 'user', ?, 1, 'x')",
    ).run(JSON.stringify(legacy.credential));
    db.prepare(
      "INSERT INTO users (id, username, role, totp_secret, created_at, updated_at) VALUES ('u1', 'admin', 'admin', ?, 'x', 'x')",
    ).run(JSON.stringify(legacy.totp));
    expect(() => decryptEnvelope(key, envelopeSchema.parse(legacy.credential), 'p1|ref1')).toThrow();

    expect(checkMasterKey(db, randomBytes(32))).toMatch(/ne correspond pas/);
    expect(checkMasterKey(db, key)).toBeUndefined();
    const cred = db.prepare('SELECT envelope FROM credentials').get() as { envelope: string };
    const totp = db.prepare('SELECT totp_secret FROM users').get() as { totp_secret: string };
    const secret = decryptEnvelope(key, envelopeSchema.parse(JSON.parse(cred.envelope)), 'p1|ref1');
    expect(JSON.parse(secret.toString()).secretAccessKey).toBe('secret-de-test');
    expect(
      decryptEnvelope(key, envelopeSchema.parse(JSON.parse(totp.totp_secret)), 'totp|u1').toString(),
    ).toBe('JBSWY3DPEHPK3PXP');
    // Empreinte mise à jour : démarrages suivants sans migration.
    expect(db.prepare("SELECT value FROM meta WHERE key = 'master_key_check'").get()).toEqual({
      value: masterKeyCheck(key),
    });
    expect(checkMasterKey(db, key)).toBeUndefined();
    db.close();
  });
});
