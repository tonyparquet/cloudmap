import { useEffect, useState } from 'react';
import { download, get, post } from '../api.ts';
import { refreshAuth } from '../App.tsx';
import { t } from '../i18n/index.ts';
import { navigate } from '../router.tsx';
import { useApp } from '../store.ts';
import { Alert, CopyButton, Field, useAction } from '../ui.tsx';
import { Logo } from '../icons.tsx';

interface Enrollment {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

function Enroll({ onCodes }: { onCodes: (codes: string[]) => void }) {
  const [data, setData] = useState<Enrollment>();
  const [code, setCode] = useState('');
  const [run, error, busy] = useAction();
  useEffect(() => {
    void get<Enrollment>('/api/auth/totp/enroll').then(setData);
  }, []);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const r = await post<{ recoveryCodes: string[] }>('/api/auth/totp/enroll', { code });
          onCodes(r.recoveryCodes);
        });
      }}
    >
      <h1>{t('login.enrolTitre')}</h1>
      <p className="muted">{t('login.enrolAide')}</p>
      {data && (
        <>
          <img src={data.qrDataUrl} alt="QR code TOTP" width={220} height={220} />
          <p className="small">
            {t('login.cle')} :{' '}
            <span className="mono" data-testid="totp-secret">
              {data.secret}
            </span>
          </p>
        </>
      )}
      <Field label={t('login.code')}>
        <input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
      </Field>
      {error && <Alert kind="error">{error}</Alert>}
      <button className="primary" type="submit" disabled={busy}>
        {t('login.activer')}
      </button>
    </form>
  );
}

export function LoginPage() {
  const auth = useApp((s) => s.auth);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>();
  const [run, error, busy] = useAction();

  useEffect(() => {
    if (auth?.stage === 'full' && !codes) navigate('/profils', true);
  }, [auth, codes]);

  const brand = (
    <div className="brand">
      <Logo size={36} />
      <div>
        <div>{t('app.titre')}</div>
        <div className="signature">{t('app.signature')}</div>
      </div>
    </div>
  );

  if (codes) {
    return (
      <div className="login card">
        {brand}
        <h1>{t('login.codesSecours')}</h1>
        <Alert kind="warn">{t('login.codesSecoursAide')}</Alert>
        <div className="codes" data-testid="codes-secours">
          {codes.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <div className="row">
          <CopyButton text={codes.join('\n')} />
          <button onClick={() => download('codes-de-secours.txt', codes.join('\n'), 'text/plain')}>
            .txt
          </button>
          <span className="spacer" />
          <button
            className="primary"
            onClick={() =>
              void refreshAuth().then(() => {
                setCodes(undefined);
                navigate('/profils');
              })
            }
          >
            {t('login.continuer')}
          </button>
        </div>
      </div>
    );
  }

  if (!auth) return <div className="login card">{brand}</div>;

  if (auth.stage === 'enroll') {
    return (
      <div className="login card">
        {brand}
        <Enroll onCodes={setCodes} />
      </div>
    );
  }

  if (auth.stage === 'mfa') {
    return (
      <div className="login card">
        {brand}
        <form
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
          <button className="primary" type="submit" disabled={busy}>
            {t('login.verifier')}
          </button>
        </form>
      </div>
    );
  }

  if (auth.authMode === 'oidc') {
    return (
      <div className="login card">
        {brand}
        <h1>{t('login.titre')}</h1>
        <button className="primary" onClick={() => window.location.assign('/api/auth/oidc/start')}>
          {t('login.oidc')}
        </button>
      </div>
    );
  }

  const setup = auth.setupRequired;
  return (
    <div className="login card">
      {brand}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (setup) {
              if (password !== confirm) throw new Error(t('login.motsDePasseDifferents'));
              await post('/api/auth/setup', { username, password });
            } else {
              await post('/api/auth/login', { username, password });
            }
            setPassword('');
            setConfirm('');
            await refreshAuth();
          });
        }}
      >
        <h1>{setup ? t('login.setupTitre') : t('login.titre')}</h1>
        {setup && <p className="muted">{t('login.setupAide')}</p>}
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
            autoComplete={setup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        {setup && (
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
        )}
        {error && <Alert kind="error">{error}</Alert>}
        <button className="primary" type="submit" disabled={busy}>
          {setup ? t('commun.creer') : t('login.seConnecter')}
        </button>
      </form>
    </div>
  );
}
