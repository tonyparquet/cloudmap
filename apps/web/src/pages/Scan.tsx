import type { Profile } from '@carto/core';
import { useEffect, useRef, useState } from 'react';
import { ApiError, get, post } from '../api.ts';
import { t } from '../i18n/index.ts';
import { Link } from '../router.tsx';
import { Alert, Check, useAction, useLoad } from '../ui.tsx';

interface Progress {
  service: string;
  region: string;
  found: number;
  errors: number;
}
interface ScanError {
  service: string;
  region: string;
  code: string;
  message: string;
}
export interface ScanResult {
  snapshotId?: string;
  errorCount: number;
}

const PERMISSION = 'Permission manquante : ';

/**
 * Lance le scan d'un profil (régions du profil) et attend sa fin : scans en série de plusieurs comptes.
 * Le débit de lancement est limité côté serveur : en cas de 429, nouvel essai après une pause.
 */
export async function scanAndWait(
  profileId: string,
  services: string[],
): Promise<ScanResult & { failure?: string; resources?: number }> {
  let scanId = '';
  for (let attempt = 0; !scanId; attempt++) {
    try {
      scanId = (await post<{ scanId: string }>(`/api/profiles/${profileId}/scans`, { services })).scanId;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 429) || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  return new Promise((resolve) => {
    const result: ScanResult & { failure?: string; resources?: number } = { errorCount: 0 };
    const es = new EventSource(`/api/scans/${scanId}/events`);
    const data = <T,>(e: Event) => JSON.parse((e as MessageEvent<string>).data) as T;
    es.addEventListener('error', (e) => {
      if ((e as MessageEvent).data) result.errorCount++;
    });
    es.addEventListener('progress', (e) => {
      result.resources = (result.resources ?? 0) + data<{ found: number }>(e).found;
    });
    es.addEventListener('snapshot', (e) => (result.snapshotId = data<{ snapshotId: string }>(e).snapshotId));
    es.addEventListener('failed', (e) => (result.failure = data<{ message: string }>(e).message));
    es.addEventListener('end', () => {
      es.close();
      resolve(result);
    });
  });
}

/** Lancement d'un scan et suivi en direct (SSE) ; les permissions manquantes sont résumées sans doublon. */
export function ScanRunner({
  profile,
  first = false,
  onDone,
}: {
  profile: Profile;
  first?: boolean;
  onDone?: (r: ScanResult) => void;
}) {
  const services = useLoad(
    () => get<{ services: { key: string; label: string }[]; defaults: string[] }>('/api/config/services'),
    [],
  );
  const [chosenRegions, setRegions] = useState<string[]>();
  const [chosenServices, setSelected] = useState<string[]>();
  const [rows, setRows] = useState<Progress[]>([]);
  const [errors, setErrors] = useState<ScanError[]>([]);
  const [counter, setCounter] = useState({ done: 0, total: 0 });
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [failure, setFailure] = useState<string>();
  const source = useRef<EventSource | undefined>(undefined);
  const [run, error, busy] = useAction();

  const regions = chosenRegions ?? profile.regions;
  const selected = chosenServices ?? services.data?.defaults ?? [];
  useEffect(() => () => source.current?.close(), []);

  const start = () =>
    run(async () => {
      setRows([]);
      setErrors([]);
      setFailure(undefined);
      const { scanId } = await post<{ scanId: string }>(`/api/profiles/${profile.id}/scans`, {
        regions,
        services: selected,
      });
      setPhase('running');
      const result: ScanResult = { errorCount: 0 };
      const es = new EventSource(`/api/scans/${scanId}/events`);
      source.current = es;
      const data = <T,>(e: Event) => JSON.parse((e as MessageEvent<string>).data) as T;
      es.addEventListener('start', (e) => setCounter({ done: 0, total: data<{ total: number }>(e).total }));
      es.addEventListener('progress', (e) => {
        const p = data<Progress & { done: number; total: number }>(e);
        setCounter({ done: p.done, total: p.total });
        setRows((r) => [...r, p]);
      });
      es.addEventListener('error', (e) => {
        if (!(e as MessageEvent).data) return;
        result.errorCount++;
        setErrors((x) => [...x, data<ScanError>(e)]);
      });
      es.addEventListener('snapshot', (e) => {
        result.snapshotId = data<{ snapshotId: string }>(e).snapshotId;
        setPhase('done');
      });
      es.addEventListener('failed', (e) => {
        setFailure(data<{ message: string }>(e).message);
        setPhase('failed');
      });
      es.addEventListener('end', () => {
        es.close();
        onDone?.(result);
      });
    });

  const all = services.data?.services ?? [];
  const permissions = [
    ...new Set(
      errors.filter((e) => e.message.startsWith(PERMISSION)).map((e) => e.message.slice(PERMISSION.length)),
    ),
  ].sort();
  const others = errors.filter((e) => !e.message.startsWith(PERMISSION));

  return (
    <>
      <div className="card">
        {profile.regions.length === 0 && <Alert kind="warn">{t('scan.aucuneRegion')}</Alert>}
        <h2>{t('scan.regions')}</h2>
        <div className="row">
          {profile.regions.map((r) => (
            <Check
              key={r}
              label={r}
              checked={regions.includes(r)}
              onChange={(v) => setRegions(v ? [...regions, r] : regions.filter((x) => x !== r))}
            />
          ))}
        </div>
        <details className="help">
          <summary>{t('scan.servicesResume', { n: selected.length, total: all.length })}</summary>
          <div className="row" style={{ margin: '8px 0' }}>
            <button type="button" onClick={() => setSelected(all.map((s) => s.key))}>
              {t('scan.tout')}
            </button>
            <button type="button" onClick={() => setSelected([])}>
              {t('scan.rien')}
            </button>
          </div>
          {all.map((s) => (
            <Check
              key={s.key}
              label={s.label}
              checked={selected.includes(s.key)}
              onChange={(v) => setSelected(v ? [...selected, s.key] : selected.filter((x) => x !== s.key))}
            />
          ))}
        </details>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="primary"
            onClick={() => void start()}
            disabled={busy || phase === 'running' || regions.length === 0 || selected.length === 0}
          >
            {first ? t('scan.lancerPremier') : t('scan.lancer')}
          </button>
        </div>
      </div>

      {phase !== 'idle' && (
        <div className="card">
          <div className="row">
            <strong>
              {phase === 'running'
                ? t('scan.enCours')
                : phase === 'done'
                  ? t('scan.termine')
                  : t('scan.echec')}
            </strong>
            <span className="muted small">{t('scan.progression', counter)}</span>
            <span className="spacer" />
            {phase === 'done' && (
              <Link to={`/profils/${profile.id}/diagramme`} className="btn">
                {t('scan.voirDiagramme')}
              </Link>
            )}
          </div>
          <div className="progress" style={{ margin: '10px 0' }}>
            <div style={{ width: `${counter.total ? (100 * counter.done) / counter.total : 0}%` }} />
          </div>
          {failure && <Alert kind="error">{failure}</Alert>}
          {permissions.length > 0 && (
            <Alert kind="warn">
              {t('scan.permissionsManquantes', { n: permissions.length })}
              <ul className="mono">
                {permissions.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <Link to={`/aide?profil=${profile.id}`}>{t('scan.voirPolitique')}</Link>
            </Alert>
          )}
          {others.length > 0 && (
            <>
              <h3>{t('scan.autresErreurs')}</h3>
              <table className="data">
                <tbody>
                  {others.map((e, i) => (
                    <tr key={i}>
                      <td>{e.service}</td>
                      <td>{e.region}</td>
                      <td className="mono">{e.code}</td>
                      <td>{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <details className="help">
            <summary>{t('scan.detail')}</summary>
            <table className="data" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>{t('scan.services')}</th>
                  <th>{t('scan.regions')}</th>
                  <th>{t('scan.trouves')}</th>
                  <th>{t('scan.erreurs')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.service}</td>
                    <td>{r.region}</td>
                    <td>{r.found}</td>
                    <td>{r.errors || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}
    </>
  );
}

export function ScanPage({ profileId }: { profileId: string }) {
  const profile = useLoad(() => get<{ profile: Profile }>(`/api/profiles/${profileId}`), [profileId]);
  return (
    <div style={{ maxWidth: 980 }}>
      <h1>{t('scan.titre')}</h1>
      {profile.error && <Alert kind="error">{profile.error}</Alert>}
      {profile.data && <ScanRunner profile={profile.data.profile} />}
    </div>
  );
}
