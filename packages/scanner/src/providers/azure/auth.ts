import { ReadOnlyHttp } from '../http.ts';

/** Jeton Azure Resource Manager (porteur), utilisable pour un scan en lecture seule. */
export interface AzureToken {
  provider: 'azure';
  accessToken: string;
  expiration?: Date;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ARM = 'https://management.azure.com';

/** Revendications d'un JWT (sans vérification de signature : Azure la vérifie à chaque appel). */
export function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) throw new Error('Jeton invalide');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Jeton collé (`az account get-access-token`) : audience Azure Resource Manager et date d'expiration. */
export function azureTokenFromPasted(accessToken: string, now = Date.now()): AzureToken {
  const claims = jwtClaims(accessToken);
  const aud = String(claims.aud ?? '').replace(/\/$/, '');
  if (aud !== ARM && aud !== 'https://management.core.windows.net')
    throw new Error('Ce jeton ne vise pas Azure Resource Manager (az account get-access-token)');
  const exp = typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : undefined;
  if (exp && exp.getTime() <= now) throw new Error('Jeton expiré');
  return { provider: 'azure', accessToken, ...(exp ? { expiration: exp } : {}) };
}

/** Principal de service (secret client) : échange immédiat contre un jeton temporaire. */
export async function azureTokenFromSecret(
  sp: { tenantId: string; clientId: string; clientSecret: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AzureToken> {
  if (!GUID.test(sp.tenantId) || !GUID.test(sp.clientId)) throw new Error('Tenant ou client invalide');
  const res = await fetchImpl(`https://login.microsoftonline.com/${sp.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: sp.clientId,
      client_secret: sp.clientSecret,
      scope: `${ARM}/.default`,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data.access_token)
    throw new Error(`Authentification Azure refusée (${data.error ?? res.status})`);
  return {
    provider: 'azure',
    accessToken: data.access_token,
    expiration: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
  };
}

export interface AzureSubscription {
  subscriptionId: string;
  displayName: string;
  tenantId: string;
  state: string;
}

export async function azureSubscription(
  token: AzureToken,
  subscriptionId: string,
  fetchImpl?: typeof fetch,
): Promise<AzureSubscription> {
  const http = new ReadOnlyHttp('azure', token.accessToken, fetchImpl);
  return http.get<AzureSubscription>(
    `${ARM}/subscriptions/${encodeURIComponent(subscriptionId)}?api-version=2022-12-01`,
  );
}

/**
 * Droits d'écriture sur l'abonnement (avertissement non bloquant, comme SimulatePrincipalPolicy) :
 * une action « * » ou se terminant par write / delete / action, hors notActions.
 */
export async function azureHasWriteAccess(
  token: AzureToken,
  subscriptionId: string,
  fetchImpl?: typeof fetch,
): Promise<boolean | undefined> {
  try {
    const http = new ReadOnlyHttp('azure', token.accessToken, fetchImpl);
    const out = await http.get<{ value: { actions: string[]; notActions: string[] }[] }>(
      `${ARM}/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`,
    );
    const writes = (a: string) => a === '*' || /\/(write|delete|action|\*)$/i.test(a);
    return out.value.some((p) => p.actions.some((a) => writes(a) && !p.notActions.includes(a)));
  } catch {
    return undefined;
  }
}
