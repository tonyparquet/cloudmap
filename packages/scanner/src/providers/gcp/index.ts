import type { RawSnapshot, Resource } from '@carto/core';
import { redactString } from '@carto/security';
import pLimit from 'p-limit';
import { SCANNER_VERSION, type ScanError } from '../../context.ts';
import { CloudHttpError, isCloudDenied, ReadOnlyHttp } from '../http.ts';
import type { TokenScanner } from '../types.ts';
import { assetToResource, GCP_ASSET_TYPES, type Asset } from './assets.ts';
import { gcpProject, type GcpToken } from './auth.ts';
import { allPages, collectOrganisation } from './org.ts';

export * from './auth.ts';
export { cleanAssetData, toAssetName } from './assets.ts';

/** Services Google Cloud proposés dans l'interface de scan. */
export const GCP_SERVICES: { key: string; label: string }[] = [
  {
    key: 'network',
    label: 'Réseau (VPC, sous-réseaux, pare-feu, routes, Cloud NAT, équilibreurs, Cloud Armor)',
  },
  { key: 'compute', label: "Compute Engine (instances, groupes d'instances)" },
  { key: 'gke', label: 'GKE (clusters, pools de nœuds)' },
  { key: 'serverless', label: 'Cloud Run, Cloud Functions, App Engine' },
  { key: 'data', label: 'Bases de données (Cloud SQL, Firestore, Bigtable, Spanner, Memorystore)' },
  { key: 'storage', label: 'Cloud Storage' },
  { key: 'messaging', label: 'Pub/Sub' },
  { key: 'security', label: 'Secret Manager (métadonnées), Cloud KMS' },
  { key: 'cicd', label: 'Artifact Registry, Cloud Build' },
  { key: 'organisation', label: "Organisation (dossiers, projets, règles d'administration, liaisons IAM)" },
];

/** Permission manquante, extraite du message Google (« Permission 'x.y.z' denied ») si possible. */
function permissionOf(err: unknown, fallback: string): string {
  const m = /[Pp]ermission '?([a-z]+\.[\w.]+)'?/.exec((err as Error)?.message ?? '');
  return m?.[1] ?? fallback;
}

/** Scan Google Cloud en lecture seule (Cloud Asset Inventory + Resource Manager + Org Policy). */
export const scanGcp: TokenScanner<GcpToken> = async (opts): Promise<RawSnapshot> => {
  const startedAt = new Date().toISOString();
  // Jeton sans accès au projet : le scan est refusé (équivalent du contrôle d'identité AWS).
  const project = await gcpProject(opts.credentials, opts.accountId, opts.fetchImpl);
  const http = new ReadOnlyHttp('gcp', opts.credentials.accessToken, opts.fetchImpl);
  const wanted = new Set(opts.services?.length ? opts.services : GCP_SERVICES.map((s) => s.key));
  const services = GCP_SERVICES.filter((s) => wanted.has(s.key)).map((s) => s.key);
  const resources: Resource[] = [];
  const errors: ScanError[] = [];

  const fail = (service: string) => (err: unknown, permission: string) => {
    const e: ScanError = isCloudDenied(err)
      ? {
          service,
          region: 'global',
          code: (err as CloudHttpError).code,
          message: `Permission manquante : ${permissionOf(err, permission)}`,
        }
      : {
          service,
          region: 'global',
          code: err instanceof CloudHttpError ? err.code : 'Erreur',
          message: redactString(String((err as Error)?.message ?? err)).slice(0, 500),
        };
    errors.push(e);
    opts.onProgress?.({ type: 'error', ...e });
  };

  const collect = async (service: string, emit: (r: Resource) => void) => {
    if (service === 'organisation') return collectOrganisation(http, project, emit, fail(service));
    const types = (GCP_ASSET_TYPES[service] ?? [])
      .map((t) => `assetTypes=${encodeURIComponent(t)}`)
      .join('&');
    const assets = await allPages<'assets', Asset>(
      http,
      `https://cloudasset.googleapis.com/v1/projects/${encodeURIComponent(project.projectId)}/assets?contentType=RESOURCE&pageSize=1000&${types}`,
      'assets',
    );
    for (const a of assets) {
      const r = assetToResource(a, opts.regions);
      if (r) emit(r);
    }
  };

  const total = services.length;
  opts.onProgress?.({ type: 'start', total, regions: opts.regions });
  const limit = pLimit(Math.max(1, opts.concurrency ?? 4));
  let done = 0;
  await Promise.all(
    services.map((service) =>
      limit(async () => {
        const before = errors.length;
        const found: Resource[] = [];
        try {
          await collect(service, (r) => found.push(r));
        } catch (err) {
          fail(service)(err, 'cloudasset.assets.listResource');
        }
        resources.push(...found);
        done++;
        opts.onProgress?.({
          type: 'progress',
          service,
          region: 'global',
          found: found.length,
          errors: errors.length - before,
          done,
          total,
        });
      }),
    ),
  );

  opts.onProgress?.({ type: 'done', resources: resources.length, errors: errors.length });
  return {
    schemaVersion: 1,
    meta: {
      profileId: opts.profileId,
      provider: 'gcp',
      accountId: project.projectId,
      regions: opts.regions,
      startedAt,
      finishedAt: new Date().toISOString(),
      scannerVersion: SCANNER_VERSION,
    },
    resources,
    errors,
  };
};
