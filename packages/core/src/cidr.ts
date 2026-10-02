/** Outils IPv4 minimalistes pour l'inférence des flux (les plages IPv6 sont traitées comme « tout » ou ignorées). */

export interface Cidr {
  start: number;
  end: number;
}

export function ipToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const v = Number(p);
    if (v > 255) return undefined;
    n = n * 256 + v;
  }
  return n;
}

/** Accepte `a.b.c.d/n` ou une adresse seule (/32). */
export function parseCidr(text: string): Cidr | undefined {
  const [ip, bitsText] = text.trim().split('/');
  const base = ipToInt(ip ?? '');
  const bits = bitsText === undefined ? 32 : Number(bitsText);
  if (base === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return undefined;
  const size = 2 ** (32 - bits);
  const start = base - (base % size);
  return { start, end: start + size - 1 };
}

export function cidrContains(outer: string, inner: string): boolean {
  const a = parseCidr(outer);
  const b = parseCidr(inner);
  return !!a && !!b && a.start <= b.start && b.end <= a.end;
}

export function cidrOverlaps(x: string, y: string): boolean {
  const a = parseCidr(x);
  const b = parseCidr(y);
  return !!a && !!b && a.start <= b.end && b.start <= a.end;
}

export const isAnyCidr = (c: string) => c === '0.0.0.0/0' || c === '::/0';

/** Adresse IPv4 privée (RFC 1918) : les flux observés vers d'autres IP sont rattachés à « Internet ». */
export function isPrivateIpv4(ip: string): boolean {
  return ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'].some((c) => cidrContains(c, ip));
}
