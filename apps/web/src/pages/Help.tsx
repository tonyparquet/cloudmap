import { useState } from 'react';
import { get } from '../api.ts';
import { t } from '../i18n/index.ts';
import { PROVIDER_IDS, providerOf, type Provider } from '../providers.ts';
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
  const changelog = useLoad(() => get<{ version: string; notes: string }>('/api/changelog'), []);
  const [profileId, setProfileId] = useState(
    () => new URLSearchParams(window.location.search).get('profil') ?? '',
  );
  const [picked, setPicked] = useState<Provider>('aws');
  const chosen = profiles.data?.profiles.find((p) => p.id === profileId);
  const provider = chosen ? providerOf(chosen) : picked;
  const help = useLoad(
    () => get<IamHelp>(`/api/help/iam${profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''}`),
    [profileId],
  );
  const cloud = useLoad(
    () =>
      provider === 'aws'
        ? Promise.resolve({ documents: [] })
        : get<{ documents: { name: string; content: string }[] }>(`/api/help/cloud/${provider}`),
    [provider],
  );
  return (
    <div style={{ maxWidth: 980 }}>
      <h1>{t(`aide.titre.${provider}`)}</h1>
      {changelog.data && (
        <details className="card" data-testid="version">
          <summary>{t('maj.nouveautes', { v: changelog.data.version })}</summary>
          <pre className="notes">{changelog.data.notes || t('maj.pasDeNotes')}</pre>
        </details>
      )}
      <fieldset className="choices inline compact" data-testid="aide-fournisseur">
        <legend>{t('form.fournisseur')}</legend>
        {PROVIDER_IDS.map((p) => (
          <label key={p} className={`choice${provider === p ? ' selected' : ''}${chosen ? ' disabled' : ''}`}>
            <input
              type="radio"
              name="provider"
              checked={provider === p}
              disabled={!!chosen}
              onChange={() => setPicked(p)}
            />
            <span>
              <strong>{t(`fournisseur.${p}`)}</strong>
            </span>
          </label>
        ))}
      </fieldset>
      <p>{t(`aide.intro.${provider}`)}</p>
      {provider === 'aws' && <p className="muted">{t('aide.etapes')}</p>}
      {(provider === 'aws' || chosen) && (
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
      )}
      {provider !== 'aws' &&
        cloud.data?.documents.map((d) => <Block key={d.name} title={d.name} text={d.content} />)}
      {provider === 'aws' && help.data && (
        <>
          <Block title={t('aide.confiance')} text={help.data.trustPolicy} />
          <Block title={t('aide.lecture')} text={help.data.readonlyPolicy} />
          <Block title={t('aide.cli')} text={help.data.cliExample} />
        </>
      )}
    </div>
  );
}
