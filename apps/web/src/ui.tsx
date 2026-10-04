import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, setCsrf } from './api.ts';
import { t } from './i18n/index.ts';
import { useApp } from './store.ts';

export function Alert({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'error' | 'warn' | 'ok';
  children: ReactNode;
}) {
  return (
    <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
    </label>
  );
}

export function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
}) {
  return (
    <div
      className="modal-back"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && onClose) onClose();
      }}
    >
      <div className="modal">
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'copie' | 'erreur'>();
  // Retour visible dans les deux cas : un échec silencieux laisse croire que le texte est copié.
  const show = (s: 'copie' | 'erreur') => {
    setState(s);
    setTimeout(() => setState(undefined), 2000);
  };
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => show('copie'),
          () => show('erreur'),
        );
      }}
    >
      {state === 'copie'
        ? t('commun.copie')
        : state === 'erreur'
          ? t('commun.copieImpossible')
          : t('commun.copier')}
    </button>
  );
}

/** Chargement asynchrone simple : données, erreur, rechargement (état dérivé de la clé de chargement). */
export function useLoad<T>(
  loader: () => Promise<T>,
  deps: unknown[],
): {
  data?: T;
  error?: string;
  loading: boolean;
  reload: () => void;
} {
  const [tick, setTick] = useState(0);
  const key = JSON.stringify([...deps, tick]);
  const [state, setState] = useState<{ key?: string; data?: T; error?: string }>({});
  useEffect(() => {
    let alive = true;
    loader().then(
      (data) => alive && setState({ key, data }),
      (err: Error) => alive && setState({ key, error: err.message }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- la clé résume les dépendances fournies par l'appelant
  }, [key]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data: state.data, error: state.error, loading: state.key !== key, reload };
}

/** Exécute une action et expose son erreur éventuelle. */
export function useAction(): [(fn: () => Promise<unknown>) => Promise<void>, string | undefined, boolean] {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setError(undefined);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  return [run, error, busy];
}

/** Fenêtre de ré-authentification déclenchée par une réponse 403 REAUTH_REQUISE. */
export function ReauthDialog() {
  const pending = useApp((s) => s.reauth);
  const settle = useApp((s) => s.settleReauth);
  const authMode = useApp((s) => s.auth?.authMode);
  const mfa = useApp((s) => !!s.auth?.mfaEnabled);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [run, error, busy] = useAction();
  if (!pending) return null;
  if (authMode === 'oidc') {
    return (
      <Modal title={t('reauth.titre')} onClose={() => settle(false)}>
        <p>{t('reauth.oidc')}</p>
        <div className="row">
          <button
            className="primary"
            onClick={() =>
              void run(async () => {
                const r = await api<{ redirect: string }>('POST', '/api/auth/reauth', {});
                window.location.assign(r.redirect);
              })
            }
          >
            {t('reauth.confirmer')}
          </button>
          <button onClick={() => settle(false)}>{t('commun.annuler')}</button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={t('reauth.titre')} onClose={() => settle(false)}>
      <p className="muted">{mfa ? t('reauth.aide') : t('reauth.aideMotDePasse')}</p>
      {mfa && <p className="muted small">{t('reauth.aideCode')}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await api<{ csrfToken: string }>('POST', '/api/auth/reauth', {
              password,
              ...(mfa ? { code } : {}),
            });
            setCsrf(r.csrfToken);
            setPassword('');
            setCode('');
            settle(true);
          });
        }}
      >
        <Field label={t('login.motDePasse')}>
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        {mfa && (
          <Field label={t('login.code')}>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </Field>
        )}
        {error && <Alert kind="error">{error}</Alert>}
        <div className="row">
          <button className="primary" type="submit" disabled={busy}>
            {t('reauth.confirmer')}
          </button>
          <button type="button" onClick={() => settle(false)}>
            {t('commun.annuler')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function Toast() {
  const toast = useApp((s) => s.toast);
  return (
    <div className="toast-zone" role="status" aria-live="polite">
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

export const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleString('fr-FR') : '—');
