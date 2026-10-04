import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { generate } from 'selfsigned';

/** Adresse d'écoute du serveur local : boucle locale uniquement, jamais le réseau. */
export const LOOPBACK = '127.0.0.1';

/** Certificat à régénérer : absent, illisible, expirant sous 7 jours ou ne couvrant pas 127.0.0.1. */
export function certNeedsRenewal(pem: string | undefined, now = new Date()): boolean {
  if (!pem) return true;
  try {
    const cert = new X509Certificate(pem);
    const remaining = Date.parse(cert.validTo) - now.getTime();
    return remaining < 7 * 86_400_000 || !cert.checkIP(LOOPBACK);
  } catch {
    return true;
  }
}

/**
 * Certificat TLS du serveur local, généré en Node au premier lancement (pas d'openssl sous Windows) :
 * EC P-256, 90 jours, SAN 127.0.0.1, renouvelé automatiquement. Il n'est jamais ajouté au magasin de
 * certificats du système : seule la fenêtre de l'application l'accepte (empreinte épinglée).
 */
export async function ensureLocalCert(dir: string, now = new Date()) {
  const certFile = join(dir, 'local-cert.pem');
  const keyFile = join(dir, 'local-key.pem');
  const current = existsSync(certFile) && existsSync(keyFile) ? readFileSync(certFile, 'utf8') : undefined;
  if (certNeedsRenewal(current, now)) {
    const pems = await generate([{ name: 'commonName', value: LOOPBACK }], {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notBeforeDate: new Date(now.getTime() - 60_000),
      notAfterDate: new Date(now.getTime() + 90 * 86_400_000),
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 7, ip: LOOPBACK }] },
      ],
    });
    writeFileSync(keyFile, pems.private, { mode: 0o600 });
    writeFileSync(certFile, pems.cert, { mode: 0o600 });
  }
  return { certFile, keyFile, certPem: readFileSync(certFile, 'utf8') };
}

const pemBody = (pem: string) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');

/** Épinglage : le certificat présenté doit être exactement celui généré pour cette installation. */
export function isPinned(presentedPem: string, expectedPem: string): boolean {
  return pemBody(presentedPem) !== '' && pemBody(presentedPem) === pemBody(expectedPem);
}

/** URL de l'application : même origine exacte que le serveur local (schéma, hôte, port). */
export function isAppUrl(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Permissions de la fenêtre : uniquement l'écriture dans le presse-papiers (boutons « Copier »),
 * pour l'origine locale. Lecture du presse-papiers par script, caméra, notifications… : refusées
 * (le collage au clavier n'a besoin d'aucune permission).
 */
export function permissionAllowed(
  permission: string,
  requestingUrl: string | undefined,
  origin: string,
): boolean {
  return permission === 'clipboard-sanitized-write' && !!requestingUrl && isAppUrl(requestingUrl, origin);
}

/** Lien externe ouvrable dans le navigateur du système (console AWS…) : HTTPS uniquement, hors boucle locale. */
export function isExternalHttps(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username
    );
  } catch {
    return false;
  }
}

/** Port local : celui de l'installation (origine stable pour les préférences), sinon un port libre. */
export function pickPort(preferred: number): Promise<number> {
  const tryListen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen(port, LOOPBACK, () => {
        const address = srv.address();
        srv.close(() => resolve(typeof address === 'object' && address ? address.port : port));
      });
    });
  return tryListen(preferred).catch(() => tryListen(0));
}
