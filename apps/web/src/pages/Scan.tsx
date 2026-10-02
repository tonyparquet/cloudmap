import type { Profile } from '@carto/core';
import { useEffect, useRef, useState } from 'react';
import { get, post } from '../api.ts';
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

export function ScanPage({ profileId }: { profileId: string }) {
  const profile = useLoad(() => get<{ profile: Profile }>(`/api/profiles/${profileId}`), [profileId]);
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

  const regions = chosenRegions ?? profile.data?.profile.regions ?? [];
  const selected = chosenServices ?? services.data?.defaults ?? [];
  useEffect(() => () => source.current?.close(), []);

  const start = () =>
    run(async () => {
      setRows([]);
      setErrors([]);
      setFailure(undefined);
      const { scanId } = await post<{ scanId: string }>(`/api/profiles/${profileId}/scans`, {
        regions,
        services: selected,
      });
      setPhase('running');
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
        if ((e as MessageEvent).data) setErrors((x) => [...x, data<ScanError>(e)]);
      });
      es.addEventListener('snapshot', () => setPhase('done'));
      es.addEventListener('failed', (e) => {
        setFailure(data<{ message: string }>(e).message);
        setPhase('failed');
      });
      es.addEventListener('end', () => es.close());
    });

  const all = services.data?.services ?? [];
  return (
    <div style={{ maxWidth: 980 }}>
      <h1>{t('scan.titre')}</h1>
      <div className="card">
        <h2>{t('scan.regions')}</h2>
        <div className="row">
          {(profile.data?.profile.regions ?? []).map((r) => (
            <Check
              key={r}
              label={r}
              checked={regions.includes(r)}
              onChange={(v) => setRegions(v ? [...regions, r] : regions.filter((x) => x !== r))}
            />
          ))}
        </div>
        <h2>{t('scan.services')}</h2>
        <div className="row" style={{ marginBottom: 8 }}>
          <button type="button" onClick={() => setSelected(all.map((s) => s.key))}>
            {t('scan.tout')}
          </button>
          <button type="button" onClick={() => setSelected([])}>
            {t('scan.rien')}
          </button>
        </div>
        <div>
          {all.map((s) => (
            <Check
              key={s.key}
              label={s.label}
              checked={selected.includes(s.key)}
              onChange={(v) => setSelected(v ? [...selected, s.key] : selected.filter((x) => x !== s.key))}
            />
          ))}
        </div>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="primary"
            onClick={() => void start()}
            disabled={busy || phase === 'running' || regions.length === 0}
          >
            {t('scan.lancer')}
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
              <Link to={`/profils/${profileId}/diagramme`} className="btn">
                {t('scan.voirDiagramme')}
              </Link>
            )}
          </div>
          <div className="progress" style={{ margin: '10px 0' }}>
            <div style={{ width: `${counter.total ? (100 * counter.done) / counter.total : 0}%` }} />
          </div>
          {failure && <Alert kind="error">{failure}</Alert>}
          {errors.length > 0 && (
            <>
              <h3>{t('scan.erreursAcces')}</h3>
              <table className="data">
                <tbody>
                  {errors.map((e, i) => (
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
        </div>
      )}
    </div>
  );
}
