import { useState } from 'react';
import { get, post } from '../api.ts';
import { t } from '../i18n/index.ts';
import { Alert, Field, useAction, useLoad } from '../ui.tsx';
import type { ProfileView } from './Profiles.tsx';

export function ImportPage() {
  const profiles = useLoad(() => get<{ profiles: ProfileView[] }>('/api/profiles'), []);
  const editable = (profiles.data?.profiles ?? []).filter((p) => p.canEdit);
  const [profileId, setProfileId] = useState('');
  const [file, setFile] = useState<File>();
  const [result, setResult] = useState<string>();
  const [run, error, busy] = useAction();
  const target = profileId || editable[0]?.id || '';

  return (
    <div style={{ maxWidth: 640 }}>
      <h1>{t('import.titre')}</h1>
      <p className="muted">{t('import.aide')}</p>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (!file) return;
            let snapshot: unknown;
            try {
              snapshot = JSON.parse(await file.text());
            } catch {
              throw new Error(t('import.json'));
            }
            const r = await post<{ snapshot: { resource_count: number } }>(
              `/api/profiles/${target}/import`,
              snapshot,
            );
            setResult(t('import.ok', { n: r.snapshot.resource_count }));
          });
        }}
      >
        <Field label={t('import.profil')}>
          <select value={target} onChange={(e) => setProfileId(e.target.value)}>
            {editable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.accountId})
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('import.fichier')}>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => setFile(e.target.files?.[0])}
            required
          />
        </Field>
        {error && <Alert kind="error">{error}</Alert>}
        {result && <Alert kind="ok">{result}</Alert>}
        <button className="primary" type="submit" disabled={busy || !target || !file}>
          {t('import.envoyer')}
        </button>
      </form>
    </div>
  );
}
