import { post } from './api.ts';
import { t } from './i18n/index.ts';
import { Alert, fmtDate, useAction } from './ui.tsx';

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

/** Lien vers la page de la release (s'ouvre hors de l'application : navigateur ou nouvel onglet). */
export function ReleaseLink({ status, label }: { status: UpdateStatus; label: string }) {
  return status.url ? (
    <a className="btn primary" href={status.url} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  ) : null;
}

/** Carte « Version et mises à jour » (page Configuration, administrateurs). */
export function UpdatesCard({
  status,
  onChecked,
}: {
  status?: UpdateStatus;
  onChecked: (s: UpdateStatus) => void;
}) {
  const [run, error, busy] = useAction();
  if (!status) return null;
  return (
    <div className="card" data-testid="mises-a-jour">
      <h2>{t('maj.titre')}</h2>
      <dl className="facts">
        <dt>{t('maj.installee')}</dt>
        <dd className="mono">{status.current}</dd>
        {status.latest && (
          <>
            <dt>{t('maj.publiee')}</dt>
            <dd className="mono">
              {status.latest}
              {status.publishedAt ? ` · ${fmtDate(status.publishedAt)}` : ''}
            </dd>
          </>
        )}
        {status.checkedAt && (
          <>
            <dt>{t('maj.verifiee')}</dt>
            <dd>{fmtDate(status.checkedAt)}</dd>
          </>
        )}
      </dl>
      {!status.enabled && <Alert>{t('maj.desactivee')}</Alert>}
      {status.error && <Alert kind="warn">{status.error}</Alert>}
      {status.enabled && !status.error && status.latest && (
        <Alert kind={status.available ? 'info' : 'ok'}>
          {status.available ? t('maj.disponible', { v: status.latest }) : t('maj.aJour')}
        </Alert>
      )}
      {status.available && status.notes && <pre className="notes">{status.notes}</pre>}
      {error && <Alert kind="error">{error}</Alert>}
      <div className="row">
        {status.enabled && (
          <button
            disabled={busy}
            onClick={() => void run(async () => onChecked(await post<UpdateStatus>('/api/updates/check')))}
          >
            {busy ? t('maj.recherche') : t('maj.rechercher')}
          </button>
        )}
        {status.available && (
          <ReleaseLink status={status} label={t('maj.telecharger', { v: status.latest ?? '' })} />
        )}
      </div>
    </div>
  );
}
