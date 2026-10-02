import { useMemo, useState } from 'react';
import { csvCell, download, get, post } from '../api.ts';
import { t } from '../i18n/index.ts';
import { Alert, useLoad } from '../ui.tsx';

interface Row {
  key: string;
  type: string;
  typeLabel: string;
  id: string;
  name: string;
  arn: string;
  region: string;
  tags: Record<string, string>;
  unknown: boolean;
}
type SortKey = 'typeLabel' | 'name' | 'id' | 'region' | 'arn';

export function InventoryPage({ profileId }: { profileId: string }) {
  const snapshots = useLoad(
    () => get<{ snapshots: { id: string; created_at: string }[] }>(`/api/profiles/${profileId}/snapshots`),
    [profileId],
  );
  const [snapshotId, setSnapshotId] = useState<string>();
  const current = snapshotId ?? snapshots.data?.snapshots[0]?.id;
  const inv = useLoad(
    () =>
      current
        ? get<{ resources: Row[] }>(`/api/snapshots/${current}/inventory`)
        : Promise.resolve({ resources: [] as Row[] }),
    [current],
  );
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'typeLabel', dir: 1 });

  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    return (inv.data?.resources ?? [])
      .filter((r) => !f || JSON.stringify(r).toLowerCase().includes(f))
      .sort((a, b) => a[sort.key].localeCompare(b[sort.key]) * sort.dir);
  }, [inv.data, filter, sort]);

  const header = (key: SortKey, label: string) => (
    <th onClick={() => setSort({ key, dir: sort.key === key ? (sort.dir === 1 ? -1 : 1) : 1 })}>
      {label} {sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : ''}
    </th>
  );

  const exportCsv = () => {
    const lines = [
      ['type', 'nom', 'id', 'region', 'arn', 'tags', 'etat'].map(csvCell).join(';'),
      ...rows.map((r) =>
        [r.type, r.name, r.id, r.region, r.arn, r.tags, r.unknown ? 'inconnu' : ''].map(csvCell).join(';'),
      ),
    ];
    download(
      'inventaire.csv',
      `${String.fromCharCode(0xfeff)}${lines.join('\r\n')}`,
      'text/csv;charset=utf-8',
    );
    void post('/api/audit/export', { format: 'csv', profileId });
  };

  return (
    <>
      <div className="row">
        <h1>{t('inv.titre')}</h1>
        <span className="spacer" />
        <select
          value={current ?? ''}
          onChange={(e) => setSnapshotId(e.target.value)}
          aria-label={t('diag.snapshot')}
        >
          {snapshots.data?.snapshots.map((s) => (
            <option key={s.id} value={s.id}>
              {new Date(s.created_at).toLocaleString('fr-FR')}
            </option>
          ))}
        </select>
        <input placeholder={t('inv.filtre')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button onClick={exportCsv} disabled={rows.length === 0}>
          {t('commun.exporterCsv')}
        </button>
      </div>
      {inv.error && <Alert kind="error">{inv.error}</Alert>}
      {!current && snapshots.data && <p className="muted">{t('diag.aucunSnapshot')}</p>}
      <p className="muted small">{t('inv.total', { n: rows.length })}</p>
      <table className="data">
        <thead>
          <tr>
            {header('typeLabel', t('inv.type'))}
            {header('name', t('inv.nom'))}
            {header('id', t('inv.id'))}
            {header('region', t('inv.region'))}
            {header('arn', t('inv.arn'))}
            <th>{t('inv.tags')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>
                {r.typeLabel}
                {r.unknown && <span className="badge">{t('statut.inconnu')}</span>}
              </td>
              <td>{r.name}</td>
              <td className="mono">{r.id}</td>
              <td>{r.region}</td>
              <td className="mono">{r.arn}</td>
              <td>
                {Object.entries(r.tags).map(([k, v]) => (
                  <span key={k} className="badge">
                    {k}={v}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
