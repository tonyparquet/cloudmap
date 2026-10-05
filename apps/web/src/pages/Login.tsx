import { useEffect, useState } from 'react';
import { post } from '../api.ts';
import { refreshAuth } from '../App.tsx';
import { t } from '../i18n/index.ts';
import { navigate } from '../router.tsx';
import { useApp } from '../store.ts';
import { Alert, Field, useAction } from '../ui.tsx';
import { Icon, Logo } from '../icons.tsx';
import { LanguageSelector } from '../LanguageSelector.tsx';

export interface RegisterResult {
  transferred?: { profiles: number; snapshots: number };
}

/**
 * Création de compte. Premier compte : administrateur de l'installation. Depuis le mode invité, le
 * travail de la session est conservé dans le compte. Double authentification activable plus tard.
 */
export function RegisterForm({
  first,
  fromGuest,
  onDone,
}: {
  first: boolean;
  fromGuest: boolean;
  onDone: (r: RegisterResult) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [run, error, busy] = useAction();
  return (
    <form
      className="reveal"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          if (password !== confirm) throw new Error(t('login.motsDePasseDifferents'));
          const r = await post<RegisterResult>('/api/auth/register', { username, password });
          setPassword('');
          setConfirm('');
          await refreshAuth();
          onDone(r);
        });
      }}
    >
      <p className="muted">
        {first
          ? t('login.premierCompte')
          : fromGuest
            ? t('invite.inscriptionAide')
            : t('login.inscriptionAide')}
      </p>
      <Field label={t('login.identifiant')}>
        <input
          name="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </Field>
      <Field label={t('login.motDePasse')}>
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={14}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <span className="small">{t('login.motDePasseAide')}</span>
      </Field>
      <Field label={t('login.confirmation')}>
        <input
          name="confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </Field>
      {error && <Alert kind="error">{error}</Alert>}
      <button className="primary cta wide" type="submit" disabled={busy}>
        {t('login.creerCompte')} <Icon name="arrow" />
      </button>
    </form>
  );
}

function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [run, error, busy] = useAction();
  return (
    <form
      className="reveal"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await post('/api/auth/login', { username, password });
          setPassword('');
          await refreshAuth();
        });
      }}
    >
      <Field label={t('login.identifiant')}>
        <input
          name="username"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </Field>
      <Field label={t('login.motDePasse')}>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </Field>
      {error && <Alert kind="error">{error}</Alert>}
      <button className="primary cta wide" type="submit" disabled={busy}>
        {t('login.seConnecter')} <Icon name="arrow" />
      </button>
    </form>
  );
}

function TotpForm() {
  const [code, setCode] = useState('');
  const [run, error, busy] = useAction();
  return (
    <form
      className="reveal"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await post('/api/auth/totp', { code: code.trim() });
          await refreshAuth();
          navigate('/profils');
        });
      }}
    >
      <h1>{t('login.totpTitre')}</h1>
      <p className="muted">{t('login.totpAide')}</p>
      <Field label={t('login.code')}>
        <input
          name="code"
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
      </Field>
      {error && <Alert kind="error">{error}</Alert>}
      <button className="primary cta wide" type="submit" disabled={busy}>
        {t('login.verifier')} <Icon name="arrow" />
      </button>
    </form>
  );
}

/** Ouverture : se connecter, créer un compte (facultatif) ou continuer en invité, sans aucune trace. */
export function LoginPage() {
  const auth = useApp((s) => s.auth);
  const [mode, setMode] = useState<'login' | 'register'>();
  const [run, error, busy] = useAction();

  useEffect(() => {
    if (auth?.stage === 'full') navigate('/profils', true);
  }, [auth]);

  const brand = (
    <>
      <div className="login-lang">
        <LanguageSelector />
      </div>
      <div className="brand">
        <Logo size={36} />
        <div>
          <div>{t('app.titre')}</div>
          <div className="signature">{t('app.signature')}</div>
        </div>
      </div>
    </>
  );
  if (!auth) return <div className="login card">{brand}</div>;
  if (auth.stage === 'mfa')
    return (
      <div className="login card">
        {brand}
        <TotpForm />
      </div>
    );

  const local = auth.authMode === 'local';
  const current = mode ?? (local && auth.setupRequired ? 'register' : 'login');
  const tabs = local && auth.registrationOpen && !auth.setupRequired;
  return (
    <div className="login card">
      {brand}
      {local && auth.setupRequired && <h1>{t('login.bienvenue')}</h1>}
      {tabs && (
        <div className="segmented" role="tablist" aria-label={t('login.titre')}>
          {(['login', 'register'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={current === m}
              className={current === m ? 'active' : ''}
              onClick={() => setMode(m)}
            >
              {m === 'login' ? t('login.seConnecter') : t('login.creerCompte')}
            </button>
          ))}
        </div>
      )}
      {!local ? (
        <button className="primary cta wide" onClick={() => window.location.assign('/api/auth/oidc/start')}>
          {t('login.oidc')} <Icon name="arrow" />
        </button>
      ) : current === 'register' ? (
        <RegisterForm key="register" first={auth.setupRequired} fromGuest={false} onDone={() => undefined} />
      ) : (
        <LoginForm key="login" />
      )}
      {auth.guestsAllowed && (
        <div className="guest-entry">
          <div className="sep">
            <span>{t('login.ou')}</span>
          </div>
          <button
            type="button"
            className="wide"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await post('/api/auth/guest');
                await refreshAuth();
                navigate('/profils', true);
              })
            }
          >
            {t('login.invite')}
          </button>
          <p className="muted small">{t('login.inviteAide')}</p>
          {error && <Alert kind="error">{error}</Alert>}
        </div>
      )}
    </div>
  );
}
