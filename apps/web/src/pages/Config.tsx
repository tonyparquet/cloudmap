import { get } from '../api.ts';
import { t } from '../i18n/index.ts';
import { useApp } from '../store.ts';
import { Alert, useLoad } from '../ui.tsx';

interface RulesInfo {
  files: { file: string; types: string[] }[];
  errors: { file: string; index?: number; type?: string; message: string }[];
  types: number;
}

export function ConfigPage() {
  const rules = useLoad(() => get<RulesInfo>('/api/config/rules'), []);
  const app = useLoad(
    () =>
      get<{ yaml: string; authMode: string; hubCredentials: string; demoMode: boolean }>('/api/config/app'),
    [],
  );
  const themes = useApp((s) => s.themes);
  return (
    <div style={{ maxWidth: 1000 }}>
      <h1>{t('config.titre')}</h1>
      {rules.error && <Alert kind="error">{rules.error}</Alert>}
      <div className="card">
        <h2>{t('config.erreursRegles')}</h2>
        {rules.data?.errors.length === 0 && <p className="muted">{t('config.aucuneErreur')}</p>}
        {rules.data?.errors.map((e, i) => (
          <Alert key={i} kind="warn">
            <strong>{e.file}</strong>
            {e.type ? ` — ${e.type}` : ''}
            {e.index !== undefined ? ` (#${e.index + 1})` : ''} : {e.message}
          </Alert>
        ))}
        <h2>
          {t('config.regles')} ({rules.data?.types ?? 0})
        </h2>
        <table className="data">
          <thead>
            <tr>
              <th>{t('config.fichier')}</th>
              <th>{t('config.types')}</th>
            </tr>
          </thead>
          <tbody>
            {rules.data?.files.map((f) => (
              <tr key={f.file}>
                <td className="mono">{f.file}</td>
                <td>
                  {f.types.map((x) => (
                    <span key={x} className="badge">
                      {x}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>{t('config.theme')}</h2>
        <p>{Object.keys(themes).join(', ')}</p>
        <h2>{t('config.mode')}</h2>
        <p>
          {app.data?.authMode} · HUB_CREDENTIALS={app.data?.hubCredentials} · DEMO_MODE=
          {String(app.data?.demoMode ?? false)}
        </p>
        <h2>{t('config.app')}</h2>
        <pre className="code">{app.data?.yaml}</pre>
      </div>
    </div>
  );
}
