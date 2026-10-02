import type { ExternalNode, Profile } from '@carto/core';
import { useEffect, useState } from 'react';
import { get, post, put } from '../api.ts';
import { t } from '../i18n/index.ts';
import { navigate } from '../router.tsx';
import { useApp } from '../store.ts';
import { Alert, Check, Field, useAction } from '../ui.tsx';

/** Codes des régions publiques AWS (données génériques, pas des données client). */
const AWS_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'ca-west-1',
  'sa-east-1',
  'mx-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'af-south-1',
  'me-south-1',
  'me-central-1',
  'il-central-1',
  'ap-south-1',
  'ap-south-2',
  'ap-east-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-southeast-4',
  'ap-southeast-5',
  'ap-southeast-7',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
];

type AuthKind = Profile['auth']['kind'];
type Probe = NonNullable<Profile['probes']>[number];

export function ProfileForm({ id }: { id?: string }) {
  const myGroups = useApp((s) => s.auth?.user?.groups ?? []);
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [description, setDescription] = useState('');
  const [accountId, setAccountId] = useState('');
  const [regions, setRegions] = useState<string[]>([]);
  const [authKind, setAuthKind] = useState<AuthKind>('access-keys');
  const [roleArn, setRoleArn] = useState('');
  const [externalId, setExternalId] = useState('');
  const [groups, setGroups] = useState(myGroups.join(', '));
  const [externals, setExternals] = useState<ExternalNode[]>([]);
  const [probes, setProbes] = useState<Probe[]>([]);
  const [flowEnabled, setFlowEnabled] = useState(false);
  const [logGroups, setLogGroups] = useState('');
  const [lookback, setLookback] = useState(24);
  const [tagFilters, setTagFilters] = useState('');
  const [run, error, busy] = useAction();

  useEffect(() => {
    if (!id) return;
    void get<{ profile: Profile }>(`/api/profiles/${id}`).then(({ profile: p }) => {
      setName(p.name);
      setClient(p.client ?? '');
      setDescription(p.description ?? '');
      setAccountId(p.accountId);
      setRegions(p.regions);
      setAuthKind(p.auth.kind);
      if (p.auth.kind === 'assume-role-hub') {
        setRoleArn(p.auth.roleArn);
        setExternalId(p.auth.externalId);
      }
      setGroups(p.allowedGroups.join(', '));
      setExternals(p.externalNodes ?? []);
      setProbes(p.probes ?? []);
      setFlowEnabled(p.flowLogs?.enabled ?? false);
      setLogGroups((p.flowLogs?.logGroups ?? []).join('\n'));
      setLookback(p.flowLogs?.lookbackHours ?? 24);
      setTagFilters((p.tagFilters ?? []).map((f) => `${f.key}=${f.values.join(',')}`).join('\n'));
    });
  }, [id]);

  const lines = (s: string) =>
    s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  const list = (s: string) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

  const submit = () =>
    run(async () => {
      const body = {
        name,
        ...(client ? { client } : {}),
        ...(description ? { description } : {}),
        accountId: accountId.trim(),
        regions,
        auth:
          authKind === 'assume-role-hub'
            ? {
                kind: authKind,
                roleArn: roleArn.trim(),
                ...(externalId.trim() ? { externalId: externalId.trim() } : {}),
              }
            : { kind: authKind },
        allowedGroups: list(groups),
        externalNodes: externals.map((x) => ({ ...x, ...(x.sublabel ? {} : { sublabel: undefined }) })),
        probes,
        ...(flowEnabled || logGroups
          ? {
              flowLogs: {
                enabled: flowEnabled,
                ...(lines(logGroups).length ? { logGroups: lines(logGroups) } : {}),
                lookbackHours: lookback,
              },
            }
          : {}),
        tagFilters: lines(tagFilters).map((l) => {
          const [key = '', values = ''] = l.split('=');
          return { key: key.trim(), values: list(values) };
        }),
      };
      const r = id
        ? await put<{ profile: Profile }>(`/api/profiles/${id}`, body)
        : await post<{ profile: Profile }>('/api/profiles', body);
      navigate(`/profils/${r.profile.id}/diagramme`);
    });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      style={{ maxWidth: 820 }}
    >
      <h1>{id ? t('form.titreEdition') : t('form.titreNouveau')}</h1>
      <div className="card">
        <Field label={t('form.nom')}>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </Field>
        <Field label={t('form.client')}>
          <input value={client} onChange={(e) => setClient(e.target.value)} maxLength={100} />
        </Field>
        <Field label={t('form.description')}>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
        </Field>
        <Field label={t('form.compte')}>
          <input value={accountId} onChange={(e) => setAccountId(e.target.value)} pattern="\d{12}" required />
        </Field>
        <Field label={t('form.regions')}>
          <select
            multiple
            size={8}
            value={regions}
            onChange={(e) => setRegions([...e.target.selectedOptions].map((o) => o.value))}
          >
            {AWS_REGIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('form.groupes')}>
          <input value={groups} onChange={(e) => setGroups(e.target.value)} />
        </Field>
      </div>

      <div className="card">
        <Field label={t('form.mode')}>
          <select value={authKind} onChange={(e) => setAuthKind(e.target.value as AuthKind)}>
            {(['access-keys', 'assume-role-hub', 'import-only'] as const).map((k) => (
              <option key={k} value={k}>
                {t(`auth.${k}`)}
              </option>
            ))}
          </select>
        </Field>
        {authKind === 'assume-role-hub' && (
          <>
            <Field label={t('form.roleArn')}>
              <input
                value={roleArn}
                onChange={(e) => setRoleArn(e.target.value)}
                placeholder="arn:aws:iam::<ACCOUNT_ID>:role/<NOM>"
                required
              />
            </Field>
            <Field label={t('form.externalId')}>
              <input value={externalId} onChange={(e) => setExternalId(e.target.value)} />
            </Field>
          </>
        )}
      </div>

      <div className="card">
        <h2>{t('form.externes')}</h2>
        {externals.map((x, i) => (
          <div className="row" key={i}>
            {(['id', 'label', 'sublabel', 'icon'] as const).map((k) => (
              <input
                key={k}
                aria-label={t(
                  k === 'id'
                    ? 'form.externeId'
                    : k === 'label'
                      ? 'form.externeLibelle'
                      : k === 'sublabel'
                        ? 'form.externeSous'
                        : 'form.externeIcone',
                )}
                placeholder={t(
                  k === 'id'
                    ? 'form.externeId'
                    : k === 'label'
                      ? 'form.externeLibelle'
                      : k === 'sublabel'
                        ? 'form.externeSous'
                        : 'form.externeIcone',
                )}
                value={x[k] ?? ''}
                onChange={(e) =>
                  setExternals(externals.map((y, j) => (j === i ? { ...y, [k]: e.target.value } : y)))
                }
                style={{ width: k === 'label' ? 140 : 100 }}
              />
            ))}
            <input
              placeholder={t('form.externeLiens')}
              value={(x.linksTo ?? []).join(', ')}
              onChange={(e) =>
                setExternals(externals.map((y, j) => (j === i ? { ...y, linksTo: list(e.target.value) } : y)))
              }
              style={{ flex: 1 }}
            />
            <button type="button" onClick={() => setExternals(externals.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setExternals([...externals, { id: '', label: '', icon: 'git', linksTo: [] }])}
        >
          + {t('commun.ajouter')}
        </button>
      </div>

      <div className="card">
        <h2>{t('form.sondes')}</h2>
        {probes.map((p, i) => (
          <div className="row" key={i}>
            <input
              placeholder={t('form.sondeUrl')}
              value={p.url}
              style={{ flex: 1 }}
              onChange={(e) => setProbes(probes.map((y, j) => (j === i ? { ...y, url: e.target.value } : y)))}
            />
            <input
              placeholder={t('form.sondeNoeud')}
              value={p.attachTo ?? ''}
              onChange={(e) =>
                setProbes(
                  probes.map((y, j) => (j === i ? { ...y, attachTo: e.target.value || undefined } : y)),
                )
              }
            />
            <Check
              label={t('form.sondeHttp')}
              checked={!!p.allowHttp}
              onChange={(v) => setProbes(probes.map((y, j) => (j === i ? { ...y, allowHttp: v } : y)))}
            />
            <Check
              label={t('form.sondePrive')}
              checked={!!p.allowPrivate}
              onChange={(v) => setProbes(probes.map((y, j) => (j === i ? { ...y, allowPrivate: v } : y)))}
            />
            <button type="button" onClick={() => setProbes(probes.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setProbes([...probes, { url: 'https://' }])}>
          + {t('commun.ajouter')}
        </button>
      </div>

      <div className="card">
        <h2>{t('form.flowLogs')}</h2>
        <Check label={t('form.flowLogsActifs')} checked={flowEnabled} onChange={setFlowEnabled} />
        <Field label={t('form.flowLogsGroupes')}>
          <textarea value={logGroups} onChange={(e) => setLogGroups(e.target.value)} />
        </Field>
        <Field label={t('form.flowLogsHeures')}>
          <input
            type="number"
            min={1}
            max={720}
            value={lookback}
            onChange={(e) => setLookback(Number(e.target.value))}
          />
        </Field>
        <Field label={t('form.filtresTags')}>
          <textarea value={tagFilters} onChange={(e) => setTagFilters(e.target.value)} />
        </Field>
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>
          {t('commun.enregistrer')}
        </button>
        <button type="button" onClick={() => window.history.back()}>
          {t('commun.annuler')}
        </button>
      </div>
    </form>
  );
}
