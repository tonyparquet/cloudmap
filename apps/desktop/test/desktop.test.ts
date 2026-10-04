import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adoptLegacyInstall,
  loadOrCreateMasterKey,
  sealKeyFile,
  type SecretBox,
  takeOverLegacyKey,
} from '../src/keystore.ts';
import {
  certNeedsRenewal,
  ensureLocalCert,
  isAppUrl,
  isExternalHttps,
  isPinned,
  permissionAllowed,
} from '../src/security.ts';

const tmp = () => mkdtempSync(join(process.cwd(), '.tmp', 'desktop-'));

/** Faux trousseau : « chiffrement » réversible et traçable (le vrai est DPAPI / Keychain). */
const box = (available = true, backend?: string): SecretBox & { sealed: string[] } => {
  const sealed: string[] = [];
  return {
    sealed,
    isEncryptionAvailable: () => available,
    ...(backend ? { backend } : {}),
    encryptString: (s) => {
      sealed.push(s);
      return Buffer.from(`scellé:${Buffer.from(s).toString('hex')}`);
    },
    decryptString: (b) => Buffer.from(b.toString().replace('scellé:', ''), 'hex').toString(),
  };
};

describe('application de bureau : TLS local', () => {
  it('certificat EC P-256 pour 127.0.0.1, réutilisé puis renouvelé avant expiration', async () => {
    const dir = tmp();
    const first = await ensureLocalCert(dir);
    const cert = new X509Certificate(first.certPem);
    expect(cert.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(statSync(first.keyFile).mode & 0o077).toBe(0);
    expect((await ensureLocalCert(dir)).certPem).toBe(first.certPem);
    const later = new Date(Date.now() + 85 * 86_400_000);
    expect(certNeedsRenewal(first.certPem, later)).toBe(true);
    expect((await ensureLocalCert(dir, later)).certPem).not.toBe(first.certPem);
    expect(certNeedsRenewal('pas un certificat')).toBe(true);
  });

  it('épinglage : seul le certificat de l’installation est accepté', async () => {
    const a = await ensureLocalCert(tmp());
    const b = await ensureLocalCert(tmp());
    expect(isPinned(a.certPem.replace(/\n/g, '\r\n'), a.certPem)).toBe(true);
    expect(isPinned(b.certPem, a.certPem)).toBe(false);
    expect(isPinned('', a.certPem)).toBe(false);
  });

  it('navigation limitée à l’origine locale, liens externes HTTPS seulement', () => {
    const origin = 'https://127.0.0.1:48443';
    expect(isAppUrl('https://127.0.0.1:48443/profils', origin)).toBe(true);
    expect(isAppUrl('https://127.0.0.1:48444/', origin)).toBe(false);
    expect(isAppUrl('http://127.0.0.1:48443/', origin)).toBe(false);
    expect(isExternalHttps('https://console.aws.amazon.com/go/view?arn=x')).toBe(true);
    for (const bad of [
      'http://exemple.fr',
      'file:///etc/passwd',
      'https://127.0.0.1:1/',
      'https://u:p@x.fr',
      'javascript:alert(1)',
    ])
      expect(isExternalHttps(bad)).toBe(false);
  });
});

describe('application de bureau : permissions de la fenêtre', () => {
  it('presse-papiers en écriture seule, pour l’origine locale uniquement', () => {
    const origin = 'https://127.0.0.1:48443';
    expect(permissionAllowed('clipboard-sanitized-write', `${origin}/login`, origin)).toBe(true);
    expect(permissionAllowed('clipboard-sanitized-write', origin, origin)).toBe(true);
    expect(permissionAllowed('clipboard-sanitized-write', 'https://exemple.fr/', origin)).toBe(false);
    expect(permissionAllowed('clipboard-sanitized-write', undefined, origin)).toBe(false);
    for (const p of ['clipboard-read', 'media', 'notifications', 'geolocation', 'openExternal'])
      expect(permissionAllowed(p, `${origin}/`, origin)).toBe(false);
  });
});

describe('application de bureau : reprise d’une installation antérieure au renommage', () => {
  const legacyInstall = (appData: string) => {
    mkdirSync(join(appData, 'Cartographe AWS', 'donnees'), { recursive: true });
    writeFileSync(join(appData, 'Cartographe AWS', 'cle-maitre.chiffree'), 'scellé-ancien');
  };

  it('le dossier devient « CloudMap » ; hors Windows, la clé scellée est mise de côté', () => {
    const appData = tmp();
    expect(adoptLegacyInstall(appData, 'darwin')).toBe(false);
    legacyInstall(appData);
    mkdirSync(join(appData, 'CloudMap')); // dossier vide créé par le système : remplacé
    expect(adoptLegacyInstall(appData, 'darwin')).toBe(true);
    expect(existsSync(join(appData, 'Cartographe AWS'))).toBe(false);
    expect(existsSync(join(appData, 'CloudMap', 'donnees'))).toBe(true);
    expect(existsSync(join(appData, 'CloudMap', 'cle-maitre.chiffree'))).toBe(false);
    expect(readFileSync(join(appData, 'CloudMap', 'cle-maitre.ancien-nom'), 'utf8')).toBe('scellé-ancien');
    // Windows : clé de DPAPI dans le dossier, rien à mettre de côté.
    const win = tmp();
    legacyInstall(win);
    expect(adoptLegacyInstall(win, 'win32')).toBe(true);
    expect(existsSync(join(win, 'CloudMap', 'cle-maitre.chiffree'))).toBe(true);
    // Une installation CloudMap déjà utilisée n'est jamais écrasée.
    const both = tmp();
    legacyInstall(both);
    mkdirSync(join(both, 'CloudMap', 'donnees'), { recursive: true });
    expect(adoptLegacyInstall(both, 'darwin')).toBe(false);
    expect(existsSync(join(both, 'Cartographe AWS', 'donnees'))).toBe(true);
  });

  it('clé relue sous l’ancien nom puis rescellée ; échec : ancien fichier conservé', async () => {
    const dir = tmp();
    const key = Buffer.alloc(32, 9).toString('base64');
    const b = box();
    writeFileSync(join(dir, 'cle-maitre.ancien-nom'), b.encryptString(key));
    expect(await takeOverLegacyKey(tmp(), b, async () => undefined)).toBeUndefined();

    // Échec du processus auxiliaire : la clé sert quand même, la reprise sera retentée.
    const failed = await takeOverLegacyKey(dir, b, () => Promise.reject(new Error('refus')));
    expect(failed?.toString('base64')).toBe(key);
    expect(existsSync(join(dir, 'cle-maitre.ancien-nom'))).toBe(true);

    const sealed: string[] = [];
    const ok = await takeOverLegacyKey(dir, b, async (k) => {
      sealed.push(k);
      sealKeyFile(dir, b, k);
    });
    expect(ok?.toString('base64')).toBe(key);
    expect(sealed).toEqual([key]);
    expect(existsSync(join(dir, 'cle-maitre.ancien-nom'))).toBe(false);
    expect(loadOrCreateMasterKey(dir, b).key.toString('base64')).toBe(key);
    // Jamais d'écrasement d'une clé déjà scellée.
    expect(() => sealKeyFile(dir, b, key)).toThrow(/déjà scellée/);
    // Ancien trousseau illisible : erreur explicite, rien n'est modifié.
    writeFileSync(join(dir, 'cle-maitre.ancien-nom'), 'illisible');
    const broken = {
      ...b,
      decryptString: () => {
        throw new Error('trousseau');
      },
    };
    await expect(takeOverLegacyKey(dir, broken, async () => undefined)).rejects.toThrow(/aucune donnée/);
    expect(existsSync(join(dir, 'cle-maitre.ancien-nom'))).toBe(true);
  });
});

describe('application de bureau : clé maître', () => {
  it('chiffrée par le trousseau du système, jamais écrite en clair, relue à l’identique', () => {
    const dir = tmp();
    const b = box();
    const first = loadOrCreateMasterKey(dir, b);
    expect(first).toMatchObject({ storage: 'systeme' });
    expect(first.key).toHaveLength(32);
    expect(existsSync(join(dir, 'cle-maitre.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'cle-maitre.chiffree')).toString()).not.toContain(
      first.key.toString('base64'),
    );
    expect(loadOrCreateMasterKey(dir, b).key.equals(first.key)).toBe(true);
    expect(() => loadOrCreateMasterKey(dir, box(false))).toThrow(/Trousseau du système indisponible/);
  });

  it('Linux sans trousseau (« basic_text ») : fichier 0600, comme MASTER_KEY_FILE', () => {
    const dir = tmp();
    const b = box(true, 'basic_text');
    const r = loadOrCreateMasterKey(dir, b);
    expect(r.storage).toBe('fichier');
    expect(b.sealed).toEqual([]);
    expect(statSync(join(dir, 'cle-maitre.txt')).mode & 0o077).toBe(0);
  });
});
