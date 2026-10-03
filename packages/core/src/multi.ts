import type { GraphProfile } from './graph.ts';
import type { ExternalNode, RawSnapshot, Resource } from './schemas.ts';

export interface AccountPart {
  name: string;
  snapshot: RawSnapshot;
  profile: GraphProfile;
}

/**
 * Vue multi-comptes : fusion des snapshots de plusieurs profils en un seul, chaque ressource portant
 * son compte. Le moteur de règles résout alors les références d'un compte à l'autre (ARN, ID, groupes
 * de sécurité et CIDR de VPC appairés…) sans code spécifique. Une ressource vue depuis plusieurs
 * comptes (Transit Gateway partagé, ressource globale scannée deux fois) n'est gardée qu'une fois,
 * de préférence dans le compte propriétaire indiqué par son ARN.
 */
export function mergeSnapshots(parts: AccountPart[]): {
  snapshot: RawSnapshot;
  profile: GraphProfile;
  accountLabels: Record<string, string>;
} {
  const first = parts[0];
  if (!first) throw new Error('Aucun snapshot à fusionner');
  const byArn = new Map<string, Resource>();
  const withoutArn: Resource[] = [];
  const labels = new Map<string, string[]>();
  const externals = new Map<string, ExternalNode>();
  for (const { name, snapshot, profile } of parts) {
    const account = snapshot.meta.accountId;
    labels.set(account, [...(labels.get(account) ?? []), name]);
    for (const n of profile.externalNodes ?? []) if (!externals.has(n.id)) externals.set(n.id, n);
    for (const r of snapshot.resources) {
      const tagged: Resource = { ...r, account };
      if (!r.arn) {
        withoutArn.push(tagged);
        continue;
      }
      const prev = byArn.get(r.arn);
      const owner = r.arn.split(':')[4];
      if (!prev || (owner === account && prev.account !== owner)) byArn.set(r.arn, tagged);
    }
  }
  const all = parts.map((p) => p.snapshot);
  const snapshot: RawSnapshot = {
    schemaVersion: 1,
    meta: {
      profileId: 'multi-comptes',
      accountId: first.snapshot.meta.accountId,
      regions: [...new Set(all.flatMap((s) => s.meta.regions))],
      startedAt: all.map((s) => s.meta.startedAt).sort()[0] ?? first.snapshot.meta.startedAt,
      finishedAt:
        all
          .map((s) => s.meta.finishedAt)
          .sort()
          .at(-1) ?? first.snapshot.meta.finishedAt,
      scannerVersion: first.snapshot.meta.scannerVersion,
    },
    resources: [...byArn.values(), ...withoutArn],
    metrics: all.flatMap((s) => s.metrics ?? []),
    flowObservations: all.flatMap((s) => s.flowObservations ?? []),
    probes: all.flatMap((s) => s.probes ?? []),
    errors: all.flatMap((s) => s.errors.map((e) => ({ ...e, region: `${s.meta.accountId} · ${e.region}` }))),
  };
  return {
    snapshot,
    // Filtres de tags propres à chaque profil non appliqués : la vue montre les comptes entiers.
    profile: { externalNodes: [...externals.values()], probes: parts.flatMap((p) => p.profile.probes ?? []) },
    accountLabels: Object.fromEntries([...labels].map(([a, names]) => [a, names.join(' · ')])),
  };
}
