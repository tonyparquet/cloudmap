import type { Profile } from '@carto/core';
import { useState, type ClipboardEvent } from 'react';
import { ApiError, del, get, post, put } from '../api.ts';
import { parseCredentialBlock } from '../credentialBlock.ts';
import { t } from '../i18n/index.ts';
import { Link } from '../router.tsx';
import { Alert, Check, Field, fmtDate, useAction, useLoad } from '../ui.tsx';

type CredType = 'temporary' | 'user-role' | 'user' | 'hub-role';

interface CredentialInfo {
  storage: 'memoire' | 'chiffre' | 'role-hub';
  type: CredType;
  maskedAccessKeyId?: string;
  addedAt: string;
  expiresAt?: string;
}

/** Corps attendu par PUT /api/profiles/:id (schéma strict : uniquement les champs saisissables). */
export function profileToInput(p: Profile) {
  return {
    name: p.name,
    client: p.client,
    description: p.description,
    accountId: p.accountId,
    regions: p.regions,
    auth:
      p.auth.kind === 'assume-role-hub'
        ? { kind: p.auth.kind, roleArn: p.auth.roleArn, externalId: p.auth.externalId }
        : { kind: p.auth.kind },
    tagFilters: p.tagFilters,
    externalNodes: p.externalNodes,
    probes: p.probes,
    flowLogs: p.flowLogs,
    allowedGroups: p.allowedGroups,
  };
}

/**
 * Formulaire de saisie : champs masqués, jamais relus depuis le serveur (écriture seule). Un bloc
 * copié depuis le portail AWS ou la CLI remplit les champs ; il est analysé localement puis oublié.
 */
export function CredentialsForm({
  profile,
  hubAvailable,
  onSaved,
  onProfileChanged,
}: {
  profile: Profile;
  hubAvailable: boolean;
  onSaved: (warnings: string[]) => void;
  onProfileChanged: () => void;
}) {
  const [type, setType] = useState<CredType>('temporary');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecret] = useState('');
  const [sessionToken, setToken] = useState('');
  const [roleArn, setRoleArn] = useState('');
  const [externalId, setExternalId] = useState('');
  const [remember, setRemember] = useState(false);
  const [duration, setDuration] = useState(3600);
  const [pasted, setPasted] = useState<string>();
  const [otherAccount, setOtherAccount] = useState<string>();
  const [run, error, busy] = useAction();

  const types: CredType[] = [
    'temporary',
    'user-role',
    'user',
    ...(hubAvailable ? (['hub-role'] as const) : []),
  ];

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const found = parseCredentialBlock(e.clipboardData.getData('text'));
    if (found.accessKeyId) setAccessKeyId(found.accessKeyId);
    if (found.secretAccessKey) setSecret(found.secretAccessKey);
    if (found.sessionToken) setToken(found.sessionToken);
    if (found.sessionToken) setType('temporary');
    else if (found.accessKeyId && type === 'temporary') setType('user');
    const n = Object.keys(found).length;
    setPasted(n ? t('cred.colle', { n }) : t('cred.colleRien'));
  };

  const save = async () => {
    const body =
      type === 'temporary'
        ? { type, accessKeyId, secretAccessKey, sessionToken }
        : type === 'user-role'
          ? { type, accessKeyId, secretAccessKey, roleArn, externalId, remember, durationSeconds: duration }
          : type === 'user'
            ? { type, accessKeyId, secretAccessKey, remember, durationSeconds: duration }
            : { type, roleArn, externalId };
    setOtherAccount(undefined);
    try {
      const r = await put<{ warnings: string[] }>(`/api/profiles/${profile.id}/credentials`, body);
      setAccessKeyId('');
      setSecret('');
      setToken('');
      setPasted(undefined);
      onSaved(r.warnings);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'COMPTE_DIFFERENT')
        setOtherAccount(/compte (\d{12})/.exec(err.message)?.[1]);
      throw err;
    }
  };

  return (
    <form
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        void run(save);
      }}
    >
      <fieldset className="choices">
        <legend>{t('cred.saisie')}</legend>
        {types.map((x) => (
          <label key={x} className={`choice${type === x ? ' selected' : ''}`}>
            <input type="radio" name="type" checked={type === x} onChange={() => setType(x)} />
            <span>
              <strong>{t(`cred.type.${x}`)}</strong>
              <span className="muted small">{t(`cred.desc.${x}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {type === 'user' && <Alert kind="warn">{t('cred.avertUser')}</Alert>}
      {type !== 'hub-role' && (
        <>
          <Field label={t('cred.coller')}>
            <input
              type="password"
              autoComplete="off"
              className="paste"
              value=""
              onChange={() => undefined}
              onPaste={onPaste}
              placeholder="export AWS_ACCESS_KEY_ID=…"
            />
            <span className="small">{pasted ?? t('cred.collerAide')}</span>
          </Field>
          <details className="help">
            <summary>{t('cred.aideTitre')}</summary>
            <ul className="small">
              <li>{t('cred.aideSso')}</li>
              <li>{t('cred.aideCli')}</li>
              <li>
                <Link to={`/aide?profil=${profile.id}`}>{t('cred.aideRole')}</Link>
              </li>
            </ul>
          </details>
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
              placeholder="arn:aws:iam::<ACCOUNT_ID>:role/<NOM>"
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
      {error && <Alert kind="error">{error}</Alert>}
      {otherAccount && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await put(`/api/profiles/${profile.id}`, {
                ...profileToInput(profile),
                accountId: otherAccount,
              });
              onProfileChanged();
              await save();
            })
          }
        >
          {t('cred.utiliserCompte', { compte: otherAccount })}
        </button>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" type="submit" disabled={busy}>
          {t('cred.enregistrerVerifier')}
        </button>
      </div>
    </form>
  );
}

/** Page « Identifiants » : état des identifiants (après ré-authentification), test, suppression, saisie. */
export function CredentialsPage({ profileId }: { profileId: string }) {
  const profile = useLoad(() => get<{ profile: Profile }>(`/api/profiles/${profileId}`), [profileId]);
  const status = useLoad(
    () =>
      get<{ credentials: CredentialInfo[]; hubAvailable: boolean }>(
        `/api/profiles/${profileId}/credentials/status`,
      ),
    [profileId],
  );
  const [warnings, setWarnings] = useState<string[]>([]);
  const [message, setMessage] = useState<string>();
  const [run, error] = useAction();

  if (profile.data?.profile.auth.kind === 'import-only') return <Alert>{t('cred.importSeul')}</Alert>;

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
        {error && <Alert kind="error">{error}</Alert>}
      </div>

      {profile.data && (
        <div className="card">
          <CredentialsForm
            profile={profile.data.profile}
            hubAvailable={status.data?.hubAvailable ?? false}
            onProfileChanged={profile.reload}
            onSaved={(w) => {
              setWarnings(w);
              status.reload();
            }}
          />
          {warnings.map((w) => (
            <Alert key={w} kind="warn">
              {w}
            </Alert>
          ))}
        </div>
      )}
    </div>
  );
}
