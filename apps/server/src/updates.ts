import type { AppSettings } from './config.ts';
import { compareVersions } from './version.ts';

export interface UpdateStatus {
  current: string;
  enabled: boolean;
  available: boolean;
  checkedAt?: string;
  latest?: string;
  name?: string;
  url?: string;
  publishedAt?: string;
  notes?: string;
  error?: string;
}

interface Release {
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  body?: unknown;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/**
 * Recherche de mise à jour : dernière release du flux configuré (API GitHub), consultée par le serveur
 * (la CSP interdit au navigateur tout appel externe) et mise en cache `intervalHours`. Aucune donnée
 * n'est envoyée hormis la version courante (User-Agent).
 */
export class UpdateChecker {
  private cache?: UpdateStatus;
  private inflight?: Promise<UpdateStatus>;

  constructor(
    private readonly settings: AppSettings['updates'],
    private readonly current: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get enabled() {
    return this.settings.enabled && !!this.settings.feedUrl;
  }

  /** État en cache, rafraîchi s'il date de plus de `intervalHours` (ou sur demande). */
  async status(force = false): Promise<UpdateStatus> {
    if (!this.enabled) return { current: this.current, enabled: false, available: false };
    const fresh =
      this.cache?.checkedAt &&
      Date.now() - Date.parse(this.cache.checkedAt) < this.settings.intervalHours * 3_600_000;
    if (fresh && !force && this.cache) return this.cache;
    this.inflight ??= this.check().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async check(): Promise<UpdateStatus> {
    const base = {
      current: this.current,
      enabled: true,
      available: false,
      checkedAt: new Date().toISOString(),
    };
    try {
      const res = await this.fetchImpl(this.settings.feedUrl ?? '', {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': `cartographe-aws/${this.current}`,
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const hint =
          res.status === 404 ? ' (dépôt privé : jeton UPDATES_TOKEN_FILE, ou aucune version publiée)' : '';
        throw new Error(`flux de mises à jour inaccessible : HTTP ${res.status}${hint}`);
      }
      const text = await res.text();
      if (text.length > 1_000_000) throw new Error('réponse du flux trop volumineuse');
      const release = JSON.parse(text) as Release;
      const latest = str(release.tag_name, 64)?.replace(/^v/, '');
      const url = str(release.html_url, 2048);
      if (!latest || compareVersions(latest, this.current) === null)
        throw new Error('version publiée illisible');
      this.cache = {
        ...base,
        latest,
        available: (compareVersions(latest, this.current) ?? 0) > 0,
        ...(url?.startsWith('https://') ? { url } : {}),
        ...(str(release.name, 200) ? { name: str(release.name, 200) } : {}),
        ...(str(release.published_at, 40) ? { publishedAt: str(release.published_at, 40) } : {}),
        ...(str(release.body, 20_000) ? { notes: str(release.body, 20_000) } : {}),
      };
    } catch (err) {
      this.cache = { ...base, error: `Recherche impossible : ${(err as Error).message}` };
    }
    return this.cache;
  }
}
