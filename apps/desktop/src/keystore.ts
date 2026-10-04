import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMasterKey } from '@cloudmap/security';

/** Nom affiché de l'application. */
export const PRODUCT_NAME = 'CloudMap';

/** Nom d'avant le renommage en CloudMap : sert uniquement à reprendre une installation existante. */
export const LEGACY_NAME = 'Cartographe AWS';

export const SEALED_KEY = 'cle-maitre.chiffree';
/** Clé maître encore scellée dans le trousseau sous l'ancien nom de l'application (macOS, Linux). */
export const LEGACY_SEALED_KEY = 'cle-maitre.ancien-nom';

/**
 * Reprise d'une installation antérieure au renommage : son dossier devient celui de CloudMap. Sous
 * macOS et Linux, le trousseau rattache la clé maître scellée au nom de l'application : le fichier est
 * mis de côté pour être relu sous l'ancien nom puis rescellé (takeOverLegacyKey). Windows : la clé de
 * DPAPI est dans le dossier (« Local State ») et le suit.
 */
export function adoptLegacyInstall(appData: string, platform: NodeJS.Platform): boolean {
  const legacy = join(appData, LEGACY_NAME);
  const target = join(appData, PRODUCT_NAME);
  if (!existsSync(join(legacy, 'donnees'))) return false;
  if (existsSync(target)) {
    if (readdirSync(target).length > 0) return false;
    rmdirSync(target);
  }
  renameSync(legacy, target);
  if (platform !== 'win32' && existsSync(join(target, SEALED_KEY)))
    renameSync(join(target, SEALED_KEY), join(target, LEGACY_SEALED_KEY));
  return true;
}

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
  const sealed = join(dir, SEALED_KEY);
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

/**
 * Clé maître scellée sous l'ancien nom (ce lancement-ci tourne sous ce nom, voir main.ts) : relue, puis
 * rescellée sous le nouveau nom par `sealUnderNewName` (processus auxiliaire). Échec : l'ancien fichier
 * est conservé et la reprise retentée au lancement suivant ; la clé relue sert quand même.
 */
export async function takeOverLegacyKey(
  dir: string,
  box: SecretBox,
  sealUnderNewName: (keyBase64: string) => Promise<void>,
): Promise<Buffer | undefined> {
  const legacy = join(dir, LEGACY_SEALED_KEY);
  if (!existsSync(legacy)) return undefined;
  let text: string;
  try {
    text = box.decryptString(readFileSync(legacy));
  } catch {
    throw new Error(
      'Clé maître de l’installation précédente illisible dans le trousseau du système : aucune donnée n’a été modifiée.',
    );
  }
  const key = parseMasterKey(text);
  await sealUnderNewName(text).catch(() => undefined);
  if (existsSync(join(dir, SEALED_KEY))) rmSync(legacy);
  return key;
}

/** Processus auxiliaire : scelle sous le nom courant la clé reçue ; n'écrase jamais une clé existante. */
export function sealKeyFile(dir: string, box: SecretBox, keyBase64: string): void {
  const target = join(dir, SEALED_KEY);
  if (existsSync(target)) throw new Error('Clé maître déjà scellée');
  const key = parseMasterKey(keyBase64);
  writeFileSync(`${target}.tmp`, box.encryptString(key.toString('base64')), { mode: 0o600 });
  renameSync(`${target}.tmp`, target);
}
