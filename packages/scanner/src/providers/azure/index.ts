import type { RawSnapshot, Resource } from '@cloudmap/core';
import { SCANNER_VERSION } from '../../context.ts';
import type { ScanEvent } from '../../scan.ts';
import { CloudHttpError, ReadOnlyHttp } from '../http.ts';
import type { TokenScanner } from '../types.ts';
import { ARM, azureSubscription, type AzureToken } from './auth.ts';

export * from './auth.ts';

/** Types inventoriés par service (types ARM en minuscules, tels que renvoyés par Resource Graph). */
const SERVICE_TYPES: Record<string, string[]> = {
  network: [
    'microsoft.network/virtualnetworks',
    'microsoft.network/networksecuritygroups',
    'microsoft.network/applicationsecuritygroups',
    'microsoft.network/networkinterfaces',
    'microsoft.network/publicipaddresses',
    'microsoft.network/natgateways',
    'microsoft.network/routetables',
    'microsoft.network/privateendpoints',
    'microsoft.network/loadbalancers',
    'microsoft.network/applicationgateways',
    'microsoft.network/frontdoors',
    'microsoft.cdn/profiles',
    'microsoft.network/azurefirewalls',
    'microsoft.network/virtualnetworkgateways',
    'microsoft.network/bastionhosts',
    'microsoft.apimanagement/service',
  ],
  compute: ['microsoft.compute/virtualmachines', 'microsoft.compute/virtualmachinescalesets'],
  aks: ['microsoft.containerservice/managedclusters'],
  appservice: ['microsoft.web/serverfarms', 'microsoft.web/sites'],
  containers: [
    'microsoft.app/containerapps',
    'microsoft.app/managedenvironments',
    'microsoft.containerregistry/registries',
    'microsoft.containerinstance/containergroups',
  ],
  data: [
    'microsoft.sql/servers',
    'microsoft.sql/servers/databases',
    'microsoft.documentdb/databaseaccounts',
    'microsoft.dbforpostgresql/flexibleservers',
    'microsoft.dbformysql/flexibleservers',
    'microsoft.cache/redis',
  ],
  storage: ['microsoft.storage/storageaccounts'],
  messaging: ['microsoft.servicebus/namespaces', 'microsoft.eventhub/namespaces'],
  security: ['microsoft.keyvault/vaults'],
  monitor: ['microsoft.operationalinsights/workspaces', 'microsoft.insights/components'],
};

/** Services Azure proposés dans l'interface de scan. */
export const AZURE_SERVICES: { key: string; label: string }[] = [
  { key: 'network', label: 'Réseau (VNet, NSG, IP publiques, NAT, équilibreurs, Front Door, APIM)' },
  { key: 'compute', label: 'Machines virtuelles et groupes identiques' },
  { key: 'aks', label: 'AKS' },
  { key: 'appservice', label: 'App Service et Functions' },
  { key: 'containers', label: 'Container Apps, registres, instances de conteneurs' },
  { key: 'data', label: 'Bases de données (SQL, Cosmos DB, PostgreSQL, MySQL, Redis)' },
  { key: 'storage', label: 'Comptes de stockage' },
  { key: 'messaging', label: 'Service Bus et Event Hubs' },
  { key: 'security', label: 'Key Vault (métadonnées)' },
  { key: 'monitor', label: 'Log Analytics et Application Insights' },
  { key: 'organisation', label: "Organisation (groupes d'administration, stratégies, rôles)" },
];

const RESOURCE_GRAPH = `${ARM}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`;

/** Requêtes de l'organisation (portée : tout ce que le principal peut lire). */
const ORG_QUERIES = [
  `resourcecontainers
| where type in~ ('microsoft.management/managementgroups', 'microsoft.resources/subscriptions')
| project id, name, type, location, properties, tags`,
  `policyresources
| where type =~ 'microsoft.authorization/policyassignments'
| project id, name, type, location, properties`,
  `authorizationresources
| where type =~ 'microsoft.authorization/roleassignments'
| extend rd = extract('roledefinitions/([^/]+)$', 1, tolower(tostring(properties.roleDefinitionId)))
| join kind=leftouter (authorizationresources
  | where type =~ 'microsoft.authorization/roledefinitions'
  | project rd = extract('roledefinitions/([^/]+)$', 1, tolower(id)), roleName = tostring(properties.roleName)) on rd
| project id, name, type, location, properties, roleName`,
];

interface Row {
  id?: string;
  name?: string;
  type?: string;
  location?: string;
  resourceGroup?: string;
  properties?: unknown;
  tags?: Record<string, string>;
  sku?: unknown;
  kind?: string;
  zones?: string[];
  roleName?: string;
}

/**
 * Jamais de valeur secrète : paramètres d'application, chaînes de connexion, clés, mots de passe et
 * données personnalisées sont retirés ; d'un tableau `secrets`, seuls les noms sont gardés.
 */
const SENSITIVE =
  /^(appSettings|connectionStrings?|adminPassword|administratorLoginPassword|password|primaryKey|secondaryKey|primaryConnectionString|secondaryConnectionString|primaryMasterKey|secondaryMasterKey|accessKeys?|sasToken|secretValue|customData|protectedSettings|value)$/i;

function clean(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    if (/^secrets$/i.test(key)) return value.map((s) => ({ name: (s as { name?: unknown })?.name }));
    return value.map((v) => clean(v));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!SENSITIVE.test(k)) out[k] = clean(v, k);
    return out;
  }
  // Identifiants ARM insensibles à la casse : en minuscules pour les relations et le modèle réseau.
  return typeof value === 'string' && /^\/(subscriptions|providers)\//i.test(value)
    ? value.toLowerCase()
    : value;
}

function toResource(row: Row): Resource | undefined {
  if (!row.id || !row.type) return undefined;
  const id = row.id.toLowerCase();
  const raw = clean({
    name: row.name,
    resourceGroup: row.resourceGroup,
    kind: row.kind,
    sku: row.sku,
    zones: row.zones,
    roleName: row.roleName,
    properties: row.properties,
  });
  return {
    id,
    arn: id,
    type: row.type.toLowerCase(),
    region: row.location ? row.location.toLowerCase() : 'global',
    raw,
    ...(row.tags && Object.keys(row.tags).length ? { tags: row.tags } : {}),
  };
}

type Props = Record<string, unknown>;
const props = (r: Resource) => (((r.raw ?? {}) as Props).properties ?? {}) as Props;
const idOf = (v: unknown) => (v as { id?: string } | undefined)?.id;

/**
 * Cartes réseau rattachées à leur propriétaire (VM, endpoint privé) : sous-réseau, IP, NSG, ASG,
 * IP publique. Les règles de placement et l'inférence des flux s'appuient sur ce résumé `_nics`.
 */
export function attachNics(resources: Resource[]): void {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const owners = new Map<string, Props[]>();
  for (const nic of resources.filter((r) => r.type === 'microsoft.network/networkinterfaces')) {
    const p = props(nic);
    const owner = idOf(p.virtualMachine) ?? idOf(p.privateEndpoint);
    if (!owner) continue;
    for (const cfg of (p.ipConfigurations ?? []) as { properties?: Props }[]) {
      const c = cfg.properties ?? {};
      const pipId = idOf(c.publicIPAddress);
      const pip = pipId ? byId.get(pipId) : undefined;
      owners.set(owner, [
        ...(owners.get(owner) ?? []),
        {
          id: nic.id,
          subnetId: idOf(c.subnet),
          privateIp: c.privateIPAddress,
          ...(pipId ? { publicIpId: pipId } : {}),
          ...(pip ? { publicIp: props(pip).ipAddress } : {}),
          nsgId: idOf(p.networkSecurityGroup),
          asgIds: ((c.applicationSecurityGroups ?? []) as { id?: string }[]).map((a) => a.id),
        },
      ]);
    }
  }
  for (const [owner, nics] of owners) {
    const r = byId.get(owner);
    if (r) r.raw = { ...(r.raw as Props), _nics: nics };
  }
}

/** Scan Azure en lecture seule : Resource Graph (requêtes) et vérification de l'abonnement (ARM). */
export const scanAzure: TokenScanner<AzureToken> = async (opts): Promise<RawSnapshot> => {
  const startedAt = new Date().toISOString();
  const sub = await azureSubscription(opts.credentials, opts.accountId, opts.fetchImpl);
  const http = new ReadOnlyHttp('azure', opts.credentials.accessToken, opts.fetchImpl);
  const emit = (e: ScanEvent) => opts.onProgress?.(e);
  const wanted = AZURE_SERVICES.map((s) => s.key).filter(
    (k) => !opts.services?.length || opts.services.includes(k),
  );
  const regions = opts.regions.filter((r) => /^[a-z0-9]+$/.test(r));
  const resources: Resource[] = [];
  const errors: RawSnapshot['errors'] = [];
  emit({ type: 'start', total: wanted.length, regions: opts.regions });

  /** Requête paginée (`$skipToken`) ; l'abonnement du profil seulement, sauf pour l'organisation. */
  const query = async (kql: string, scoped: boolean): Promise<Row[]> => {
    const rows: Row[] = [];
    let skipToken: string | undefined;
    do {
      const page = await http.query<{ data?: Row[]; $skipToken?: string }>(RESOURCE_GRAPH, {
        ...(scoped ? { subscriptions: [sub.subscriptionId] } : {}),
        query: kql,
        options: { resultFormat: 'objectArray', ...(skipToken ? { $skipToken: skipToken } : {}) },
      });
      rows.push(...(page.data ?? []));
      skipToken = page.$skipToken;
    } while (skipToken);
    return rows;
  };

  let done = 0;
  for (const service of wanted) {
    const found: Resource[] = [];
    let failed = 0;
    try {
      const kqls =
        service === 'organisation'
          ? ORG_QUERIES
          : [
              `resources
| where type in~ (${(SERVICE_TYPES[service] ?? []).map((t) => `'${t}'`).join(', ')})
| where isempty(location) or location =~ 'global'${regions.length ? ` or location in~ (${regions.map((r) => `'${r}'`).join(', ')})` : ''}
| project id, name, type, location, resourceGroup, properties, tags, sku, kind, zones`,
            ];
      for (const kql of kqls) {
        for (const row of await query(kql, service !== 'organisation')) {
          const r = toResource(row);
          if (r) found.push(r);
        }
      }
    } catch (err) {
      failed++;
      const denied = err instanceof CloudHttpError && (err.status === 401 || err.status === 403);
      const e = {
        service,
        region: 'global',
        code: err instanceof CloudHttpError ? err.code : 'Erreur',
        message: denied
          ? 'Permission manquante : Microsoft.ResourceGraph/resources/read'
          : String((err as Error).message).slice(0, 500),
      };
      errors.push(e);
      emit({ type: 'error', ...e });
    }
    resources.push(...found);
    emit({
      type: 'progress',
      service,
      region: 'global',
      found: found.length,
      errors: failed,
      done: ++done,
      total: wanted.length,
    });
  }

  attachNics(resources);
  emit({ type: 'done', resources: resources.length, errors: errors.length });
  return {
    schemaVersion: 1,
    meta: {
      profileId: opts.profileId,
      provider: 'azure',
      accountId: sub.subscriptionId,
      regions: opts.regions,
      startedAt,
      finishedAt: new Date().toISOString(),
      scannerVersion: SCANNER_VERSION,
    },
    resources,
    errors,
  };
};
