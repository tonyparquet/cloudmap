import { useEffect, useState, type ReactNode } from 'react';
import { get, post, setCsrf } from './api.ts';
import { Diagram } from './diagram/Diagram.tsx';
import { t } from './i18n/index.ts';
import { AuditPage } from './pages/Audit.tsx';
import { ConfigPage } from './pages/Config.tsx';
import { CredentialsPage } from './pages/Credentials.tsx';
import { HelpPage } from './pages/Help.tsx';
import { ImportPage } from './pages/Import.tsx';
import { InventoryPage } from './pages/Inventory.tsx';
import { LoginPage } from './pages/Login.tsx';
import { OnboardingPage } from './pages/Onboarding.tsx';
import { ProfileForm } from './pages/ProfileForm.tsx';
import { ProfilesPage } from './pages/Profiles.tsx';
import { ScanPage } from './pages/Scan.tsx';
import { UsersPage } from './pages/Users.tsx';
import { Link, match, navigate, usePath } from './router.tsx';
import { useApp, type AuthState } from './store.ts';
import { applyTheme, type Theme } from './theme.ts';
import { ReauthDialog, Toast } from './ui.tsx';

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

function ProfileTabs({ id }: { id: string }) {
  const path = usePath();
  const tabs: [string, string][] = [
    ['diagramme', t('profils.diagramme')],
    ['inventaire', t('profils.inventaire')],
    ['scan', t('profils.scan')],
    ['identifiants', t('profils.identifiants')],
    ['modifier', t('commun.modifier')],
  ];
  return (
    <div className="tabs" style={{ padding: '0 16px', marginBottom: 0 }}>
      <Link to="/profils">← {t('nav.profils')}</Link>
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
  if ((m = p('/profils/:id/demarrage')))
    return { node: <OnboardingPage profileId={m.id ?? ''} />, profile: m.id };
  if ((m = p('/profils/:id/scan'))) return { node: <ScanPage profileId={m.id ?? ''} />, profile: m.id };
  if ((m = p('/profils/:id/identifiants')))
    return { node: <CredentialsPage profileId={m.id ?? ''} />, profile: m.id };
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

  if (!ready) return <div className="empty">{t('app.chargement')}</div>;
  if (path === '/login' || !loggedIn) return <LoginPage />;

  const r = route(path);
  const user = auth.user;
  const nav: [string, string, boolean][] = [
    ['/profils', t('nav.profils'), true],
    ['/import', t('nav.import'), user?.role !== 'viewer'],
    ['/configuration', t('nav.configuration'), user?.role === 'admin'],
    ['/utilisateurs', t('nav.utilisateurs'), user?.role === 'admin'],
    ['/journal', t('nav.journal'), user?.role === 'admin'],
    ['/aide', t('nav.aide'), true],
  ];
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/profils" className="brand">
          <img src="/favicon.svg" alt="" width={20} height={20} />
          {t('app.titre')}
        </Link>
        <nav>
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
          {t('nav.deconnexion')}
        </button>
      </header>
      {r.profile && <ProfileTabs id={r.profile} />}
      {r.full ? <main className="full">{r.node}</main> : <main className="page">{r.node}</main>}
      <ReauthDialog />
      <Toast />
    </div>
  );
}
