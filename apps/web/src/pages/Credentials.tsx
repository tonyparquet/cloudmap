import type { Profile } from '@carto/core';
import { useState } from 'react';
import { del, get, post, put } from '../api.ts';
import { t } from '../i18n/index.ts';
import { Alert, Check, Field, fmtDate, useAction, useLoad } from '../ui.tsx';

type CredType = 'temporary' | 'user-role' | 'user' | 'hub-role';

interface CredentialInfo {
  storage: 'memoire' | 'chiffre' | 'role-hub';
  type: CredType;
  maskedAccessKeyId?: string;
  addedAt: string;
  expiresAt?: string;
}

/** Saisie des identifiants : champs masqués, jamais relus depuis le serveur (écriture seule). */
export function CredentialsPage({ profileId }: { profileId: string }) {
  const profile = useLoad(() => get<{ profile: Profile }>(`/api/profiles/${profileId}`), [profileId]);
  const status = useLoad(
    () =>
      get<{ credentials: CredentialInfo[]; hubAvailable: boolean }>(
        `/api/profiles/${profileId}/credentials/status`,
      ),
    [profileId],
  );
  const [type, setType] = useState<CredType>('temporary');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecret] = useState('');
  const [sessionToken, setToken] = useState('');
  const [roleArn, setRoleArn] = useState('');
  const [externalId, setExternalId] = useState('');
  const [remember, setRemember] = useState(false);
  const [duration, setDuration] = useState(3600);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [message, setMessage] = useState<string>();
  const [run, error, busy] = useAction();

  if (profile.data?.profile.auth.kind === 'import-only') return <Alert>{t('cred.importSeul')}</Alert>;
  const hubAvailable = status.data?.hubAvailable ?? false;
  const types: CredType[] = [
    'temporary',
    'user-role',
    'user',
    ...(hubAvailable ? (['hub-role'] as const) : []),
  ];
  const clear = () => {
    setAccessKeyId('');
    setSecret('');
    setToken('');
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <h1>{t('cred.titre')}</h1>
      <div className="card">
        <h2>{t('cred.etat')}</h2>
        {status.error && <Alert kind="error">{status.error}</Alert>}
        {status.data?.credentials.length === 0 && <p className="muted">{t('cred.aucun')}</p>}
        {status.data && status.data.credentials.length > 0 && (
          <table className="data">
            <tbody>
              {status.data.credentials.map((c, i) => (
                <tr key={i}>
                  <td>{t(`cred.stockage.${c.storage}`)}</td>
                  <td>{t(`cred.type.${c.type}`)}</td>
                  <td className="mono">{c.maskedAccessKeyId ?? '—'}</td>
                  <td>
                    {t('cred.ajoute')} {fmtDate(c.addedAt)}
                  </td>
                  <td>{c.expiresAt ? `${t('cred.expire')} ${fmtDate(c.expiresAt)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <button
            onClick={() =>
              void run(async () => {
                const r = await post<{ arn: string; matches: boolean }>(
                  `/api/profiles/${profileId}/credentials/test`,
                );
                setMessage(r.matches ? t('cred.testOk', { arn: r.arn }) : t('cred.testKo'));
              })
            }
          >
            {t('cred.tester')}
          </button>
          <button
            className="danger"
            onClick={() =>
              void run(async () => {
                await del(`/api/profiles/${profileId}/credentials`);
                status.reload();
              })
            }
          >
            {t('commun.supprimer')}
          </button>
        </div>
        {message && <Alert kind="ok">{message}</Alert>}
      </div>

      <form
        className="card"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const body =
              type === 'temporary'
                ? { type, accessKeyId, secretAccessKey, sessionToken }
                : type === 'user-role'
                  ? {
                      type,
                      accessKeyId,
                      secretAccessKey,
                      roleArn,
                      externalId,
                      remember,
                      durationSeconds: duration,
                    }
                  : type === 'user'
                    ? { type, accessKeyId, secretAccessKey, remember, durationSeconds: duration }
                    : { type, roleArn, externalId };
            const r = await put<{ warnings: string[] }>(`/api/profiles/${profileId}/credentials`, body);
            clear();
            setWarnings(r.warnings);
            status.reload();
          });
        }}
      >
        <div className="row" role="radiogroup">
          {types.map((x) => (
            <label key={x} className="check">
              <input type="radio" name="type" checked={type === x} onChange={() => setType(x)} />
              {t(`cred.type.${x}`)}
            </label>
          ))}
        </div>
        {type === 'user' && <Alert kind="warn">{t('cred.avertUser')}</Alert>}
        {type !== 'hub-role' && (
          <>
            <Field label={t('cred.accessKeyId')}>
              <input
                type="password"
                autoComplete="off"
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value.trim())}
                required
              />
            </Field>
            <Field label={t('cred.secret')}>
              <input
                type="password"
                autoComplete="off"
                value={secretAccessKey}
                onChange={(e) => setSecret(e.target.value.trim())}
                required
              />
            </Field>
          </>
        )}
        {type === 'temporary' && (
          <Field label={t('cred.token')}>
            <input
              type="password"
              autoComplete="off"
              value={sessionToken}
              onChange={(e) => setToken(e.target.value.trim())}
              required
            />
          </Field>
        )}
        {(type === 'user-role' || type === 'hub-role') && (
          <>
            <Field label={t('form.roleArn')}>
              <input
                autoComplete="off"
                value={roleArn}
                onChange={(e) => setRoleArn(e.target.value.trim())}
                required
              />
            </Field>
            <Field label={t('cred.externalId')}>
              <input
                type="password"
                autoComplete="off"
                value={externalId}
                onChange={(e) => setExternalId(e.target.value.trim())}
                required
              />
            </Field>
          </>
        )}
        {(type === 'user' || type === 'user-role') && (
          <>
            <Field label={t('cred.duree')}>
              <input
                type="number"
                min={900}
                max={43200}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
            </Field>
            <Check label={t('cred.memoriser')} checked={remember} onChange={setRemember} />
          </>
        )}
        {!hubAvailable && type === 'hub-role' && <Alert kind="warn">{t('cred.hubIndispo')}</Alert>}
        {warnings.map((w) => (
          <Alert key={w} kind="warn">
            {w}
          </Alert>
        ))}
        {error && <Alert kind="error">{error}</Alert>}
        <button className="primary" type="submit" disabled={busy}>
          {t('commun.enregistrer')}
        </button>
      </form>
    </div>
  );
}
