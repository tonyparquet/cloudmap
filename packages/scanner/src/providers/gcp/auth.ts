import { sign } from 'node:crypto';
import { ReadOnlyHttp } from '../http.ts';

/** Jeton OAuth Google Cloud (porteur), utilisable pour un scan en lecture seule. */
export interface GcpToken {
  provider: 'gcp';
  accessToken: string;
  expiration?: Date;
  /** Portée lecture seule garantie (jeton obtenu par l'application depuis un compte de service). */
  readOnlyScope?: boolean;
}

/** Portée lecture seule : Google refuse toute écriture, quels que soient les rôles IAM. */
export const GCP_READ_ONLY_SCOPE = 'https://www.googleapis.com/auth/cloud-platform.read-only';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

interface ServiceAccountKey {
  type: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** Clé JSON de compte de service : échange immédiat contre un jeton de portée lecture seule (1 h). */
export async function gcpTokenFromServiceAccount(
  json: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GcpToken> {
  let key: ServiceAccountKey;
  try {
    key = JSON.parse(json) as ServiceAccountKey;
  } catch {
    throw new Error('Clé de compte de service illisible (JSON attendu)');
  }
  if (key.type !== 'service_account' || !key.client_email || !key.private_key)
    throw new Error('Clé de compte de service incomplète');
  // Le JSON vient de l'utilisateur : le jeton n'est demandé qu'à Google (pas de token_uri arbitraire).
  if (key.token_uri && key.token_uri !== TOKEN_URI) throw new Error('token_uri inattendu dans la clé');
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email,
    scope: GCP_READ_ONLY_SCOPE,
    aud: TOKEN_URI,
    iat: now,
    exp: now + 3600,
  })}`;
  const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url')}`;
  const res = await fetchImpl(TOKEN_URI, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data.access_token)
    throw new Error(`Authentification Google Cloud refusée (${data.error ?? res.status})`);
  return {
    provider: 'gcp',
    accessToken: data.access_token,
    expiration: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
    readOnlyScope: true,
  };
}

/** Jeton collé (`gcloud auth print-access-token`) : durée de vie d'une heure au plus. */
export function gcpTokenFromPasted(accessToken: string): GcpToken {
  if (!/^ya29\.[\w.-]{20,4096}$/.test(accessToken)) throw new Error('Jeton Google Cloud invalide (ya29.…)');
  return { provider: 'gcp', accessToken, expiration: new Date(Date.now() + 3600 * 1000) };
}

export interface GcpProject {
  projectId: string;
  name: string;
  displayName?: string;
  state?: string;
  parent?: string;
}

export async function gcpProject(
  token: GcpToken,
  projectId: string,
  fetchImpl?: typeof fetch,
): Promise<GcpProject> {
  const http = new ReadOnlyHttp('gcp', token.accessToken, fetchImpl);
  return http.get<GcpProject>(
    `https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(projectId)}`,
  );
}

/** Droits IAM d'écriture sur le projet (avertissement ; sans effet si le jeton est en lecture seule). */
export async function gcpHasWriteAccess(
  token: GcpToken,
  projectId: string,
  fetchImpl?: typeof fetch,
): Promise<boolean | undefined> {
  try {
    const http = new ReadOnlyHttp('gcp', token.accessToken, fetchImpl);
    const out = await http.query<{ permissions?: string[] }>(
      `https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(projectId)}:testIamPermissions`,
      {
        permissions: [
          'resourcemanager.projects.update',
          'compute.instances.delete',
          'storage.buckets.delete',
        ],
      },
    );
    return (out.permissions ?? []).length > 0;
  } catch {
    return undefined;
  }
}
