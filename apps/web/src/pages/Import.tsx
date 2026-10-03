import { useState } from 'react';
import { get, post } from '../api.ts';
import { t } from '../i18n/index.ts';
import { Alert, Field, useAction, useLoad } from '../ui.tsx';
import type { ProfileView } from './Profiles.tsx';

/** Dépôt d'un snapshot de la CLI : envoyé dès qu'un fichier est choisi ou glissé dans la zone. */
export function ImportForm({
  profileId,
  onImported,
}: {
  profileId: string;
  onImported?: (snapshot: { id: string; resource_count: number }) => void;
}) {
  const [result, setResult] = useState<string>();
  const [over, setOver] = useState(false);
  const [run, error, busy] = useAction();

  const send = (file: File | undefined) =>
    void run(async () => {
      if (!file || !profileId) return;
      setResult(undefined);
      let snapshot: unknown;
      try {
        snapshot = JSON.parse(await file.text());
      } catch {
        throw new Error(t('import.json'));
      }
      const r = await post<{ snapshot: { id: string; resource_count: number } }>(
        `/api/profiles/${profileId}/import`,
        snapshot,
      );
      setResult(t('import.ok', { n: r.snapshot.resource_count }));
      onImported?.(r.snapshot);
    });

  return (
    <>
      <label
        className={`dropzone${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          send(e.dataTransfer.files[0]);
        }}
      >
        <span>{t('import.deposer')}</span>
        <input
          type="file"
          accept="application/json,.json"
          aria-label={t('import.fichier')}
          disabled={busy || !profileId}
          onChange={(e) => {
            send(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </label>
      {error && <Alert kind="error">{error}</Alert>}
      {result && <Alert kind="ok">{result}</Alert>}
    </>
  );
}

export function ImportPage() {
  const profiles = useLoad(() => get<{ profiles: ProfileView[] }>('/api/profiles'), []);
  const editable = (profiles.data?.profiles ?? []).filter((p) => p.canEdit);
  const [profileId, setProfileId] = useState('');
  const target = profileId || editable[0]?.id || '';

  return (
    <div style={{ maxWidth: 640 }}>
      <h1>{t('import.titre')}</h1>
      <p className="muted">{t('import.aide')}</p>
      <div className="card">
        <Field label={t('import.profil')}>
          <select value={target} onChange={(e) => setProfileId(e.target.value)}>
            {editable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.accountId})
              </option>
            ))}
          </select>
        </Field>
        <ImportForm profileId={target} />
      </div>
    </div>
  );
}
