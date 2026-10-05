/**
 * Redaction (section 4.3) appliquée au logger, aux erreurs renvoyées au client et au journal d'audit.
 * Couvre : identifiants de clés d'accès, clés secrètes, jetons de session, en-têtes Authorization, cookies,
 * et pour Azure / Google Cloud : jetons JWT et OAuth, secrets clients, clés privées de comptes de service.
 */

export const MASK = '[MASQUÉ]';

const ACCESS_KEY_ID = /\b(AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|APKA|ABIA|ACCA)[A-Z0-9]{16}\b/g;
const SECRET_40 = /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;
const LONG_TOKEN = /[A-Za-z0-9/+=_-]{100,}/g;
const AUTH_SCHEME = /\b(Bearer|Basic|AWS4-HMAC-SHA256)\s+[^\s"',;]+/gi;
const NAMED_SECRET =
  /\b(aws_secret_access_key|aws_session_token|secret_?access_?key|session_?token|x-amz-security-token|authorization|password|client_?secret|access_?token|refresh_?token|private_?key|assertion)(["']?\s*[:=]\s*["']?)[^"'\s,;}&]+/gi;
const COOKIE_PAIR = /\b(__Host-[\w-]+|__Secure-[\w-]+|session|sid|csrf[\w-]*)=[^;\s"',]+/gi;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g;
// Azure et Google Cloud : jetons JWT (Entra ID), jetons OAuth Google, secrets clients d'application Entra.
const JWT = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g;
const GOOGLE_TOKEN = /\bya29\.[\w.-]{16,}/g;
const ENTRA_SECRET = /(?<![\w.~-])[\w.-]{3}\dQ~[\w.~-]{31,34}(?![\w.~-])/g;

/** Clés d'objet dont la valeur est toujours masquée. */
const SENSITIVE_KEY =
  /(secret|password|passwd|passphrase|token|authorization|cookie|credential|private.?key|session.?id|totp|otp.?secret|recovery|code.?hash|envelope|master.?key)/i;
const ACCESS_KEY_FIELD = /^access.?key.?id$/i;

/** Masque un identifiant de clé d'accès : `AKIA…7XQ2`. */
export function maskAccessKeyId(id: string): string {
  return id.length <= 8 ? MASK : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

export function redactString(s: string): string {
  return s
    .replace(PRIVATE_KEY, MASK)
    .replace(JWT, MASK)
    .replace(GOOGLE_TOKEN, MASK)
    .replace(ENTRA_SECRET, MASK)
    .replace(AUTH_SCHEME, (_m, scheme: string) => `${scheme} ${MASK}`)
    .replace(NAMED_SECRET, (_m, name: string, sep: string) => `${name}${sep}${MASK}`)
    .replace(COOKIE_PAIR, (_m, name: string) => `${name}=${MASK}`)
    .replace(LONG_TOKEN, MASK)
    .replace(ACCESS_KEY_ID, (m) => maskAccessKeyId(m))
    .replace(SECRET_40, MASK);
}

/** Copie profonde redactée d'une valeur quelconque (objets, tableaux, erreurs, chaînes). */
export function redact<T>(value: T): T {
  return walk(value, new WeakSet(), 0) as T;
}

function walk(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 12) return '[…]';
  if (seen.has(value)) return '[circulaire]';
  seen.add(value);
  if (Buffer.isBuffer(value)) return MASK;
  if (Array.isArray(value)) return value.map((v) => walk(v, seen, depth + 1));
  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: redactString(value.message) };
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string') out.code = code;
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (ACCESS_KEY_FIELD.test(k) && typeof v === 'string') out[k] = maskAccessKeyId(v);
    else if (SENSITIVE_KEY.test(k) && v !== undefined && v !== null && v !== '') out[k] = MASK;
    else out[k] = walk(v, seen, depth + 1);
  }
  return out;
}
