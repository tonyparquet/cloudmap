import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptEnvelope,
  encryptEnvelope,
  masterKeyCheck,
  parseMasterKey,
  rewrapEnvelope,
} from '../src/index.ts';

const key = randomBytes(32);
const aad = 'profil-1|cred-1';

describe('chiffrement d’enveloppe', () => {
  it('chiffre puis déchiffre', () => {
    const env = encryptEnvelope(key, 1, 'secret-très-sensible', aad);
    expect(env.ct).not.toContain('secret');
    expect(decryptEnvelope(key, env, aad).toString('utf8')).toBe('secret-très-sensible');
  });

  it('échoue si l’AAD diffère', () => {
    const env = encryptEnvelope(key, 1, 'x', aad);
    expect(() => decryptEnvelope(key, env, 'profil-2|cred-1')).toThrow();
  });

  it('échoue si la clé diffère', () => {
    const env = encryptEnvelope(key, 1, 'x', aad);
    expect(() => decryptEnvelope(randomBytes(32), env, aad)).toThrow();
  });

  it('échoue si les données ou la version sont altérées', () => {
    const env = encryptEnvelope(key, 1, 'données', aad);
    const ct = Buffer.from(env.ct, 'base64');
    ct[0] = (ct[0] ?? 0) ^ 1;
    expect(() => decryptEnvelope(key, { ...env, ct: ct.toString('base64') }, aad)).toThrow();
    expect(() => decryptEnvelope(key, { ...env, v: 2 }, aad)).toThrow();
  });

  it('n’utilise jamais deux fois le même IV', () => {
    const ivs = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const env = encryptEnvelope(key, 1, 'x', aad);
      ivs.add(env.iv);
      ivs.add(env.dekIv);
    }
    expect(ivs.size).toBe(400);
  });

  it('supporte la rotation de la clé maître', () => {
    const env = encryptEnvelope(key, 1, 'valeur', aad);
    const newKey = randomBytes(32);
    const rotated = rewrapEnvelope(key, newKey, 2, env, aad);
    expect(rotated.v).toBe(2);
    expect(decryptEnvelope(newKey, rotated, aad).toString()).toBe('valeur');
    expect(() => decryptEnvelope(key, rotated, aad)).toThrow();
  });

  it('valide le format de la clé maître et détecte une mauvaise clé', () => {
    const b64 = key.toString('base64');
    expect(parseMasterKey(`${b64}\n`).equals(key)).toBe(true);
    expect(() => parseMasterKey('trop-court')).toThrow(/32 octets/);
    expect(() => parseMasterKey(randomBytes(16).toString('base64'))).toThrow();
    expect(masterKeyCheck(key)).toBe(masterKeyCheck(Buffer.from(b64, 'base64')));
    expect(masterKeyCheck(key)).not.toBe(masterKeyCheck(randomBytes(32)));
  });
});
