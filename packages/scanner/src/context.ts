import type { Resource } from '@cloudmap/core';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@aws-sdk/types';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export const SCANNER_VERSION = '1.0.0';

export type Credentials = AwsCredentialIdentity | AwsCredentialIdentityProvider;

export interface ClientConfig {
  region: string;
  credentials: Credentials;
  retryMode: 'adaptive';
  maxAttempts: number;
  requestHandler: NodeHttpHandler;
}

export interface ScanError {
  service: string;
  region: string;
  code: string;
  message: string;
}

/** Contexte passé à un collecteur pour une région (ou `global`, appels en us-east-1). */
export interface CollectorContext {
  region: string;
  accountId: string;
  partition: string;
  /** Régions du profil (filtre des compartiments S3, listés globalement). */
  regions: string[];
  clientConfig: ClientConfig;
  emit(resource: Resource): void;
  /** Exécute un appel ; un refus d'accès est consigné et renvoie undefined (le scan continue). */
  tryCall<T>(permission: string, fn: () => Promise<T>): Promise<T | undefined>;
}

export interface Collector {
  /** Clé de service sélectionnable dans l'interface. */
  service: string;
  /** Collecteur global : exécuté une seule fois (région d'appel us-east-1, région des ressources `global`). */
  global?: boolean;
  collect(ctx: CollectorContext): Promise<void>;
}

export function clientConfig(region: string, credentials: Credentials): ClientConfig {
  return {
    region,
    credentials,
    retryMode: 'adaptive',
    maxAttempts: 8,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 5_000, requestTimeout: 60_000 }),
  };
}

// ------------------------------------------------------------------ erreurs

export function errorCode(err: unknown): string {
  const e = err as { name?: unknown; Code?: unknown; code?: unknown };
  for (const v of [e?.name, e?.Code, e?.code]) if (typeof v === 'string' && v && v !== 'Error') return v;
  return 'Erreur';
}

const DENIED =
  /^(AccessDenied|AccessDeniedException|UnauthorizedOperation|UnauthorizedException|AuthorizationError|AuthorizationErrorException|Forbidden|ForbiddenException|UnrecognizedClientException|InvalidClientTokenId)$/;

export function isAccessDenied(err: unknown): boolean {
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return DENIED.test(errorCode(err)) || status === 403;
}

export function isThrottling(err: unknown): boolean {
  return /Throttl|TooManyRequests|RequestLimitExceeded|SlowDown|RateExceeded/i.test(errorCode(err));
}

/** Permission manquante, extraite du message AWS si possible (« not authorized to perform: x:y »). */
export function missingPermission(err: unknown, fallback: string): string {
  const message = (err as { message?: unknown })?.message;
  const m = typeof message === 'string' ? /perform:? ([a-z0-9-]+:[A-Za-z0-9*]+)/.exec(message) : null;
  return m?.[1] ?? fallback;
}

// ------------------------------------------------------------------ données

/** Copie JSON (dates → ISO 8601, suppression des undefined et de `$metadata`). */
export function plain<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value ?? null, (k, v: unknown) => (k === '$metadata' ? undefined : v)),
  ) as T;
}

type TagList = { Key?: string; Value?: string }[] | { key?: string; value?: string }[];

export function tagsOf(
  tags: TagList | Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!tags) return undefined;
  const out: Record<string, string> = {};
  if (Array.isArray(tags)) {
    for (const t of tags as { Key?: string; Value?: string; key?: string; value?: string }[]) {
      const k = t.Key ?? t.key;
      if (k) out[k] = t.Value ?? t.value ?? '';
    }
  } else Object.assign(out, tags);
  return Object.keys(out).length ? out : undefined;
}

export async function collect<T>(pages: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const p of pages) out.push(p);
  return out;
}

export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function ec2Arn(ctx: CollectorContext, kind: string, id: string): string {
  return `arn:${ctx.partition}:ec2:${ctx.region}:${ctx.accountId}:${kind}/${id}`;
}

/** Marque une ressource dont une partie des informations est inaccessible. */
export function markUnknown(raw: Record<string, unknown>, permission: string): void {
  raw._status = 'inconnu';
  raw._statusReason = `accès refusé : ${permission}`;
}

export function resource(
  type: string,
  id: string,
  region: string,
  raw: unknown,
  extra: { arn?: string; tags?: Record<string, string> } = {},
): Resource {
  return {
    ...(extra.arn ? { arn: extra.arn } : {}),
    id,
    type,
    region,
    raw: plain(raw),
    ...(extra.tags ? { tags: extra.tags } : {}),
  };
}
