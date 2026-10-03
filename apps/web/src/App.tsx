import { useEffect, useState, type ReactNode } from 'react';
import { get, post, setCsrf } from './api.ts';
import { Diagram } from './diagram/Diagram.tsx';
import { t, type MessageKey } from './i18n/index.ts';
import { AuditPage } from './pages/Audit.tsx';
import { ConfigPage } from './pages/Config.tsx';
import { CredentialsPage } from './pages/Credentials.tsx';
import { HelpPage } from './pages/Help.tsx';
import { ImportPage } from './pages/Import.tsx';
import { InventoryPage } from './pages/Inventory.tsx';
import { LoginPage } from './pages/Login.tsx';
import { MultiPage } from './pages/Multi.tsx';
import { OnboardingPage } from './pages/Onboarding.tsx';
import { OrgAccountsPage } from './pages/OrgAccounts.tsx';
import { ProfileForm } from './pages/ProfileForm.tsx';
import { ProfilesPage } from './pages/Profiles.tsx';
import { ScanPage } from './pages/Scan.tsx';
import { UsersPage } from './pages/Users.tsx';
import { Link, match, navigate, usePath } from './router.tsx';
import { useApp, type AuthState } from './store.ts';
import { applyTheme, type Theme } from './theme.ts';
import { ReauthDialog, Toast, useLoad } from './ui.tsx';
import { Icon, Logo } from './icons.tsx';
import type { ProfileView } from './pages/Profiles.tsx';

const TITLES: Record<string, MessageKey> = {
  profils: 'nav.profils',
  nouveau: 'profils.nouveau',
  diagramme: 'profils.diagramme',
  inventaire: 'profils.inventaire',
  scan: 'profils.scan',
  identifiants: 'profils.identifiants',
  modifier: 'commun.modifier',
  demarrage: 'onb.titre',
  organisation: 'org.titre',
  'multi-comptes': 'nav.multi',
  import: 'nav.import',
  configuration: 'nav.configuration',
  utilisateurs: 'nav.utilisateurs',
  journal: 'nav.journal',
  aide: 'nav.aide',
  login: 'login.titre',
};

export interface StateResponse extends AuthState {
  csrfToken: string;
}

/** Recharge l'état d'authentification et le jeton CSRF. */
export async function refreshAuth(): Promise<AuthState> {
  const s = await get<StateResponse>('/api/auth/state');
  setCsrf(s.csrfToken);
  useApp.getState().setAuth(s);
  return s;
}

/** Onglets d'un profil, précédés du fil d'Ariane ; un profil « imports uniquement » n'a ni scan ni identifiants. */
function ProfileTabs({ id }: { id: string }) {
  const path = usePath();
  const profile = useLoad(() => get<{ profile: ProfileView }>(`/api/profiles/${id}`), [id]);
  const p = profile.data?.profile;
  const importOnly = p?.auth.kind === 'import-only';
  const editTabs: [string, string][] = importOnly
    ? [['demarrage', t('profils.importer')]]
    : [
        ['scan', t('profils.scan')],
        ['identifiants', t('profils.identifiants')],
      ];
  const tabs: [string, string][] = [
    ['diagramme', t('profils.diagramme')],
    ['inventaire', t('profils.inventaire')],
    ...(p?.canEdit === false ? [] : [...editTabs, ['modifier', t('commun.modifier')] as [string, string]]),
  ];
  return (
    <div className="tabs profile-tabs">
      <nav aria-label={t('nav.filAriane')} className="crumbs">
        <Link to="/profils">
          <Icon name="back" /> {t('nav.profils')}
        </Link>
        {p && <span className="crumb">{p.name}</span>}
      </nav>
      {tabs.map(([seg, label]) => (
        <Link key={seg} to={`/profils/${id}/${seg}`} className={path.endsWith(`/${seg}`) ? 'active' : ''}>
          {label}
        </Link>
      ))}
    </div>
  );
}

function route(path: string): { node: ReactNode; full?: boolean; profile?: string } {
  const p = (pattern: string) => match(pattern, path);
  let m: Record<string, string> | null;
  if (p('/profils')) return { node: <ProfilesPage /> };
  if (p('/profils/nouveau')) return { node: <ProfileForm /> };
  if ((m = p('/profils/:id/modifier'))) return { node: <ProfileForm id={m.id} />, profile: m.id };
  if ((m = p('/profils/:id/diagramme')))
    return { node: <Diagram profileId={m.id ?? ''} />, full: true, profile: m.id };
  if ((m = p('/profils/:id/inventaire')))
    return { node: <InventoryPage profileId={m.id ?? ''} />, profile: m.id };
  if ((m = p('/profils/:id/organisation')))
    return { node: <OrgAccountsPage profileId={m.id ?? ''} />, profile: m.id };
  if ((m = p('/profils/:id/demarrage')))
    return { node: <OnboardingPage profileId={m.id ?? ''} />, profile: m.id };
  if ((m = p('/profils/:id/scan'))) return { node: <ScanPage profileId={m.id ?? ''} />, profile: m.id };
  if ((m = p('/profils/:id/identifiants')))
    return { node: <CredentialsPage profileId={m.id ?? ''} />, profile: m.id };
  if (p('/multi-comptes')) return { node: <MultiPage /> };
  if ((m = p('/multi-comptes/:ids')))
    return { node: <Diagram profileId="" multi={(m.ids ?? '').split(',').filter(Boolean)} />, full: true };
  if (p('/import')) return { node: <ImportPage /> };
  if (p('/configuration')) return { node: <ConfigPage /> };
  if (p('/utilisateurs')) return { node: <UsersPage /> };
  if (p('/journal')) return { node: <AuditPage /> };
  if (p('/aide')) return { node: <HelpPage /> };
  return { node: <ProfilesPage /> };
}

export function App() {
  const path = usePath();
  const auth = useApp((s) => s.auth);
  const theme = useApp((s) => s.theme);
  const themes = useApp((s) => s.themes);
  const themeName = useApp((s) => s.themeName);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    refreshAuth()
      .then((s) => {
        if (s.stage !== 'full' && window.location.pathname !== '/login') navigate('/login', true);
        if (s.stage === 'full' && (window.location.pathname === '/' || window.location.pathname === '/login'))
          navigate('/profils', true);
      })
      .catch(() => navigate('/login', true))
      .finally(() => setReady(true));
  }, []);

  const loggedIn = auth?.stage === 'full';
  useEffect(() => {
    if (!loggedIn) return;
    get<{ defaut: string; themes: Record<string, Theme> }>('/api/config/theme')
      .then((r) => useApp.getState().setThemes(r.themes, r.defaut))
      .catch(() => undefined);
  }, [loggedIn]);
  useEffect(() => applyTheme(theme), [theme]);
  // Titre d'onglet : section courante (utile avec plusieurs onglets ouverts sur des profils différents).
  useEffect(() => {
    const section = path.split('/').filter(Boolean).at(-1) ?? '';
    const label = TITLES[section];
    document.title = label ? `${t(label)} · ${t('app.titre')}` : t('app.titre');
  }, [path]);

  if (!ready) return <div className="empty">{t('app.chargement')}</div>;
  if (path === '/login' || !loggedIn) return <LoginPage />;

  const r = route(path);
  const user = auth.user;
  const nav: [string, string, boolean][] = [
    ['/profils', t('nav.profils'), true],
    ['/multi-comptes', t('nav.multi'), true],
    ['/import', t('nav.import'), user?.role !== 'viewer'],
    ['/configuration', t('nav.configuration'), user?.role === 'admin'],
    ['/utilisateurs', t('nav.utilisateurs'), user?.role === 'admin'],
    ['/journal', t('nav.journal'), user?.role === 'admin'],
    ['/aide', t('nav.aide'), true],
  ];
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/profils" className="brand" aria-label={t('app.titre')}>
          <Logo size={22} />
          <span className="brand-name">{t('app.titre')}</span>
        </Link>
        <nav aria-label={t('nav.principale')}>
          {nav
            .filter(([, , show]) => show)
            .map(([to, label]) => (
              <Link key={to} to={to} className={path.startsWith(to) ? 'active' : ''}>
                {label}
              </Link>
            ))}
        </nav>
        <select
          aria-label={t('nav.theme')}
          value={themeName}
          onChange={(e) => useApp.getState().setThemeName(e.target.value)}
        >
          {Object.keys(themes).map((name) => (
            <option key={name} value={name}>
              {name === 'sombre'
                ? t('theme.sombre')
                : name === 'clair'
                  ? t('theme.clair')
                  : name === 'client'
                    ? t('theme.client')
                    : name}
            </option>
          ))}
        </select>
        <span className="who">{user?.username}</span>
        <button
          onClick={() =>
            void post('/api/auth/logout').finally(() => {
              useApp.getState().setAuth(undefined);
              window.location.assign('/login');
            })
          }
        >
          <Icon name="logout" /> <span className="hide-narrow">{t('nav.deconnexion')}</span>
        </button>
      </header>
      {r.profile && <ProfileTabs id={r.profile} />}
      {r.full ? <main className="full">{r.node}</main> : <main className="page">{r.node}</main>}
      <ReauthDialog />
      <Toast />
    </div>
  );
}
