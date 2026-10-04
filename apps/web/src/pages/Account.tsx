import { useEffect, useState } from 'react';
import { del, download, get, post } from '../api.ts';
import { refreshAuth } from '../App.tsx';
import { t } from '../i18n/index.ts';
import { Alert, CopyButton, Field, useAction, useLoad } from '../ui.tsx';

interface Account {
  username: string;
  role: 'admin' | 'editor' | 'viewer';
  local: boolean;
  mfaEnabled: boolean;
  recoveryCodesLeft: number;
}

interface Enrollment {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

/** Activation du MFA : secret TOTP (QR code) puis premier code ; ré-authentification demandée si besoin. */
function EnrollMfa({ onCodes }: { onCodes: (codes: string[]) => void }) {
  const [data, setData] = useState<Enrollment>();
  const [code, setCode] = useState('');
  const [run, error, busy] = useAction();
  useEffect(() => {
    void run(async () => setData(await get<Enrollment>('/api/auth/totp/enroll')));
  }, [run]);
  return (
    <form
      className="reveal"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const r = await post<{ recoveryCodes: string[] }>('/api/auth/totp/enroll', { code });
          onCodes(r.recoveryCodes);
        });
      }}
    >
      <p className="muted">{t('login.enrolAide')}</p>
      {data && (
        <>
          <img src={data.qrDataUrl} alt={t('compte.qr')} width={200} height={200} />
          <p className="small">
            {t('login.cle')} :{' '}
            <span className="mono" data-testid="totp-secret">
              {data.secret}
            </span>
          </p>
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
          <button className="primary" type="submit" disabled={busy}>
            {t('login.activer')}
          </button>
        </>
      )}
      {error && <Alert kind="error">{error}</Alert>}
    </form>
  );
}

/** Mon compte : identité et double authentification, activable ou désactivable à tout moment. */
export function AccountPage() {
  const account = useLoad(() => get<Account>('/api/auth/account'), []);
  const [enrolling, setEnrolling] = useState(false);
  const [codes, setCodes] = useState<string[]>();
  const [run, error, busy] = useAction();
  const a = account.data;
  return (
    <div style={{ maxWidth: 720 }}>
      <h1>{t('compte.titre')}</h1>
      {account.error && <Alert kind="error">{account.error}</Alert>}
      {a && (
        <>
          <div className="card">
            <dl className="facts">
              <dt>{t('login.identifiant')}</dt>
              <dd>{a.username}</dd>
              <dt>{t('compte.role')}</dt>
              <dd>{t(`role.${a.role}`)}</dd>
            </dl>
          </div>
          {a.local && (
            <div className="card">
              <h2>
                {t('compte.mfa')}{' '}
                <span className={`badge${a.mfaEnabled ? ' ok' : ''}`}>
                  {a.mfaEnabled ? t('compte.actif') : t('compte.inactif')}
                </span>
              </h2>
              {codes ? (
                <div className="reveal">
                  <h3>{t('login.codesSecours')}</h3>
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
                    <button className="primary" onClick={() => setCodes(undefined)}>
                      {t('compte.termine')}
                    </button>
                  </div>
                </div>
              ) : a.mfaEnabled ? (
                <>
                  <p className="muted">{t('compte.mfaActive')}</p>
                  <p className="small">{t('compte.codesRestants', { n: a.recoveryCodesLeft })}</p>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() =>
                      window.confirm(t('compte.desactiverConfirm')) &&
                      void run(async () => {
                        await del('/api/auth/totp');
                        account.reload();
                        await refreshAuth();
                      })
                    }
                  >
                    {t('compte.desactiver')}
                  </button>
                </>
              ) : enrolling ? (
                <EnrollMfa
                  onCodes={(c) => {
                    setCodes(c);
                    setEnrolling(false);
                    account.reload();
                    void refreshAuth();
                  }}
                />
              ) : (
                <>
                  <p className="muted">{t('compte.mfaInactive')}</p>
                  <button className="primary" onClick={() => setEnrolling(true)}>
                    {t('compte.activer')}
                  </button>
                </>
              )}
              {error && <Alert kind="error">{error}</Alert>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
