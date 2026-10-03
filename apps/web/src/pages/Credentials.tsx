import type { Profile } from '@carto/core';
import { useState, type ClipboardEvent } from 'react';
import { ApiError, del, get, post, put } from '../api.ts';
import { parseCredentialBlock } from '../credentialBlock.ts';
import { t } from '../i18n/index.ts';
import { Link } from '../router.tsx';
import { Alert, Check, Field, fmtDate, useAction, useLoad } from '../ui.tsx';

type CredType = 'temporary' | 'stored' | 'user-role' | 'user' | 'hub-role';

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

export interface CredentialDraft {
  type: CredType;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  roleArn: string;
  externalId: string;
  remember: boolean;
  duration: number;
  sourceProfileId: string;
}

export const emptyDraft = (): CredentialDraft => ({
  type: 'temporary',
  accessKeyId: '',
  secretAccessKey: '',
  sessionToken: '',
  roleArn: '',
  externalId: '',
  remember: false,
  duration: 3600,
  sourceProfileId: '',
});

/** Corps de PUT /api/profiles/:id/credentials selon le type choisi. */
export function credentialBody(d: CredentialDraft) {
  const { type, accessKeyId, secretAccessKey, remember } = d;
  const durationSeconds = d.duration;
  switch (type) {
    case 'temporary':
      return { type, accessKeyId, secretAccessKey, sessionToken: d.sessionToken };
    case 'user-role':
      return {
        type,
        accessKeyId,
        secretAccessKey,
        roleArn: d.roleArn,
        externalId: d.externalId,
        remember,
        durationSeconds,
      };
    case 'user':
      return { type, accessKeyId, secretAccessKey, remember, durationSeconds };
    case 'hub-role':
      return { type, roleArn: d.roleArn, externalId: d.externalId };
    case 'stored':
      return {
        type,
        sourceProfileId: d.sourceProfileId,
        ...(d.roleArn ? { roleArn: d.roleArn } : {}),
        ...(d.externalId ? { externalId: d.externalId } : {}),
      };
  }
}

/** Compte réellement associé aux identifiants, quand l'API signale un compte différent du profil. */
export const otherAccountOf = (err: unknown) =>
  err instanceof ApiError && err.code === 'COMPTE_DIFFERENT'
    ? /compte (\d{12})/.exec(err.message)?.[1]
    : undefined;

interface StoredInfo {
  profileId: string;
  profileName: string;
  accountId: string;
  type: CredType;
  maskedAccessKeyId?: string;
  roleArn?: string;
  addedAt: string;
}

/** Clés mémorisées (chiffrées côté serveur) des autres profils : seules les métadonnées masquées arrivent ici. */
function StoredPicker({
  draft,
  set,
  excludeProfileId,
}: {
  draft: CredentialDraft;
  set: (patch: Partial<CredentialDraft>) => void;
  excludeProfileId?: string;
}) {
  const list = useLoad(() => get<{ stored: StoredInfo[] }>('/api/credentials/stored'), []);
  const stored = (list.data?.stored ?? []).filter((c) => c.profileId !== excludeProfileId);
  const chosen = stored.find((c) => c.profileId === draft.sourceProfileId);
  if (list.error) return <Alert kind="error">{list.error}</Alert>;
  if (list.data && stored.length === 0) return <Alert>{t('cred.aucuneMemorisee')}</Alert>;
  return (
    <>
      <fieldset className="choices" data-testid="cles-memorisees">
        <legend>{t('cred.choisirCles')}</legend>
        {stored.map((c) => (
          <label key={c.profileId} className={`choice${c === chosen ? ' selected' : ''}`}>
            <input
              type="radio"
              name="stored"
              checked={c === chosen}
              onChange={() => set({ sourceProfileId: c.profileId, roleArn: c.roleArn ?? '', externalId: '' })}
              required
            />
            <span>
              <strong>
                <span className="mono">{c.maskedAccessKeyId ?? '—'}</span> · {t(`cred.type.${c.type}`)}
              </strong>
              <span className="muted small">
                {t('cred.memoriseePour', {
                  profil: c.profileName,
                  compte: c.accountId,
                  date: fmtDate(c.addedAt),
                })}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {chosen && (
        <>
          <Field label={t('cred.roleOptionnel')}>
            <input
              autoComplete="off"
              value={draft.roleArn}
              onChange={(e) => set({ roleArn: e.target.value.trim() })}
              placeholder="arn:aws:iam::<ACCOUNT_ID>:role/<NOM>"
            />
            <span className="small">{t('cred.roleOptionnelAide')}</span>
          </Field>
          {draft.roleArn && (
            <Field label={t('cred.externalId')}>
              <input
                type="password"
                autoComplete="off"
                value={draft.externalId}
                onChange={(e) => set({ externalId: e.target.value.trim() })}
                required={draft.roleArn !== chosen.roleArn}
                placeholder={draft.roleArn === chosen.roleArn ? t('cred.externalIdIdentique') : ''}
              />
            </Field>
          )}
        </>
      )}
    </>
  );
}

/**
 * Champs de saisie : masqués, jamais relus depuis le serveur (écriture seule). Un bloc copié depuis
 * le portail AWS ou la CLI remplit les champs ; il est analysé localement puis oublié.
 */
export function CredentialFields({
  draft,
  onChange,
  hubAvailable,
  profileId,
}: {
  draft: CredentialDraft;
  onChange: (d: CredentialDraft) => void;
  hubAvailable: boolean;
  profileId?: string;
}) {
  const [pasted, setPasted] = useState<string>();
  const set = (patch: Partial<CredentialDraft>) => onChange({ ...draft, ...patch });
  const { type } = draft;
  const types: CredType[] = [
    'temporary',
    'stored',
    'user-role',
    'user',
    ...(hubAvailable ? (['hub-role'] as const) : []),
  ];

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const found = parseCredentialBlock(e.clipboardData.getData('text'));
    const patch: Partial<CredentialDraft> = { ...found };
    if (found.sessionToken) patch.type = 'temporary';
    else if (found.accessKeyId && type === 'temporary') patch.type = 'user';
    set(patch);
    const n = Object.keys(found).length;
    setPasted(n ? t('cred.colle', { n }) : t('cred.colleRien'));
  };

  return (
    <>
      <fieldset className="choices">
        <legend>{t('cred.saisie')}</legend>
        {types.map((x) => (
          <label key={x} className={`choice${type === x ? ' selected' : ''}`}>
            <input type="radio" name="type" checked={type === x} onChange={() => set({ type: x })} />
            <span>
              <strong>{t(`cred.type.${x}`)}</strong>
              <span className="muted small">{t(`cred.desc.${x}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {type === 'user' && <Alert kind="warn">{t('cred.avertUser')}</Alert>}
      {type === 'stored' && <StoredPicker draft={draft} set={set} excludeProfileId={profileId} />}
      {type !== 'hub-role' && type !== 'stored' && (
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
                <Link to={profileId ? `/aide?profil=${profileId}` : '/aide'}>{t('cred.aideRole')}</Link>
              </li>
            </ul>
          </details>
          <Field label={t('cred.accessKeyId')}>
            <input
              type="password"
              autoComplete="off"
              value={draft.accessKeyId}
              onChange={(e) => set({ accessKeyId: e.target.value.trim() })}
              required
            />
          </Field>
          <Field label={t('cred.secret')}>
            <input
              type="password"
              autoComplete="off"
              value={draft.secretAccessKey}
              onChange={(e) => set({ secretAccessKey: e.target.value.trim() })}
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
            value={draft.sessionToken}
            onChange={(e) => set({ sessionToken: e.target.value.trim() })}
            required
          />
        </Field>
      )}
      {(type === 'user-role' || type === 'hub-role') && (
        <>
          <Field label={t('form.roleArn')}>
            <input
              autoComplete="off"
              value={draft.roleArn}
              onChange={(e) => set({ roleArn: e.target.value.trim() })}
              placeholder="arn:aws:iam::<ACCOUNT_ID>:role/<NOM>"
              required
            />
          </Field>
          <Field label={t('cred.externalId')}>
            <input
              type="password"
              autoComplete="off"
              value={draft.externalId}
              onChange={(e) => set({ externalId: e.target.value.trim() })}
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
              value={draft.duration}
              onChange={(e) => set({ duration: Number(e.target.value) })}
            />
          </Field>
          <Check
            label={t('cred.memoriser')}
            checked={draft.remember}
            onChange={(v) => set({ remember: v })}
          />
        </>
      )}
    </>
  );
}

/** Formulaire autonome (mise en route, page « Identifiants ») avec correction du compte du profil. */
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
  const [draft, setDraft] = useState(emptyDraft);
  const [otherAccount, setOtherAccount] = useState<string>();
  const [run, error, busy] = useAction();

  const save = async () => {
    setOtherAccount(undefined);
    try {
      const r = await put<{ warnings: string[] }>(
        `/api/profiles/${profile.id}/credentials`,
        credentialBody(draft),
      );
      setDraft(emptyDraft());
      onSaved(r.warnings);
    } catch (err) {
      setOtherAccount(otherAccountOf(err));
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
      <CredentialFields
        draft={draft}
        onChange={setDraft}
        hubAvailable={hubAvailable}
        profileId={profile.id}
      />
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
