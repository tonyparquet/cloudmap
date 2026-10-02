import type { Profile } from '@carto/core';
import { del, get } from '../api.ts';
import { t, tOr } from '../i18n/index.ts';
import { Link } from '../router.tsx';
import { useApp } from '../store.ts';
import { Alert, useAction, useLoad } from '../ui.tsx';

export type ProfileView = Profile & { canEdit: boolean };

export function ProfilesPage() {
  const role = useApp((s) => s.auth?.user?.role);
  const { data, error, reload } = useLoad(() => get<{ profiles: ProfileView[] }>('/api/profiles'), []);
  const [run, actionError] = useAction();
  return (
    <>
      <div className="row">
        <h1>{t('profils.titre')}</h1>
        <span className="spacer" />
        {role !== 'viewer' && (
          <Link to="/profils/nouveau" className="btn">
            + {t('profils.nouveau')}
          </Link>
        )}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {actionError && <Alert kind="error">{actionError}</Alert>}
      {data?.profiles.length === 0 && <p className="muted">{t('profils.aucun')}</p>}
      <div className="grid">
        {data?.profiles.map((p) => (
          <div className="card" key={p.id} data-testid="profil">
            <div className="row">
              <h2 style={{ margin: 0 }}>{p.name}</h2>
              {!p.canEdit && <span className="badge">{t('profils.lectureSeule')}</span>}
            </div>
            {p.description && <p className="muted small">{p.description}</p>}
            <p className="small">
              {p.client && (
                <>
                  {t('profils.client')} : {p.client}
                  <br />
                </>
              )}
              {t('profils.compte')} : <span className="mono">{p.accountId}</span>
              <br />
              {t('profils.regions')} : {p.regions.join(', ') || '—'}
              <br />
              {t('profils.acces')} : {tOr(`auth.${p.auth.kind}`, p.auth.kind)}
            </p>
            <div className="row">
              <Link to={`/profils/${p.id}/diagramme`} className="btn">
                {t('profils.diagramme')}
              </Link>
              <Link to={`/profils/${p.id}/inventaire`} className="btn">
                {t('profils.inventaire')}
              </Link>
              {p.canEdit && p.auth.kind !== 'import-only' && (
                <Link to={`/profils/${p.id}/scan`} className="btn">
                  {t('profils.scan')}
                </Link>
              )}
              {p.canEdit && (
                <button
                  className="danger"
                  onClick={() => {
                    if (!window.confirm(t('commun.confirmerSuppression'))) return;
                    void run(async () => {
                      await del(`/api/profiles/${p.id}`);
                      reload();
                    });
                  }}
                >
                  {t('commun.supprimer')}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
