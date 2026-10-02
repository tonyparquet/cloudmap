import { t } from './i18n/index.ts';
import { navigate } from './router.tsx';
import { useApp } from './store.ts';

let csrf = '';
export const setCsrf = (token: string) => {
  csrf = token;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Appel de l'API : jeton CSRF sur les requêtes non-GET, redirection vers /login si la session a
 * expiré, demande de ré-authentification transparente pour les actions sensibles.
 */
export async function api<T>(method: string, url: string, body?: unknown, retried = false): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const isJson = res.headers.get('content-type')?.includes('json');
  const data: unknown = isJson ? await res.json() : await res.text();
  const obj = (isJson ? data : {}) as { csrfToken?: string; error?: { code?: string; message?: string } };
  if (obj.csrfToken) csrf = obj.csrfToken;
  if (!res.ok) {
    const err = new ApiError(
      res.status,
      obj.error?.code ?? 'ERREUR',
      obj.error?.message ?? t('commun.erreur'),
    );
    if (res.status === 401 && !url.startsWith('/api/auth/')) {
      useApp.getState().setAuth(undefined);
      navigate('/login');
    }
    if (res.status === 403 && err.code === 'REAUTH_REQUISE' && !retried) {
      await useApp.getState().requestReauth();
      return api<T>(method, url, body, true);
    }
    throw err;
  }
  return data as T;
}

export const get = <T>(url: string) => api<T>('GET', url);
export const post = <T>(url: string, body?: unknown) => api<T>('POST', url, body ?? {});
export const put = <T>(url: string, body: unknown) => api<T>('PUT', url, body);
export const del = <T>(url: string) => api<T>('DELETE', url);

/** Téléchargement d'un contenu généré dans le navigateur. */
export function download(name: string, content: Blob | string, type = 'application/octet-stream'): void {
  const blob = typeof content === 'string' ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Cellule CSV protégée contre l'injection de formules. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
