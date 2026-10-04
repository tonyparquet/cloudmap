import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Protection SSRF des sondes HTTP(S) (section 4.6) :
 * HTTPS uniquement par défaut, IP privées / link-local / réservées bloquées sauf option explicite,
 * adresses de métadonnées toujours bloquées, contrôle à la résolution DNS (pas de rebinding),
 * redirections suivies manuellement et revalidées, délai court.
 */

const privateRanges = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  privateRanges.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['100::', 64],
] as const) {
  privateRanges.addSubnet(net, prefix, 'ipv6');
}

/** Points de métadonnées cloud : bloqués même si le profil autorise les IP privées. */
const METADATA = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '169.254.170.23',
  'fd00:ec2::254',
  'fd00:ec2::23',
]);

/** Extrait une IPv4 encapsulée (::ffff:a.b.c.d, 64:ff9b::/96) pour la contrôler comme telle. */
function embeddedIpv4(ip: string): string | undefined {
  const lower = ip.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return undefined;
}

export function isMetadataAddress(ip: string): boolean {
  const v4 = embeddedIpv4(ip);
  return METADATA.has((v4 ?? ip).toLowerCase());
}

/** Vrai si l'adresse est privée, de bouclage, link-local, réservée ou de métadonnées. */
export function isBlockedAddress(ip: string): boolean {
  const v4 = embeddedIpv4(ip);
  if (v4) return isBlockedAddress(v4);
  const family = isIP(ip);
  if (family === 0) return true;
  if (isMetadataAddress(ip)) return true;
  return privateRanges.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

function addressAllowed(ip: string, allowPrivate: boolean): boolean {
  if (isMetadataAddress(ip)) return false;
  return allowPrivate || !isBlockedAddress(ip);
}

export interface ProbeOptions {
  allowHttp?: boolean;
  allowPrivate?: boolean;
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface ProbeResult {
  url: string;
  status?: number;
  latencyMs?: number;
  error?: string;
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean }, cb: LookupCb) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return cb(err, '');
      const refused = addresses.find((a) => !addressAllowed(a.address, allowPrivate));
      if (refused || addresses.length === 0) {
        return cb(
          Object.assign(new Error(`Adresse bloquée : ${refused?.address ?? 'aucune'}`), { code: 'EBLOCKED' }),
          '',
        );
      }
      if (options.all) return cb(null, addresses);
      const first = addresses[0] as LookupAddress;
      return cb(null, first.address, first.family);
    });
  };
}

/** Valide une URL de sonde avant toute connexion ; renvoie un message d'erreur ou undefined. */
export function checkProbeUrl(raw: string, opts: ProbeOptions = {}): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'URL invalide';
  }
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) {
    return 'Seul HTTPS est autorisé pour les sondes';
  }
  if (url.username || url.password) return 'Identifiants interdits dans l’URL';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !addressAllowed(host, opts.allowPrivate ?? false)) return `Adresse bloquée : ${host}`;
  return undefined;
}

function requestOnce(url: URL, opts: ProbeOptions): Promise<{ status: number; location?: string }> {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: 'GET',
        lookup: guardedLookup(opts.allowPrivate ?? false) as never,
        timeout: opts.timeoutMs ?? 5000,
        headers: { 'user-agent': 'cloudmap-probe', accept: '*/*' },
        agent: false,
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, location: res.headers.location });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Délai dépassé')));
    req.on('error', reject);
    req.end();
  });
}

/** Sonde GET protégée contre la SSRF. Ne lève jamais : l'erreur est renvoyée dans le résultat. */
export async function probeUrl(raw: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const started = Date.now();
  let current = raw;
  try {
    for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
      const problem = checkProbeUrl(current, opts);
      if (problem) return { url: raw, error: problem };
      const res = await requestOnce(new URL(current), opts);
      if (res.status >= 300 && res.status < 400 && res.location) {
        current = new URL(res.location, current).toString();
        continue;
      }
      return { url: raw, status: res.status, latencyMs: Date.now() - started };
    }
    return { url: raw, error: 'Trop de redirections' };
  } catch (err) {
    return { url: raw, error: err instanceof Error ? err.message : 'Erreur inconnue' };
  }
}
