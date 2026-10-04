import type { Profile } from '@cloudmap/core';
import { useState } from 'react';
import { del, get } from '../api.ts';
import { t } from '../i18n/index.ts';
import { authLabel, providerOf } from '../providers.ts';
import { Icon } from '../icons.tsx';
import { Link } from '../router.tsx';
import { useApp } from '../store.ts';
import { Alert, fmtDate, useAction, useLoad } from '../ui.tsx';

export type ProfileView = Profile & {
  canEdit: boolean;
  lastSnapshot?: { id: string; createdAt: string; resourceCount: number; errorCount: number } | null;
};

const isDemo = (id: string) => /^demo(-|$)/.test(id);

export function ProfilesPage() {
  const role = useApp((s) => s.auth?.user?.role);
  const { data, error, reload } = useLoad(() => get<{ profiles: ProfileView[] }>('/api/profiles'), []);
  const [query, setQuery] = useState('');
  const [run, actionError] = useAction();
  const profiles = data?.profiles ?? [];
  const names = new Map(profiles.map((p) => [p.id, p.name]));
  const q = query.trim().toLowerCase();
  const shown = q
    ? profiles.filter((p) => [p.name, p.client ?? '', p.accountId].some((v) => v.toLowerCase().includes(q)))
    : profiles;

  return (
    <>
      <div className="row page-head">
        <h1>{t('profils.titre')}</h1>
        <span className="spacer" />
        {profiles.length > 3 && (
          <label className="search">
            <Icon name="search" />
            <input
              type="search"
              aria-label={t('profils.rechercher')}
              placeholder={t('profils.rechercher')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        )}
        {role !== 'viewer' && (
          <Link to="/profils/nouveau" className="btn">
            <Icon name="plus" /> {t('profils.nouveau')}
          </Link>
        )}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {actionError && <Alert kind="error">{actionError}</Alert>}
      {data && role !== 'viewer' && profiles.every((p) => isDemo(p.id)) && (
        <div className="card welcome">
          <h2>{t('profils.bienvenueTitre')}</h2>
          <p className="muted">{t('profils.bienvenueTexte')}</p>
          <Link to="/profils/nouveau" className="btn primary">
            {t('profils.ajouterCompte')}
          </Link>
        </div>
      )}
      {data && profiles.length === 0 && role === 'viewer' && <p className="muted">{t('profils.aucun')}</p>}
      {q && shown.length === 0 && <p className="muted">{t('profils.aucunResultat', { q: query.trim() })}</p>}
      <div className="grid">
        {shown.map((p) => {
          const firstRun = p.canEdit && !p.lastSnapshot;
          return (
            <article className="card profile-card" key={p.id} data-testid="profil">
              <header className="row">
                <h2>{p.name}</h2>
                <span className="badge">{t(`fournisseur.${providerOf(p)}`)}</span>
                {p.auth.kind === 'assume-role-profile' && (
                  <span className="badge">
                    {t('profils.viaHub', { hub: names.get(p.auth.parentProfileId) ?? '?' })}
                  </span>
                )}
                {!p.canEdit && <span className="badge">{t('profils.lectureSeule')}</span>}
              </header>
              {p.description && <p className="muted small">{p.description}</p>}
              <dl className="facts">
                {p.client && (
                  <>
                    <dt>{t('profils.client')}</dt>
                    <dd>{p.client}</dd>
                  </>
                )}
                <dt>{t('profils.compte')}</dt>
                <dd className="mono">{p.accountId}</dd>
                <dt>{t('profils.regions')}</dt>
                <dd>{p.regions.join(', ') || '—'}</dd>
                <dt>{t('profils.acces')}</dt>
                <dd>{authLabel(providerOf(p), p.auth.kind)}</dd>
              </dl>
              <p className="small">
                {p.lastSnapshot ? (
                  <span className="muted">
                    {t('profils.dernierScan', {
                      date: fmtDate(p.lastSnapshot.createdAt),
                      n: p.lastSnapshot.resourceCount,
                    })}
                  </span>
                ) : (
                  <span className="badge">{t('profils.jamaisScanne')}</span>
                )}
              </p>
              <div className="row actions">
                {firstRun ? (
                  <Link to={`/profils/${p.id}/demarrage`} className="btn primary">
                    {t('profils.miseEnRoute')}
                  </Link>
                ) : (
                  <Link
                    to={`/profils/${p.id}/diagramme`}
                    className={`btn${p.lastSnapshot ? ' primary' : ''}`}
                  >
                    {t('profils.diagramme')}
                  </Link>
                )}
                <Link to={`/profils/${p.id}/inventaire`} className="btn">
                  {t('profils.inventaire')}
                </Link>
                {p.canEdit && p.auth.kind !== 'import-only' && !firstRun && (
                  <Link to={`/profils/${p.id}/scan`} className="btn">
                    {t('profils.scan')}
                  </Link>
                )}
                <span className="spacer" />
                {p.canEdit && !isDemo(p.id) && (
                  <button
                    className="icon-btn danger"
                    aria-label={`${t('commun.supprimer')} ${p.name}`}
                    title={t('commun.supprimer')}
                    onClick={() => {
                      if (!window.confirm(t('commun.confirmerSuppression'))) return;
                      void run(async () => {
                        await del(`/api/profiles/${p.id}`);
                        reload();
                      });
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
