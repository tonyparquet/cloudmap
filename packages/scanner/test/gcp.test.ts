import { describe, expect, it } from 'vitest';
import { cleanAssetData, GCP_SERVICES, scanGcp, toAssetName, type GcpToken } from '../src/index.ts';

// Google Cloud n'est jamais contacté : `fetch` simulé, réponses indexées par URL (sans paramètre de page).
type Reply = { status: number; body: unknown };
const ok = (body: unknown): Reply => ({ status: 200, body });
const denied = (permission: string): Reply => ({
  status: 403,
  body: {
    error: {
      code: 403,
      status: 'PERMISSION_DENIED',
      message: `Permission '${permission}' denied on resource`,
    },
  },
});

function fakeGoogle(routes: Record<string, Reply | Reply[]>) {
  const calls: { method: string; url: string }[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? 'GET', url });
    const u = new URL(url);
    const page = u.searchParams.get('pageToken');
    u.searchParams.delete('pageToken');
    const key = Object.keys(routes).find((k) => {
      const want = new URL(k.startsWith('https://') ? k : `https://${k}`);
      return (
        want.host === u.host &&
        want.pathname === u.pathname &&
        [...want.searchParams].every(([n, v]) => u.searchParams.getAll(n).includes(v))
      );
    });
    const route = key ? routes[key] : undefined;
    const reply = Array.isArray(route) ? route[page ? Number(page) : 0] : route;
    const r = reply ?? { status: 404, body: { error: { status: 'NOT_FOUND', message: `absent : ${url}` } } };
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const token: GcpToken = { provider: 'gcp', accessToken: 'ya29.jeton-de-test', readOnlyScope: true };
const P = 'projet-test';
const API = `https://www.googleapis.com/compute/v1/projects/${P}`;
const CAI = `cloudasset.googleapis.com/v1/projects/${P}/assets`;
const CRM = 'cloudresourcemanager.googleapis.com/v3';
const SECRET = 'valeur-fictive-secrete';

const project = {
  name: 'projects/42',
  projectId: P,
  displayName: 'Projet test',
  parent: 'folders/7',
  state: 'ACTIVE',
};
const asset = (type: string, path: string, location: string, data: Record<string, unknown>) => ({
  name: `//compute.googleapis.com/projects/${P}/${path}`,
  assetType: `compute.googleapis.com/${type}`,
  resource: { location, data },
});

const assetRoutes = (): Record<string, Reply | Reply[]> => ({
  [`${CAI}?assetTypes=compute.googleapis.com%2FNetwork`]: [
    ok({
      assets: [asset('Network', 'global/networks/n', 'global', { name: 'n' })],
      nextPageToken: '1',
    }),
    ok({
      assets: [
        asset('Subnetwork', 'regions/europe-west9/subnetworks/s', 'europe-west9', {
          name: 's',
          network: `${API}/global/networks/n`,
          ipCidrRange: '10.0.0.0/24',
        }),
        asset('Subnetwork', 'regions/us-east1/subnetworks/hors-region', 'us-east1', { name: 'hors-region' }),
      ],
    }),
  ],
  [`${CAI}?assetTypes=compute.googleapis.com%2FInstance`]: ok({
    assets: [
      asset('Instance', 'zones/europe-west9-a/instances/vm', 'europe-west9-a', {
        name: 'vm',
        machineType: `${API}/zones/europe-west9-a/machineTypes/e2-micro`,
        networkInterfaces: [
          { subnetwork: `${API}/regions/europe-west9/subnetworks/s`, networkIP: '10.0.0.2' },
        ],
        metadata: {
          items: [
            { key: 'startup-script', value: `echo ${SECRET}` },
            { key: 'created-by', value: 'projects/42/zones/europe-west9-a/instanceGroupManagers/mig' },
          ],
        },
        labels: { equipe: 'web' },
      }),
    ],
  }),
  [`${CAI}?assetTypes=container.googleapis.com%2FCluster`]: ok({
    assets: [
      {
        name: `//container.googleapis.com/projects/${P}/locations/europe-west9/clusters/gke`,
        assetType: 'container.googleapis.com/Cluster',
        resource: {
          location: 'europe-west9',
          data: { name: 'gke', masterAuth: { clientKey: SECRET, clusterCaCertificate: 'cert' } },
        },
      },
    ],
  }),
  [`${CAI}?assetTypes=run.googleapis.com%2FService`]: ok({
    assets: [
      {
        name: `//run.googleapis.com/projects/${P}/locations/europe-west9/services/api`,
        assetType: 'run.googleapis.com/Service',
        resource: {
          location: 'europe-west9',
          data: {
            metadata: { name: 'api' },
            spec: {
              template: {
                spec: {
                  containers: [
                    {
                      env: [
                        { name: 'MOT_DE_PASSE', value: SECRET },
                        { name: 'REF', valueFrom: { secretKeyRef: { name: 'mdp', key: 'latest' } } },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    ],
  }),
  [`${CAI}?assetTypes=sqladmin.googleapis.com%2FInstance`]: ok({}),
  [`${CAI}?assetTypes=storage.googleapis.com%2FBucket`]: ok({}),
  [`${CAI}?assetTypes=pubsub.googleapis.com%2FTopic`]: ok({}),
  [`${CAI}?assetTypes=secretmanager.googleapis.com%2FSecret`]: ok({
    assets: [
      {
        name: '//secretmanager.googleapis.com/projects/42/secrets/mdp',
        assetType: 'secretmanager.googleapis.com/Secret',
        resource: {
          location: 'global',
          data: { name: 'projects/42/secrets/mdp', replication: { automatic: {} } },
        },
      },
    ],
  }),
  [`${CAI}?assetTypes=artifactregistry.googleapis.com%2FRepository`]: ok({
    assets: [
      {
        name: `//cloudbuild.googleapis.com/projects/${P}/locations/global/triggers/t`,
        assetType: 'cloudbuild.googleapis.com/BuildTrigger',
        resource: {
          location: 'global',
          data: {
            name: 't',
            substitutions: { _JETON: SECRET },
            build: { steps: [{ env: [`JETON=${SECRET}`] }] },
          },
        },
      },
    ],
  }),
});

const orgRoutes = (orgReply: Reply): Record<string, Reply | Reply[]> => ({
  [`${CRM}/folders/7`]: ok({ name: 'folders/7', displayName: 'Prod', parent: 'organizations/1' }),
  [`${CRM}/organizations/1`]: orgReply,
  [`${CRM}/folders?parent=organizations/1`]: ok({
    folders: [{ name: 'folders/7', parent: 'organizations/1' }],
  }),
  [`${CRM}/folders?parent=folders/7`]: ok({}),
  [`${CRM}/projects?parent=organizations/1`]: ok({}),
  [`${CRM}/projects?parent=folders/7`]: ok({
    projects: [
      { name: 'projects/42', projectId: P },
      { name: 'projects/43', projectId: 'autre', parent: 'folders/7' },
    ],
  }),
  'orgpolicy.googleapis.com/v2/projects/42/policies': ok({
    policies: [{ name: 'projects/42/policies/iam.disableServiceAccountKeyCreation' }],
  }),
  'orgpolicy.googleapis.com/v2/folders/7/policies': denied('orgpolicy.policies.list'),
  'orgpolicy.googleapis.com/v2/organizations/1/policies': ok({}),
  'orgpolicy.googleapis.com/v2/projects/43/policies': ok({}),
  'cloudasset.googleapis.com/v1/organizations/1:searchAllIamPolicies': ok({
    results: [
      {
        resource: '//cloudresourcemanager.googleapis.com/folders/7',
        policy: {
          bindings: [
            {
              role: 'roles/editor',
              members: ['group:dev@exemple.fr', 'serviceAccount:x@p.iam.gserviceaccount.com'],
            },
          ],
        },
      },
      {
        resource: `//storage.googleapis.com/bucket`,
        policy: { bindings: [{ role: 'roles/viewer', members: ['user:a@exemple.fr'] }] },
      },
    ],
  }),
  'cloudasset.googleapis.com/v1/projects/42:searchAllIamPolicies': ok({
    results: [
      {
        resource: '//cloudresourcemanager.googleapis.com/projects/42',
        policy: { bindings: [{ role: 'roles/viewer', members: ['user:a@exemple.fr'] }] },
      },
    ],
  }),
});

const base = { profileId: 'p', accountId: P, regions: ['europe-west9'], credentials: token };

describe('scanner Google Cloud (Cloud Asset Inventory, fetch simulé)', () => {
  it('GET uniquement, pagination, filtre de région, normalisation, aucune valeur secrète', async () => {
    const google = fakeGoogle({
      [`${CRM}/projects/${P}`]: ok(project),
      ...assetRoutes(),
      ...orgRoutes(ok({ name: 'organizations/1', displayName: 'exemple.fr' })),
    });
    const events: string[] = [];
    const snap = await scanGcp({
      ...base,
      fetchImpl: google.fetchImpl,
      onProgress: (e) => events.push(e.type),
    });

    expect(
      google.calls.every((c) => c.method === 'GET' && /^https:\/\/[a-z0-9-]+\.googleapis\.com\//.test(c.url)),
    ).toBe(true);
    expect(google.calls.some((c) => /:access|versions|getIamPolicy|:testIamPermissions/.test(c.url))).toBe(
      false,
    );
    expect(snap.meta).toMatchObject({ provider: 'gcp', accountId: P, profileId: 'p' });
    expect(snap.errors).toEqual([]);
    expect(events[0]).toBe('start');
    expect(events.filter((e) => e === 'progress')).toHaveLength(GCP_SERVICES.length);
    expect(events.at(-1)).toBe('done');

    const byName = (suffix: string) => snap.resources.find((r) => r.id.endsWith(suffix));
    expect(byName('/subnetworks/s')).toMatchObject({
      region: 'europe-west9',
      raw: { network: `//compute.googleapis.com/projects/${P}/global/networks/n` },
    });
    expect(byName('/subnetworks/hors-region')).toBeUndefined();
    const vm = byName('/instances/vm');
    expect(vm).toMatchObject({ region: 'europe-west9', tags: { equipe: 'web' } });
    expect(vm?.raw).toMatchObject({
      machineType: `//compute.googleapis.com/projects/${P}/zones/europe-west9-a/machineTypes/e2-micro`,
      metadata: {
        items: [
          { key: 'startup-script' },
          {
            key: 'created-by',
            value: '//compute.googleapis.com/projects/42/zones/europe-west9-a/instanceGroupManagers/mig',
          },
        ],
      },
    });
    expect(byName('/services/api')?.raw).toMatchObject({
      spec: {
        template: {
          spec: {
            containers: [
              {
                env: [
                  { name: 'MOT_DE_PASSE' },
                  { name: 'REF', valueFrom: { secretKeyRef: { name: 'mdp' } } },
                ],
              },
            ],
          },
        },
      },
    });
    expect(byName('/triggers/t')?.raw).toEqual({
      name: 't',
      substitutions: { _JETON: '(valeur masquée)' },
      build: { steps: [{ env: [{ name: 'JETON' }] }] },
    });
    expect(JSON.stringify(snap)).not.toContain(SECRET);
    expect(JSON.stringify(snap)).not.toContain('masterAuth');

    // Organisation : ancêtres, descendants, contraintes, liaisons de groupes et d'utilisateurs sur Resource Manager.
    const types = (t: string) => snap.resources.filter((r) => r.type === t).map((r) => r.id);
    expect(types('cloudresourcemanager.googleapis.com/Organization')).toEqual([
      '//cloudresourcemanager.googleapis.com/organizations/1',
    ]);
    expect(types('cloudresourcemanager.googleapis.com/Folder')).toEqual([
      '//cloudresourcemanager.googleapis.com/folders/7',
    ]);
    expect(types('cloudresourcemanager.googleapis.com/Project').sort()).toEqual([
      '//cloudresourcemanager.googleapis.com/projects/42',
      '//cloudresourcemanager.googleapis.com/projects/43',
    ]);
    expect(types('orgpolicy.googleapis.com/Policy')).toEqual([
      '//orgpolicy.googleapis.com/projects/42/policies/iam.disableServiceAccountKeyCreation',
    ]);
    expect(snap.resources.filter((r) => r.type === 'iam.googleapis.com/Binding').map((r) => r.raw)).toEqual([
      { resource: 'folders/7', role: 'roles/editor', member: 'group:dev@exemple.fr' },
    ]);
  });

  it('permission refusée : erreur explicite avec la permission, le scan continue', async () => {
    const routes = assetRoutes();
    routes[`${CAI}?assetTypes=compute.googleapis.com%2FInstance`] = denied('cloudasset.assets.listResource');
    const google = fakeGoogle({ [`${CRM}/projects/${P}`]: ok(project), ...routes });
    const snap = await scanGcp({ ...base, services: ['network', 'compute'], fetchImpl: google.fetchImpl });
    expect(snap.errors).toEqual([
      {
        service: 'compute',
        region: 'global',
        code: 'PERMISSION_DENIED',
        message: 'Permission manquante : cloudasset.assets.listResource',
      },
    ]);
    expect(snap.resources.map((r) => r.type)).toEqual([
      'compute.googleapis.com/Network',
      'compute.googleapis.com/Subnetwork',
    ]);
  });

  it('organisation illisible (projet membre) : portée « membre », pas une erreur', async () => {
    const google = fakeGoogle({
      [`${CRM}/projects/${P}`]: ok(project),
      ...orgRoutes(denied('resourcemanager.organizations.get')),
    });
    const snap = await scanGcp({ ...base, services: ['organisation'], fetchImpl: google.fetchImpl });
    expect(snap.errors).toEqual([]);
    expect(
      snap.resources.find((r) => r.type === 'cloudresourcemanager.googleapis.com/Organization')?.raw,
    ).toEqual({
      name: 'organizations/1',
      _scope: 'membre',
    });
    // Sans organisation lisible, les liaisons IAM sont cherchées sur le projet scanné.
    expect(google.calls.some((c) => c.url.includes('/projects/42:searchAllIamPolicies'))).toBe(true);
    expect(snap.resources.filter((r) => r.type === 'iam.googleapis.com/Binding').map((r) => r.raw)).toEqual([
      { resource: 'projects/42', role: 'roles/viewer', member: 'user:a@exemple.fr' },
    ]);
  });

  it('contraintes du projet scanné refusées : erreur signalée', async () => {
    const routes = orgRoutes(ok({ name: 'organizations/1' }));
    routes['orgpolicy.googleapis.com/v2/projects/42/policies'] = denied('orgpolicy.policies.list');
    const google = fakeGoogle({ [`${CRM}/projects/${P}`]: ok(project), ...routes });
    const snap = await scanGcp({ ...base, services: ['organisation'], fetchImpl: google.fetchImpl });
    expect(snap.errors.map((e) => e.message)).toEqual(['Permission manquante : orgpolicy.policies.list']);
  });

  it('projet inaccessible : scan refusé', async () => {
    const google = fakeGoogle({ [`${CRM}/projects/${P}`]: denied('resourcemanager.projects.get') });
    await expect(scanGcp({ ...base, fetchImpl: google.fetchImpl })).rejects.toThrow(/denied/);
  });
});

describe('normalisation des données Cloud Asset', () => {
  it('selfLink et chemins Compute → noms d’actifs, autres valeurs inchangées', () => {
    expect(toAssetName(`${API}/zones/z/instances/i`)).toBe(
      `//compute.googleapis.com/projects/${P}/zones/z/instances/i`,
    );
    expect(toAssetName(`projects/${P}/global/networks/n`)).toBe(
      `//compute.googleapis.com/projects/${P}/global/networks/n`,
    );
    expect(toAssetName(`projects/${P}/locations/l/connectors/c`)).toBe(
      `projects/${P}/locations/l/connectors/c`,
    );
    expect(toAssetName('vpc-principal')).toBe('vpc-principal');
  });

  it('variables d’environnement, métadonnées et authentification maître expurgées', () => {
    expect(
      cleanAssetData({
        serviceConfig: { environmentVariables: { A: SECRET } },
        envVariables: { B: SECRET },
        secretEnv: { C: SECRET },
        masterAuth: { password: SECRET },
        env: [{ name: 'D', value: SECRET }, `E=${SECRET}`],
        metadata: {
          items: [
            { key: 'ssh-keys', value: SECRET },
            { key: 'instance-template', value: `projects/${P}/global/instanceTemplates/t` },
          ],
        },
      }),
    ).toEqual({
      serviceConfig: { environmentVariables: { A: '(valeur masquée)' } },
      envVariables: { B: '(valeur masquée)' },
      secretEnv: { C: '(valeur masquée)' },
      env: [{ name: 'D' }, { name: 'E' }],
      metadata: {
        items: [
          { key: 'ssh-keys' },
          {
            key: 'instance-template',
            value: `//compute.googleapis.com/projects/${P}/global/instanceTemplates/t`,
          },
        ],
      },
    });
  });
});
