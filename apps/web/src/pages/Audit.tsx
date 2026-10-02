import { useState } from 'react';
import { download, get } from '../api.ts';
import { t } from '../i18n/index.ts';
import { Alert, fmtDate, useLoad } from '../ui.tsx';

interface AuditRow {
  id: number;
  ts: string;
  username: string | null;
  ip: string | null;
  action: string;
  profile_id: string | null;
  result: string;
  details: string | null;
}

const PAGE = 100;

export function AuditPage() {
  const [offset, setOffset] = useState(0);
  const [action, setAction] = useState('');
  const data = useLoad(
    () =>
      get<{ rows: AuditRow[]; total: number }>(
        `/api/admin/audit?limit=${PAGE}&offset=${offset}${action ? `&action=${encodeURIComponent(action)}` : ''}`,
      ),
    [offset, action],
  );
  return (
    <>
      <div className="row">
        <h1>{t('audit.titre')}</h1>
        <span className="spacer" />
        <input
          placeholder={t('audit.filtre')}
          value={action}
          onChange={(e) => setAction(e.target.value.replace(/[^\w.-]/g, ''))}
        />
        <button
          onClick={() =>
            void fetch('/api/admin/audit.csv', { credentials: 'same-origin' })
              .then((r) => r.blob())
              .then((b) => download('journal-audit.csv', b))
          }
        >
          {t('commun.exporterCsv')}
        </button>
      </div>
      {data.error && <Alert kind="error">{data.error}</Alert>}
      <table className="data">
        <thead>
          <tr>
            <th>{t('audit.date')}</th>
            <th>{t('audit.utilisateur')}</th>
            <th>{t('audit.ip')}</th>
            <th>{t('audit.action')}</th>
            <th>{t('audit.profil')}</th>
            <th>{t('audit.resultat')}</th>
            <th>{t('audit.details')}</th>
          </tr>
        </thead>
        <tbody>
          {data.data?.rows.map((r) => (
            <tr key={r.id}>
              <td className="small">{fmtDate(r.ts)}</td>
              <td>{r.username}</td>
              <td className="mono">{r.ip}</td>
              <td>{r.action}</td>
              <td className="mono">{r.profile_id}</td>
              <td>{r.result}</td>
              <td className="mono">{r.details}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 10 }}>
        <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          {t('commun.precedent')}
        </button>
        <span className="muted small">
          {offset + 1}–{Math.min(offset + PAGE, data.data?.total ?? 0)} / {data.data?.total ?? 0}
        </span>
        <button disabled={offset + PAGE >= (data.data?.total ?? 0)} onClick={() => setOffset(offset + PAGE)}>
          {t('commun.suivant')}
        </button>
      </div>
    </>
  );
}
