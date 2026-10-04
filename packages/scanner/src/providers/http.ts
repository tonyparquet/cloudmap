import { redactString } from '@carto/security';

/**
 * Client HTTP en lecture seule des fournisseurs Azure et Google Cloud : uniquement GET, plus les
 * quelques POST de *requête* listés ci-dessous (aucune modification possible), vers les hôtes de
 * gestion du fournisseur. Tout autre appel est refusé avant d'atteindre le réseau ; le test de
 * liste blanche vérifie qu'aucun collecteur n'appelle `fetch` directement.
 */
export type TokenProvider = 'azure' | 'gcp';

const HOSTS: Record<TokenProvider, RegExp> = {
  azure: /^management\.azure\.com$/,
  gcp: /^[a-z0-9-]+\.googleapis\.com$/,
};

/** POST en lecture seule : requêtes (Resource Graph) et tests de permissions (aucun effet). */
export const READ_ONLY_POSTS: Record<TokenProvider, RegExp[]> = {
  azure: [/^\/providers\/Microsoft\.ResourceGraph\/resources$/i],
  gcp: [/:testIamPermissions$/],
};

export class CloudHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Accès refusé (rôle insuffisant) : la ressource ou le service devient « inconnu », le scan continue. */
export const isCloudDenied = (err: unknown) =>
  err instanceof CloudHttpError && (err.status === 401 || err.status === 403);

export function checkReadOnly(provider: TokenProvider, method: 'GET' | 'POST', url: string): URL {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !HOSTS[provider].test(u.hostname))
    throw new Error(`Hôte non autorisé pour ${provider} : ${u.hostname}`);
  if (method === 'POST' && !READ_ONLY_POSTS[provider].some((re) => re.test(u.pathname)))
    throw new Error(`Appel en écriture refusé (lecture seule) : POST ${u.pathname}`);
  return u;
}

export class ReadOnlyHttp {
  constructor(
    private readonly provider: TokenProvider,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get<T>(url: string): Promise<T> {
    return this.request<T>('GET', url);
  }

  /** POST de requête autorisé (Resource Graph, testIamPermissions) ; tout autre POST est refusé. */
  query<T>(url: string, body: unknown): Promise<T> {
    return this.request<T>('POST', url, body);
  }

  private async request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
    const u = checkReadOnly(this.provider, method, url);
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(u, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      // Limitation de débit : nouvel essai avec attente croissante (Retry-After si fourni).
      if ((res.status === 429 || res.status === 503) && attempt < 4) {
        const wait = Number(res.headers.get('retry-after')) * 1000 || 500 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
        continue;
      }
      const text = await res.text();
      const data = (text ? JSON.parse(text) : {}) as T & {
        error?: { code?: string | number; message?: string; status?: string };
      };
      if (!res.ok) {
        const code = String(data.error?.status ?? data.error?.code ?? res.status);
        throw new CloudHttpError(
          res.status,
          code,
          redactString(data.error?.message ?? res.statusText).slice(0, 500),
        );
      }
      return data;
    }
  }
}
