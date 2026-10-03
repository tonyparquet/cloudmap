import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMasterKey } from '@carto/security';

/** Sous-ensemble de `safeStorage` d'Electron (injecté pour les tests). */
export interface SecretBox {
  isEncryptionAvailable(): boolean;
  /** Linux : « basic_text » signifie qu'aucun trousseau n'est disponible (chiffrement fictif). */
  backend?: string;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * Clé maître de l'installation (chiffrement d'enveloppe des identifiants mémorisés), créée au premier
 * lancement. Windows et macOS : chiffrée par le système (DPAPI, Trousseau) et jamais écrite en clair.
 * Linux sans trousseau : fichier en 0600, comme `MASTER_KEY_FILE` du déploiement serveur.
 */
export function loadOrCreateMasterKey(
  dir: string,
  box: SecretBox,
): { key: Buffer; storage: 'systeme' | 'fichier' } {
  const sealed = join(dir, 'cle-maitre.chiffree');
  const plainFile = join(dir, 'cle-maitre.txt');
  const systemStore = box.isEncryptionAvailable() && box.backend !== 'basic_text';
  if (existsSync(sealed)) {
    if (!box.isEncryptionAvailable())
      throw new Error('Trousseau du système indisponible : impossible de déchiffrer la clé maître');
    return { key: parseMasterKey(box.decryptString(readFileSync(sealed))), storage: 'systeme' };
  }
  if (existsSync(plainFile))
    return { key: parseMasterKey(readFileSync(plainFile, 'utf8')), storage: 'fichier' };
  const key = randomBytes(32);
  if (systemStore) {
    writeFileSync(sealed, box.encryptString(key.toString('base64')), { mode: 0o600 });
    return { key, storage: 'systeme' };
  }
  writeFileSync(plainFile, key.toString('base64'), { mode: 0o600 });
  return { key, storage: 'fichier' };
}
