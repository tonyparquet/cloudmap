import type { Profile } from '@cloudmap/core';
import { useState, type ClipboardEvent } from 'react';
import { ApiError, del, get, post, put } from '../api.ts';
import { parseCredentialBlock } from '../credentialBlock.ts';
import { t } from '../i18n/index.ts';
import { providerOf, type Provider } from '../providers.ts';
import { Link } from '../router.tsx';
import { Alert, Check, Field, fmtDate, useAction, useLoad } from '../ui.tsx';

type CredType =
  | 'temporary'
  | 'stored'
  | 'user-role'
  | 'user'
  | 'hub-role'
  | 'azure-token'
  | 'azure-sp'
  | 'gcp-token'
  | 'gcp-sa';

/** Types de saisie proposés par fournisseur, le recommandé en premier. */
const TYPES: Record<Provider, CredType[]> = {
  aws: ['temporary', 'stored', 'user-role', 'user'],
  azure: ['azure-token', 'azure-sp', 'stored'],
  gcp: ['gcp-token', 'gcp-sa', 'stored'],
};

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
    ...(p.provider && p.provider !== 'aws' ? { provider: p.provider } : {}),
    accountId: p.accountId,
    regions: p.regions,
    auth:
      p.auth.kind === 'assume-role-hub' || p.auth.kind === 'assume-role-profile'
        ? { ...p.auth }
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
  accessToken: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  serviceAccountJson: string;
}

export const emptyDraft = (provider: Provider = 'aws'): CredentialDraft => ({
  type: TYPES[provider][0] ?? 'temporary',
  accessKeyId: '',
  secretAccessKey: '',
  sessionToken: '',
  roleArn: '',
  externalId: '',
  remember: false,
  duration: 3600,
  sourceProfileId: '',
  accessToken: '',
  tenantId: '',
  clientId: '',
  clientSecret: '',
  serviceAccountJson: '',
});

/** Champs obligatoires du type choisi remplis (avancement affiché par le formulaire de profil). */
export function draftComplete(d: CredentialDraft): boolean {
  switch (d.type) {
    case 'temporary':
      return !!(d.accessKeyId && d.secretAccessKey && d.sessionToken);
    case 'user':
      return !!(d.accessKeyId && d.secretAccessKey);
    case 'user-role':
      return !!(d.accessKeyId && d.secretAccessKey && d.roleArn && d.externalId);
    case 'hub-role':
      return !!(d.roleArn && d.externalId);
    case 'stored':
      return !!d.sourceProfileId;
    case 'azure-token':
    case 'gcp-token':
      return !!d.accessToken;
    case 'azure-sp':
      return !!(d.tenantId && d.clientId && d.clientSecret);
    case 'gcp-sa':
      return !!d.serviceAccountJson;
  }
}

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
    case 'azure-token':
    case 'gcp-token':
      return { type, accessToken: d.accessToken };
    case 'azure-sp':
      return { type, tenantId: d.tenantId, clientId: d.clientId, clientSecret: d.clientSecret, remember };
    case 'gcp-sa':
      return { type, serviceAccountJson: d.serviceAccountJson, remember };
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
  provider?: Provider;
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
  provider,
}: {
  draft: CredentialDraft;
  set: (patch: Partial<CredentialDraft>) => void;
  excludeProfileId?: string;
  provider: Provider;
}) {
  const list = useLoad(() => get<{ stored: StoredInfo[] }>('/api/credentials/stored'), []);
  const stored = (list.data?.stored ?? []).filter(
    (c) => c.profileId !== excludeProfileId && providerOf(c) === provider,
  );
  const chosen = stored.find((c) => c.profileId === draft.sourceProfileId);
  if (list.error) return <Alert kind="error">{list.error}</Alert>;
  if (list.data && stored.length === 0) return <Alert>{t('cred.aucuneMemorisee')}</Alert>;
  return (
    <>
      <fieldset className="choices inline" data-testid="cles-memorisees">
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
      {chosen && provider === 'aws' && (
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
  provider = 'aws',
}: {
  draft: CredentialDraft;
  onChange: (d: CredentialDraft) => void;
  hubAvailable: boolean;
  profileId?: string;
  provider?: Provider;
}) {
  const [pasted, setPasted] = useState<string>();
  const set = (patch: Partial<CredentialDraft>) => onChange({ ...draft, ...patch });
  const { type } = draft;
  const types: CredType[] = [
    ...TYPES[provider],
    ...(provider === 'aws' && hubAvailable ? (['hub-role'] as const) : []),
  ];
  const aws = provider === 'aws';

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
      <fieldset className="choices inline">
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
      {/* Champs du type choisi : réapparaissent en fondu à chaque changement de type. */}
      <div className="reveal" key={type}>
        {type === 'user' && <Alert kind="warn">{t('cred.avertUser')}</Alert>}
        {type === 'stored' && (
          <StoredPicker draft={draft} set={set} excludeProfileId={profileId} provider={provider} />
        )}
        {!aws && <CloudFields draft={draft} set={set} profileId={profileId} />}
        {aws && type !== 'hub-role' && type !== 'stored' && (
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
            <div className="form-grid">
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
            </div>
          </>
        )}
        {(type === 'user-role' || type === 'hub-role') && (
          <div className="form-grid">
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
          </div>
        )}
        {(type === 'azure-sp' || type === 'gcp-sa') && (
          <Check
            label={t('cred.memoriser')}
            checked={draft.remember}
            onChange={(v) => set({ remember: v })}
          />
        )}
        {(type === 'user' || type === 'user-role') && (
          <div className="form-grid">
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
          </div>
        )}
      </div>
    </>
  );
}

/** Azure et Google Cloud : jeton d'accès de la CLI, ou secret d'application / clé de compte de service. */
function CloudFields({
  draft,
  set,
  profileId,
}: {
  draft: CredentialDraft;
  set: (patch: Partial<CredentialDraft>) => void;
  profileId?: string;
}) {
  const [file, setFile] = useState<string>();
  const { type } = draft;
  const secret = (label: string, key: 'accessToken' | 'clientSecret', placeholder?: string) => (
    <Field label={label}>
      <input
        type="password"
        autoComplete="off"
        value={draft[key]}
        onChange={(e) => set({ [key]: e.target.value.trim() })}
        placeholder={placeholder}
        required
      />
    </Field>
  );
  const guid = (label: string, key: 'tenantId' | 'clientId') => (
    <Field label={label}>
      <input
        autoComplete="off"
        className="mono"
        value={draft[key]}
        onChange={(e) => set({ [key]: e.target.value.trim().toLowerCase() })}
        pattern="[0-9a-fA-F\-]{36}"
        placeholder="00000000-0000-0000-0000-000000000000"
        required
      />
    </Field>
  );
  // La clé JSON est lue localement puis envoyée au serveur ; seule l'adresse du compte est affichée.
  const loadKey = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    let email: unknown;
    try {
      email = (JSON.parse(text) as { client_email?: unknown }).client_email;
    } catch {
      email = undefined;
    }
    set({ serviceAccountJson: typeof email === 'string' ? text : '' });
    setFile(
      typeof email === 'string' ? t('cred.gcpCleChargee', { compte: email }) : t('cred.gcpCleInvalide'),
    );
  };
  return (
    <>
      {type === 'azure-token' && secret(t('cred.jeton'), 'accessToken', 'eyJ…')}
      {type === 'gcp-token' && secret(t('cred.jeton'), 'accessToken', 'ya29.…')}
      {type === 'azure-sp' && (
        <div className="form-grid">
          {guid(t('cred.tenantId'), 'tenantId')}
          {guid(t('cred.clientId'), 'clientId')}
          {secret(t('cred.clientSecret'), 'clientSecret')}
        </div>
      )}
      {type === 'gcp-sa' && (
        <Field label={t('cred.gcpCle')}>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => void loadKey(e.target.files?.[0])}
            required={!draft.serviceAccountJson}
          />
          <span className="small">{file ?? t('cred.gcpCleAide')}</span>
        </Field>
      )}
      {type !== 'stored' && (
        <details className="help">
          <summary>{t('cred.aideTitreCloud')}</summary>
          <ul className="small">
            <li>{t(`cred.aide.${type === 'azure-token' || type === 'azure-sp' ? 'azure' : 'gcp'}`)}</li>
            <li>
              <Link to={profileId ? `/aide?profil=${profileId}` : '/aide'}>{t('cred.aideCompteCloud')}</Link>
            </li>
          </ul>
        </details>
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
  const provider = providerOf(profile);
  const [draft, setDraft] = useState(() => emptyDraft(provider));
  const [otherAccount, setOtherAccount] = useState<string>();
  const [run, error, busy] = useAction();

  const save = async () => {
    setOtherAccount(undefined);
    try {
      const r = await put<{ warnings: string[] }>(
        `/api/profiles/${profile.id}/credentials`,
        credentialBody(draft),
      );
      setDraft(emptyDraft(provider));
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
        provider={provider}
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

/** Profil « via un profil hub » : les identifiants se fournissent sur le hub. */
export function ViaHub({ parentId }: { parentId: string }) {
  return (
    <Alert>
      {t('cred.viaProfil')} <Link to={`/profils/${parentId}/identifiants`}>{t('cred.ouvrirHub')}</Link>
    </Alert>
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

  const auth = profile.data?.profile.auth;
  if (auth?.kind === 'import-only') return <Alert>{t('cred.importSeul')}</Alert>;
  if (auth?.kind === 'assume-role-profile') return <ViaHub parentId={auth.parentProfileId} />;

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
