import { useState } from 'react';
import { download, get, post } from '../api.ts';
import { t } from '../i18n/index.ts';
import { Icon } from '../icons.tsx';
import { Link, navigate } from '../router.tsx';
import { Alert, CopyButton, Field, fmtDate, useAction, useLoad } from '../ui.tsx';
import { RegionPicker } from './ProfileForm.tsx';
import type { ProfileView } from './Profiles.tsx';
import { scanAndWait } from './Scan.tsx';

interface OrgAccount {
  id: string;
  name: string;
  status: string;
  profiles: { id: string; name: string }[];
}

const randomExternalId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

/**
 * Organisation → profils : depuis le profil hub (compte de gestion), un profil par compte membre qui
 * assume le rôle en lecture seule déployé par StackSet, puis scan en série et vue multi-comptes.
 */
export function OrgAccountsPage({ profileId }: { profileId: string }) {
  const org = useLoad(
    () =>
      get<{ hubAccountId: string; rootId?: string; canCreate: boolean; accounts: OrgAccount[] }>(
        `/api/profiles/${profileId}/org-accounts`,
      ),
    [profileId],
  );
  const all = useLoad(() => get<{ profiles: ProfileView[] }>('/api/profiles'), [profileId]);
  const help = useLoad(() => get<{ stackSet: string }>('/api/help/iam'), []);
  const services = useLoad(() => get<{ defaults: string[] }>('/api/config/services'), []);
  const hub = all.data?.profiles.find((p) => p.id === profileId);
  // Profils déjà rattachés à ce hub : ils fixent le rôle et l'External ID de l'organisation.
  const children = (all.data?.profiles ?? []).filter(
    (p) => p.auth.kind === 'assume-role-profile' && p.auth.parentProfileId === profileId,
  );
  const first = children[0]?.auth;
  const known = first?.kind === 'assume-role-profile' ? first : undefined;

  const [roleName, setRoleName] = useState<string>();
  const [externalId, setExternalId] = useState(randomExternalId);
  const [chosen, setChosen] = useState<string[]>();
  const [regions, setRegions] = useState<string[]>();
  const [message, setMessage] = useState<string>();
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [run, error, busy] = useAction();

  const hubAccount = org.data?.hubAccountId ?? '';
  const accounts = org.data?.accounts ?? [];
  const candidates = accounts.filter((a) => a.id !== hubAccount && a.profiles.length === 0);
  const selected = org.data?.canCreate
    ? (chosen ?? candidates.filter((a) => a.status === 'ACTIVE').map((a) => a.id))
    : [];
  const role = roleName ?? known?.roleArn?.split('/').pop() ?? 'CartographeLectureSeule';
  const extId = known?.externalId ?? externalId;
  const selRegions = regions ?? hub?.regions ?? [];
  const commands = [
    'aws cloudformation create-stack-set --stack-set-name cartographe-lecture-seule \\',
    '  --template-body file://stackset-lecture-seule.yaml --permission-model SERVICE_MANAGED \\',
    '  --auto-deployment Enabled=true,RetainStacksOnAccountRemoval=false --capabilities CAPABILITY_NAMED_IAM \\',
    `  --parameters ParameterKey=TrustedAccountId,ParameterValue=${hubAccount} \\`,
    `               ParameterKey=ExternalId,ParameterValue=${extId} \\`,
    `               ParameterKey=RoleName,ParameterValue=${role}`,
    'aws cloudformation create-stack-instances --stack-set-name cartographe-lecture-seule \\',
    `  --deployment-targets OrganizationalUnitIds=${org.data?.rootId ?? '<ID_RACINE>'} --regions us-east-1`,
  ].join('\n');

  const scanAll = () =>
    run(async () => {
      const wanted = services.data?.defaults ?? [];
      for (const p of children) {
        setProgress((x) => ({ ...x, [p.id]: t('org.scanEnCours') }));
        const r = await scanAndWait(p.id, wanted).catch((err: Error) => ({
          errorCount: 0,
          failure: err.message,
          resources: undefined,
        }));
        const text =
          r.failure ??
          (r.errorCount
            ? t('org.scanErreurs', { n: r.errorCount })
            : t('org.scanOk', { n: r.resources ?? 0 }));
        setProgress((x) => ({ ...x, [p.id]: text }));
      }
    });

  if (org.error) return <Alert kind="error">{org.error}</Alert>;
  if (!org.data || !all.data) return <p className="muted">{t('app.chargement')}</p>;

  return (
    <div style={{ maxWidth: 980 }}>
      <h1>{t('org.titre')}</h1>
      <p className="muted">{t('org.intro', { hub: hub?.name ?? '', compte: hubAccount })}</p>
      {!org.data.canCreate && <Alert kind="warn">{t('org.hubImpossible')}</Alert>}
      {accounts.length === 0 && <Alert>{t('org.aucunCompte')}</Alert>}

      <details className="card" open={children.length === 0}>
        <summary>{t('org.etapeRole')}</summary>
        <div className="row">
          <Field label={t('org.nomRole')}>
            <input value={role} disabled={!!known} onChange={(e) => setRoleName(e.target.value.trim())} />
          </Field>
          <Field label={t('cred.externalId')}>
            <span className="row">
              <input className="mono" value={extId} readOnly size={36} />
              {!known && (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t('org.regenerer')}
                  onClick={() => setExternalId(randomExternalId())}
                >
                  <Icon name="refresh" />
                </button>
              )}
            </span>
            <span className="small">{t('org.externalIdAide')}</span>
          </Field>
        </div>
        <div className="row">
          <h3 style={{ margin: 0 }}>{t('org.commandes')}</h3>
          <span className="spacer" />
          <CopyButton text={commands} />
        </div>
        <pre className="code">{commands}</pre>
        <div className="row">
          <h3 style={{ margin: 0 }}>{t('org.modele')}</h3>
          <span className="spacer" />
          {help.data && (
            <>
              <CopyButton text={help.data.stackSet} />
              <button
                type="button"
                onClick={() =>
                  download('stackset-lecture-seule.yaml', help.data?.stackSet ?? '', 'text/yaml')
                }
              >
                {t('commun.telecharger')}
              </button>
            </>
          )}
        </div>
      </details>

      {accounts.length > 0 && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await post<{ created: unknown[] }>(`/api/profiles/${profileId}/org-accounts`, {
                accountIds: selected,
                roleName: role,
                externalId: extId,
                regions: selRegions,
                allowedGroups: hub?.allowedGroups ?? [],
              });
              setMessage(t('org.crees', { n: r.created.length }));
              setChosen(undefined);
              org.reload();
              all.reload();
            });
          }}
        >
          <h2>{t('org.etapeComptes')}</h2>
          <fieldset className="choices" data-testid="comptes-org">
            {accounts.map((a) => {
              const isHub = a.id === hubAccount;
              const taken = isHub || a.profiles.length > 0 || !org.data?.canCreate;
              return (
                <label
                  key={a.id}
                  className={`choice${selected.includes(a.id) ? ' selected' : ''}${taken ? ' disabled' : ''}`}
                >
                  <input
                    type="checkbox"
                    disabled={taken}
                    checked={selected.includes(a.id)}
                    onChange={(e) =>
                      setChosen(e.target.checked ? [...selected, a.id] : selected.filter((x) => x !== a.id))
                    }
                  />
                  <span>
                    <strong>
                      {a.name} · <span className="mono">{a.id}</span>{' '}
                      {isHub && <span className="badge">{t('org.hub')}</span>}
                    </strong>
                    <span className="muted small">
                      {a.status}
                      {a.profiles.length > 0 &&
                        ` · ${t('org.dejaProfil', { profils: a.profiles.map((p) => p.name).join(', ') })}`}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          {org.data.canCreate && <RegionPicker value={selRegions} onChange={setRegions} />}
          {message && <Alert kind="ok">{message}</Alert>}
          <button
            className="primary"
            type="submit"
            disabled={busy || selected.length === 0 || selRegions.length === 0}
          >
            {t('org.creer', { n: selected.length })}
          </button>
        </form>
      )}

      {children.length > 0 && (
        <div className="card">
          <h2>{t('org.etapeScan')}</h2>
          <table className="data">
            <tbody>
              {children.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/profils/${p.id}/diagramme`}>{p.name}</Link>
                  </td>
                  <td className="mono">{p.accountId}</td>
                  <td>
                    {progress[p.id] ??
                      (p.lastSnapshot
                        ? t('profils.dernierScan', {
                            date: fmtDate(p.lastSnapshot.createdAt),
                            n: p.lastSnapshot.resourceCount,
                          })
                        : t('org.scanAttente'))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={busy} onClick={() => void scanAll()}>
              {t('org.scanner', { n: children.length })}
            </button>
            <button
              onClick={() =>
                navigate(`/multi-comptes/${[profileId, ...children.map((p) => p.id)].join(',')}`)
              }
            >
              {t('org.ouvrirMulti')}
            </button>
          </div>
        </div>
      )}
      {error && <Alert kind="error">{error}</Alert>}
    </div>
  );
}
