import { useEffect, useState } from 'react';
import { get } from '../api.ts';
import { t } from '../i18n/index.ts';
import { navigate } from '../router.tsx';
import { Alert, useLoad } from '../ui.tsx';
import { CredentialsForm } from './Credentials.tsx';
import { ImportForm } from './Import.tsx';
import type { ProfileView } from './Profiles.tsx';
import { ScanRunner, type ScanResult } from './Scan.tsx';

type Step = 'identifiants' | 'scan' | 'import' | 'diagramme';

/**
 * Mise en route d'un profil : identifiants → premier scan → diagramme (ou import → diagramme pour un
 * profil sans accès direct). Le diagramme s'ouvre seul après un scan sans erreur.
 */
export function OnboardingPage({ profileId }: { profileId: string }) {
  const profile = useLoad(() => get<{ profile: ProfileView }>(`/api/profiles/${profileId}`), [profileId]);
  const available = useLoad(
    () => get<{ available: boolean }>(`/api/profiles/${profileId}/credentials/available`),
    [profileId],
  );
  const hub = useLoad(() => get<{ hubAvailable: boolean }>('/api/config/services'), []);
  const [saved, setSaved] = useState<string[]>();
  const [result, setResult] = useState<ScanResult>();

  const clean = result?.snapshotId !== undefined && result.errorCount === 0;
  useEffect(() => {
    if (!clean) return;
    const timer = setTimeout(() => navigate(`/profils/${profileId}/diagramme`), 1200);
    return () => clearTimeout(timer);
  }, [clean, profileId]);

  const error = profile.error ?? available.error;
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!profile.data || !available.data) return <p className="muted">{t('app.chargement')}</p>;

  const p = profile.data.profile;
  const steps: Step[] =
    p.auth.kind === 'import-only' ? ['import', 'diagramme'] : ['identifiants', 'scan', 'diagramme'];
  const step: Step =
    p.auth.kind === 'import-only' ? 'import' : saved || available.data.available ? 'scan' : 'identifiants';
  const current = steps.indexOf(step);

  return (
    <div style={{ maxWidth: 820 }}>
      <h1>
        {t('onb.titre')} — {p.name}
      </h1>
      <p className="muted">
        {t('onb.sousTitre', { compte: p.accountId, regions: p.regions.join(', ') || '—' })}
      </p>
      <ol className="stepper" data-testid="etapes">
        {steps.map((s, i) => (
          <li key={s} className={i < current ? 'done' : i === current ? 'current' : ''}>
            {t(`onb.etape.${s}`)}
          </li>
        ))}
      </ol>

      {step === 'identifiants' && (
        <div className="card">
          <CredentialsForm
            profile={p}
            hubAvailable={hub.data?.hubAvailable ?? false}
            onProfileChanged={profile.reload}
            onSaved={setSaved}
          />
        </div>
      )}

      {step === 'scan' && (
        <>
          {p.auth.kind === 'assume-role-hub' && <Alert>{t('onb.hub', { role: p.auth.roleArn })}</Alert>}
          {saved && <Alert kind="ok">{t('cred.verifies', { compte: p.accountId })}</Alert>}
          {saved?.map((w) => (
            <Alert key={w} kind="warn">
              {w}
            </Alert>
          ))}
          <p className="muted">{t('onb.scanIntro')}</p>
          <ScanRunner profile={p} first onDone={setResult} />
          {clean && <Alert kind="ok">{t('onb.redirection')}</Alert>}
        </>
      )}

      {step === 'import' && (
        <div className="card">
          <p className="muted">{t('onb.importIntro')}</p>
          <ImportForm profileId={p.id} onImported={() => navigate(`/profils/${p.id}/diagramme`)} />
        </div>
      )}
    </div>
  );
}
