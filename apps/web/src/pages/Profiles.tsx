import type { Profile } from '@cloudmap/core';
import { useState } from 'react';
import { del, get } from '../api.ts';
import {
  childrenOf,
  dragProps,
  dropProps,
  FolderTree,
  MoveSelect,
  pathTo,
  useFolderActions,
  type FolderData,
} from './Folders.tsx';
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

/** Dossier affiché, gardé dans l'adresse (?dossier=…) pour les liens et le retour. */
const initialFolder = () => new URLSearchParams(window.location.search).get('dossier');

export function ProfilesPage() {
  const role = useApp((s) => s.auth?.user?.role);
  const { data, error, reload } = useLoad(() => get<{ profiles: ProfileView[] }>('/api/profiles'), []);
  const tree = useLoad(() => get<FolderData>('/api/folders'), []);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState<string | null>(initialFolder);
  const [renaming, setRenaming] = useState<string>();
  const [run, actionError] = useAction();
  const [folderError, setFolderError] = useState<string>();
  const actions = useFolderActions(tree.data, tree.reload, setFolderError);
  const profiles = data?.profiles ?? [];
  const names = new Map(profiles.map((p) => [p.id, p.name]));
  const folders = tree.data?.folders ?? [];
  const entries = tree.data?.entries ?? {};
  const known = new Set(folders.map((f) => f.id));
  const folderOf = (id: string) => (entries[id] && known.has(entries[id]) ? entries[id] : null);
  const counts = new Map<string, number>();
  for (const p of profiles) {
    const f = folderOf(p.id);
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const folder = current && known.has(current) ? current : null;
  const select = (id: string | null) => {
    setCurrent(id);
    setRenaming(undefined);
    window.history.replaceState(null, '', id ? `/profils?dossier=${encodeURIComponent(id)}` : '/profils');
  };
  const q = query.trim().toLowerCase();
  // Recherche : dans tous les dossiers. Racine : tous les profils. Dossier : son contenu direct.
  const shown = q
    ? profiles.filter((p) => [p.name, p.client ?? '', p.accountId].some((v) => v.toLowerCase().includes(q)))
    : folder
      ? profiles.filter((p) => folderOf(p.id) === folder)
      : profiles;
  const subfolders = q ? [] : childrenOf(folders, folder);
  const crumbs = pathTo(folders, folder);
  const open = crumbs.at(-1);

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
      {folderError && (
        <Alert kind="error">
          {folderError}{' '}
          <button type="button" className="link-btn" onClick={() => setFolderError(undefined)}>
            {t('commun.fermer')}
          </button>
        </Alert>
      )}
      {data && !folder && role !== 'viewer' && profiles.every((p) => isDemo(p.id)) && (
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
      <div className="profiles-layout">
        {tree.data && (
          <FolderTree
            data={tree.data}
            counts={counts}
            total={profiles.length}
            current={folder}
            onSelect={select}
            actions={actions}
          />
        )}
        <div className="profiles-main">
          {open && !q && (
            <div className="folder-head reveal" key={open.id}>
              <nav aria-label={t('nav.filAriane')} className="crumbs">
                <button type="button" className="link-btn" onClick={() => select(null)}>
                  {t('dossiers.tous')}
                </button>
                {crumbs.map((f) => (
                  <span key={f.id}>
                    <Icon name="chevron" size={12} />
                    {f.id === open.id ? (
                      <strong>{f.name}</strong>
                    ) : (
                      <button type="button" className="link-btn" onClick={() => select(f.id)}>
                        {f.name}
                      </button>
                    )}
                  </span>
                ))}
              </nav>
              <span className="spacer" />
              {renaming === open.id ? (
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = new FormData(e.currentTarget).get('nom');
                    if (typeof name === 'string' && name.trim()) void actions.rename(open.id, name.trim());
                    setRenaming(undefined);
                  }}
                >
                  <input
                    name="nom"
                    autoFocus
                    defaultValue={open.name}
                    maxLength={80}
                    aria-label={t('dossiers.nom')}
                  />
                  <button type="submit">{t('commun.enregistrer')}</button>
                </form>
              ) : (
                <button type="button" onClick={() => setRenaming(open.id)}>
                  <Icon name="pencil" /> {t('dossiers.renommer')}
                </button>
              )}
              <MoveSelect
                folders={folders}
                value={open.parentId}
                exclude={open.id}
                label={t('dossiers.deplacerDossier', { x: open.name })}
                onMove={(to) => void actions.moveFolder(open.id, to)}
              />
              <button
                type="button"
                className="icon-btn danger"
                aria-label={`${t('commun.supprimer')} ${open.name}`}
                title={t('dossiers.supprimerAide')}
                onClick={() => {
                  if (!window.confirm(t('dossiers.supprimerConfirm', { x: open.name }))) return;
                  select(open.parentId);
                  void actions.remove(open.id);
                }}
              >
                <Icon name="trash" />
              </button>
            </div>
          )}
          {subfolders.length > 0 && (
            <div className="folder-tiles">
              {subfolders.map((f) => (
                <button
                  type="button"
                  key={f.id}
                  className="folder-tile"
                  onClick={() => select(f.id)}
                  {...dragProps({ kind: 'folder', id: f.id })}
                  {...dropProps((e) => actions.drop(e, f.id))}
                >
                  <Icon name="folder" size={18} />
                  <span>{f.name}</span>
                  <span className="tree-count">{counts.get(f.id) ?? 0}</span>
                </button>
              ))}
            </div>
          )}
          {folder && !q && shown.length === 0 && <p className="muted">{t('dossiers.vide')}</p>}
          <div className="grid">
            {shown.map((p) => {
              const firstRun = p.canEdit && !p.lastSnapshot;
              return (
                <article
                  className="card profile-card"
                  key={p.id}
                  data-testid="profil"
                  {...dragProps({ kind: 'profile', id: p.id })}
                >
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
                    <MoveSelect
                      folders={folders}
                      value={folderOf(p.id)}
                      label={t('dossiers.ranger', { x: p.name })}
                      onMove={(to) => void actions.moveProfile(p.id, to)}
                    />
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
        </div>
      </div>
    </>
  );
}
