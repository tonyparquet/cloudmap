import { createPrivateKey, X509Certificate } from 'node:crypto';
import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import type { Server } from 'node:https';
import type { SecureContextOptions } from 'node:tls';

/** TLS 1.3 uniquement (section 4.1). */
export const TLS_CIPHERS = 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256';
export const TLS_CURVES = 'X25519:P-256:P-384';

export interface TlsFiles {
  certFile: string;
  keyFile: string;
  caFile?: string;
}

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
  ca?: Buffer;
}

/** Lit et vérifie certificat et clé : lisibles, certificat valide à cette date, clé correspondante. */
export function readTlsMaterial(files: TlsFiles, now = new Date()): TlsMaterial {
  const read = (path: string, what: string) => {
    try {
      return readFileSync(path);
    } catch {
      throw new Error(`${what} illisible : ${path}`);
    }
  };
  const cert = read(files.certFile, 'Certificat TLS (TLS_CERT_FILE)');
  const key = read(files.keyFile, 'Clé TLS (TLS_KEY_FILE)');
  const ca = files.caFile ? read(files.caFile, 'Chaîne intermédiaire (TLS_CA_FILE)') : undefined;
  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(cert);
  } catch {
    throw new Error('Certificat TLS invalide (format PEM attendu)');
  }
  if (new Date(x509.validTo).getTime() <= now.getTime()) {
    throw new Error(`Certificat TLS expiré depuis le ${new Date(x509.validTo).toISOString()}`);
  }
  if (new Date(x509.validFrom).getTime() > now.getTime()) {
    throw new Error(
      `Certificat TLS pas encore valide (à partir du ${new Date(x509.validFrom).toISOString()})`,
    );
  }
  let matches: boolean;
  try {
    matches = x509.checkPrivateKey(createPrivateKey(key));
  } catch {
    throw new Error('Clé TLS invalide (format PEM attendu)');
  }
  if (!matches) throw new Error('La clé TLS ne correspond pas au certificat');
  return { cert, key, ...(ca ? { ca } : {}) };
}

export function tlsOptions(
  material: TlsMaterial,
): SecureContextOptions & { minVersion: 'TLSv1.3'; maxVersion: 'TLSv1.3' } {
  return {
    ...material,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    ciphers: TLS_CIPHERS,
    ecdhCurve: TLS_CURVES,
    honorCipherOrder: true,
  };
}

/**
 * Rechargement à chaud du certificat (renouvellement Let's Encrypt) : surveillance des dossiers des
 * fichiers (remplacement atomique), validation, puis `setSecureContext`. Un certificat invalide est ignoré.
 */
export function watchCertificate(
  server: Server,
  files: TlsFiles,
  log: { info(msg: string): void; error(msg: string): void },
): () => void {
  let timer: NodeJS.Timeout | undefined;
  const reload = () => {
    try {
      server.setSecureContext(tlsOptions(readTlsMaterial(files)));
      log.info('Certificat TLS rechargé');
    } catch (err) {
      log.error(`Rechargement du certificat TLS refusé : ${(err as Error).message}`);
    }
  };
  const watchers: FSWatcher[] = [];
  for (const dir of new Set(
    [files.certFile, files.keyFile, files.caFile].filter(Boolean).map((f) => dirname(f as string)),
  )) {
    try {
      watchers.push(
        watch(dir, () => {
          clearTimeout(timer);
          timer = setTimeout(reload, 1000);
        }),
      );
    } catch {
      log.error(`Surveillance impossible du dossier ${dir} : rechargement à chaud désactivé`);
    }
  }
  return () => {
    clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
