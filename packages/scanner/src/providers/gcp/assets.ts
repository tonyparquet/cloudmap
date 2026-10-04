import type { Resource } from '@cloudmap/core';

/** Types Cloud Asset Inventory collectés, par service sélectionnable dans l'interface. */
export const GCP_ASSET_TYPES: Record<string, string[]> = {
  network: [
    'Network',
    'Subnetwork',
    'Firewall',
    'Route',
    'Router',
    'Address',
    'GlobalAddress',
    'ForwardingRule',
    'GlobalForwardingRule',
    'BackendService',
    'RegionBackendService',
    'UrlMap',
    'TargetHttpsProxy',
    'TargetHttpProxy',
    'SecurityPolicy',
    'NetworkEndpointGroup',
    'ServiceAttachment',
  ]
    .map((t) => `compute.googleapis.com/${t}`)
    .concat(['vpcaccess.googleapis.com/Connector', 'dns.googleapis.com/ManagedZone']),
  compute: ['Instance', 'InstanceGroup', 'InstanceGroupManager'].map((t) => `compute.googleapis.com/${t}`),
  gke: ['container.googleapis.com/Cluster', 'container.googleapis.com/NodePool'],
  serverless: [
    'run.googleapis.com/Service',
    'cloudfunctions.googleapis.com/CloudFunction',
    'cloudfunctions.googleapis.com/Function',
    'appengine.googleapis.com/Application',
    'appengine.googleapis.com/Service',
  ],
  data: [
    'sqladmin.googleapis.com/Instance',
    'firestore.googleapis.com/Database',
    'bigtableadmin.googleapis.com/Instance',
    'spanner.googleapis.com/Instance',
    'redis.googleapis.com/Instance',
  ],
  storage: ['storage.googleapis.com/Bucket'],
  messaging: ['pubsub.googleapis.com/Topic', 'pubsub.googleapis.com/Subscription'],
  security: [
    'secretmanager.googleapis.com/Secret',
    'cloudkms.googleapis.com/KeyRing',
    'cloudkms.googleapis.com/CryptoKey',
  ],
  cicd: ['artifactregistry.googleapis.com/Repository', 'cloudbuild.googleapis.com/BuildTrigger'],
};

const COMPUTE_LINK =
  /^https:\/\/(?:www|compute)\.googleapis\.com\/compute\/(?:v1|beta|alpha)\/(projects\/.+)$/;
const COMPUTE_PATH = /^projects\/[^/]+\/(?:global|regions\/[^/]+|zones\/[^/]+)\/[a-zA-Z]+\/[^/]+$/;

/** Référence Compute (selfLink ou chemin `projects/p/global/networks/n`) → nom d'actif Cloud Asset. */
export function toAssetName(value: string): string {
  const link = COMPUTE_LINK.exec(value);
  if (link) return `//compute.googleapis.com/${link[1]}`;
  return COMPUTE_PATH.test(value) ? `//compute.googleapis.com/${value}` : value;
}

/** Métadonnées d'instance conservées (les autres valeurs, ex. scripts de démarrage, clés SSH, sont retirées). */
const METADATA_KEPT = new Set(['created-by', 'instance-template']);
/** Dictionnaires dont seules les clés sont conservées (valeurs potentiellement secrètes). */
const KEYS_ONLY = new Set([
  'environmentVariables',
  'buildEnvironmentVariables',
  'envVariables',
  'substitutions',
  'secretEnv',
]);
const MASKED = '(valeur masquée)';

/**
 * Données d'un actif sans valeur sensible, références normalisées en noms d'actifs : variables
 * d'environnement réduites à leur nom (références de secrets conservées), métadonnées d'instance
 * hors liste blanche et authentification maître GKE retirées.
 */
export function cleanAssetData(value: unknown, key?: string): unknown {
  if (typeof value === 'string') return toAssetName(value);
  if (Array.isArray(value)) {
    if (key === 'env')
      return value.map((e) => {
        // Cloud Build : `CLE=valeur` ; Cloud Run : `{ name, value | valueFrom }`.
        if (typeof e === 'string') return { name: e.split('=')[0] };
        const x = (e ?? {}) as Record<string, unknown>;
        return { name: x.name, ...(x.valueFrom ? { valueFrom: cleanAssetData(x.valueFrom) } : {}) };
      });
    if (key === 'items' && value.every((x) => x && typeof x === 'object' && 'key' in x))
      return value.map((x) => {
        const { key: k, value: v } = x as { key: string; value?: unknown };
        return METADATA_KEPT.has(k) ? { key: k, value: cleanAssetData(v) } : { key: k };
      });
    return value.map((x) => cleanAssetData(x));
  }
  if (value && typeof value === 'object') {
    if (key && KEYS_ONLY.has(key)) return Object.fromEntries(Object.keys(value).map((k) => [k, MASKED]));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'masterAuth') continue;
      out[k] = cleanAssetData(v, k);
    }
    return out;
  }
  return value;
}

export interface Asset {
  name: string;
  assetType: string;
  resource?: { data?: Record<string, unknown>; location?: string };
}

const REGION = /^[a-z]+-[a-z]+\d+$/;

/** Région d'un actif : zone ramenée à sa région, `global` ou multirégion (`eu`) sinon. */
export function regionOf(location: string | undefined): string {
  const l = (location ?? 'global').toLowerCase();
  return /^[a-z]+-[a-z]+\d+-[a-z]$/.test(l) ? l.replace(/-[a-z]$/, '') : l;
}

/** Ressource d'un actif, ou `undefined` s'il est hors des régions choisies (global et multirégions toujours gardés). */
export function assetToResource(a: Asset, regions: string[]): Resource | undefined {
  const region = regionOf(a.resource?.location);
  if (REGION.test(region) && !regions.includes(region)) return undefined;
  const data = (a.resource?.data ?? {}) as Record<string, unknown>;
  const labels = (data.labels ?? (data.metadata as Record<string, unknown> | undefined)?.labels) as
    Record<string, unknown> | undefined;
  const tags = labels
    ? Object.fromEntries(
        Object.entries(labels).filter((e): e is [string, string] => typeof e[1] === 'string'),
      )
    : undefined;
  return {
    id: a.name,
    arn: a.name,
    type: a.assetType,
    region,
    raw: cleanAssetData(data),
    ...(tags && Object.keys(tags).length ? { tags } : {}),
  };
}
