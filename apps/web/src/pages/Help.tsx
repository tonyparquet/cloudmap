import { useState } from 'react';
import { get } from '../api.ts';
import { t } from '../i18n/index.ts';
import { CopyButton, Field, useLoad } from '../ui.tsx';
import type { ProfileView } from './Profiles.tsx';

interface IamHelp {
  trustPolicy: string;
  readonlyPolicy: string;
  cliExample: string;
  externalId?: string;
}

function Block({ title, text }: { title: string; text: string }) {
  return (
    <div className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>{title}</h2>
        <span className="spacer" />
        <CopyButton text={text} />
      </div>
      <pre className="code">{text}</pre>
    </div>
  );
}

export function HelpPage() {
  const profiles = useLoad(() => get<{ profiles: ProfileView[] }>('/api/profiles'), []);
  const [profileId, setProfileId] = useState(
    () => new URLSearchParams(window.location.search).get('profil') ?? '',
  );
  const help = useLoad(
    () => get<IamHelp>(`/api/help/iam${profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''}`),
    [profileId],
  );
  return (
    <div style={{ maxWidth: 980 }}>
      <h1>{t('aide.titre')}</h1>
      <p>{t('aide.intro')}</p>
      <p className="muted">{t('aide.etapes')}</p>
      <Field label={t('aide.profil')}>
        <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
          <option value="">—</option>
          {profiles.data?.profiles
            .filter((p) => p.auth.kind !== 'import-only')
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      </Field>
      {help.data && (
        <>
          <Block title={t('aide.confiance')} text={help.data.trustPolicy} />
          <Block title={t('aide.lecture')} text={help.data.readonlyPolicy} />
          <Block title={t('aide.cli')} text={help.data.cliExample} />
        </>
      )}
    </div>
  );
}
