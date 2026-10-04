import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Chiffrement d'enveloppe (section 4.3) :
 * - une clé de données (DEK) aléatoire par entrée chiffre la donnée en AES-256-GCM ;
 * - la DEK est chiffrée (AES-256-GCM) par une clé de chiffrement de clé (KEK) dérivée par HKDF-SHA256
 *   de la clé maître ;
 * - AAD = `profileId|credentialRef` (lié à l'entrée), IV de 12 octets aléatoires à chaque chiffrement.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const HKDF_SALT = 'cloudmap/v1';
const KEY_CHECK_LABEL = 'cloudmap key check';
/**
 * Dérivation d'avant le renommage en CloudMap (sel et libellé d'origine) : lue uniquement pour migrer
 * les données existantes au démarrage (voir upgradeLegacyEnvelope). Jamais utilisée pour chiffrer.
 */
const LEGACY_KDF = { salt: 'cartographe-aws/v1', check: 'cartographe-aws key check' } as const;

export const envelopeSchema = z.object({
  v: z.number().int().positive(),
  iv: z.string(),
  ct: z.string(),
  tag: z.string(),
  dekIv: z.string(),
  dek: z.string(),
  dekTag: z.string(),
});
export type Envelope = z.infer<typeof envelopeSchema>;

/** Décode le contenu de MASTER_KEY_FILE : exactement 32 octets encodés en base64 canonique. */
export function parseMasterKey(content: string): Buffer {
  const text = content.trim();
  const key = Buffer.from(text, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== text) {
    throw new Error(
      'La clé maître doit contenir exactement 32 octets aléatoires encodés en base64 (openssl rand -base64 32).',
    );
  }
  return key;
}

function derive(masterKey: Buffer, purpose: string, salt: string = HKDF_SALT): Buffer {
  if (masterKey.length !== KEY_BYTES) throw new Error('Clé maître invalide.');
  return Buffer.from(hkdfSync('sha256', masterKey, salt, purpose, KEY_BYTES));
}

function seal(key: Buffer, plaintext: Buffer, aad: string) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ct, tag: cipher.getAuthTag() };
}

function open(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: string): Buffer {
  if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error('Enveloppe corrompue.');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

const b64 = (b: Buffer) => b.toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64');
const wrapAad = (aad: string, version: number) => `${aad}|kek-v${version}`;

/** Chiffre `plaintext` ; `version` identifie la clé maître utilisée (rotation). */
export function encryptEnvelope(
  masterKey: Buffer,
  version: number,
  plaintext: string | Buffer,
  aad: string,
): Envelope {
  const dek = randomBytes(KEY_BYTES);
  try {
    const data = seal(dek, Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8'), aad);
    const wrapped = seal(derive(masterKey, 'kek'), dek, wrapAad(aad, version));
    return {
      v: version,
      iv: b64(data.iv),
      ct: b64(data.ct),
      tag: b64(data.tag),
      dekIv: b64(wrapped.iv),
      dek: b64(wrapped.ct),
      dekTag: b64(wrapped.tag),
    };
  } finally {
    dek.fill(0);
  }
}

function unwrapDek(masterKey: Buffer, env: Envelope, aad: string, salt: string = HKDF_SALT): Buffer {
  return open(
    derive(masterKey, 'kek', salt),
    unb64(env.dekIv),
    unb64(env.dek),
    unb64(env.dekTag),
    wrapAad(aad, env.v),
  );
}

/** Déchiffre ; lève une erreur si la clé, l'AAD ou les données ne correspondent pas. */
export function decryptEnvelope(masterKey: Buffer, env: Envelope, aad: string): Buffer {
  const dek = unwrapDek(masterKey, env, aad);
  try {
    return open(dek, unb64(env.iv), unb64(env.ct), unb64(env.tag), aad);
  } finally {
    dek.fill(0);
  }
}

/** Rotation : rechiffre uniquement la DEK avec la nouvelle clé maître (les données ne changent pas). */
export function rewrapEnvelope(
  oldKey: Buffer,
  newKey: Buffer,
  newVersion: number,
  env: Envelope,
  aad: string,
): Envelope {
  const dek = unwrapDek(oldKey, env, aad);
  try {
    const wrapped = seal(derive(newKey, 'kek'), dek, wrapAad(aad, newVersion));
    return { ...env, v: newVersion, dekIv: b64(wrapped.iv), dek: b64(wrapped.ct), dekTag: b64(wrapped.tag) };
  } finally {
    dek.fill(0);
  }
}

/** Migration : DEK d'une enveloppe de l'ancienne dérivation rechiffrée avec la dérivation courante. */
export function upgradeLegacyEnvelope(masterKey: Buffer, env: Envelope, aad: string): Envelope {
  const dek = unwrapDek(masterKey, env, aad, LEGACY_KDF.salt);
  try {
    const wrapped = seal(derive(masterKey, 'kek'), dek, wrapAad(aad, env.v));
    return { ...env, dekIv: b64(wrapped.iv), dek: b64(wrapped.ct), dekTag: b64(wrapped.tag) };
  } finally {
    dek.fill(0);
  }
}

/**
 * Empreinte de contrôle (non réversible) permettant de détecter une mauvaise clé maître au démarrage ;
 * `legacy` : empreinte de l'ancienne dérivation (données à migrer).
 */
export function masterKeyCheck(masterKey: Buffer, legacy = false): string {
  const kdf = legacy ? LEGACY_KDF : { salt: HKDF_SALT, check: KEY_CHECK_LABEL };
  return createHmac('sha256', derive(masterKey, 'key-check', kdf.salt))
    .update(kdf.check)
    .digest('base64');
}
