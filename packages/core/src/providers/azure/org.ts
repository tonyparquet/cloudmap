import type {
  Graph,
  GraphContainer,
  GraphEdge,
  GraphNode,
  NodeStatus,
  RawSnapshot,
  Resource,
} from '../../schemas.ts';

/**
 * Vue « Organisation » Azure (fonction pure) : locataire > groupes d'administration imbriqués >
 * abonnements, affectations Azure Policy reliées à leur portée, principaux (groupes, utilisateurs,
 * principaux de service) reliés aux abonnements avec le rôle en étiquette. Mêmes conventions que la
 * vue AWS (conteneurs `org` / `ou`, catégorie `management`).
 */

type Props = Record<string, unknown>;
const raw = (r: Resource) => (r.raw ?? {}) as Props;
const props = (r: Resource) => (raw(r).properties ?? {}) as Props;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

const MG = 'microsoft.management/managementgroups';
const SUB = 'microsoft.resources/subscriptions';

function subscriptionStatus(state: string | undefined): NodeStatus {
  if (state === 'Enabled') return 'actif';
  if (state === 'Disabled' || state === 'Deleted') return 'arrete';
  if (state === 'Warned' || state === 'PastDue') return 'en-veille';
  return 'inconnu';
}

const PRINCIPAL: Record<string, [string, string]> = {
  Group: ['Groupe', 'group'],
  User: ['Utilisateur', 'user'],
  ServicePrincipal: ['Principal de service', 'user'],
};

export function buildAzureOrgGraph(snapshot: RawSnapshot): Graph | null {
  const of = (type: string) => snapshot.resources.filter((r) => r.type === type);
  const mgs = of(MG);
  const subs = of(SUB);
  if (mgs.length === 0 && subs.length === 0) return null;

  const containers: GraphContainer[] = [];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const warnings: string[] = [];
  /** Portée ARM (minuscules) → conteneur ou nœud du graphe. */
  const target = new Map<string, string>();
  const chain = (r: Resource) =>
    ((props(r).managementGroupAncestorsChain ?? []) as { name?: string }[]).map((x) => x.name ?? '');

  // Groupes d'administration, parents avant enfants.
  const byName = new Map(mgs.map((m) => [str(raw(m).name) ?? m.id, m]));
  const parentOf = (m: Resource) =>
    str(((props(m).details as Props | undefined)?.parent as Props | undefined)?.name) ?? chain(m)[0];
  const depth = (m: Resource, seen = new Set<Resource>()): number => {
    const p = byName.get(parentOf(m) ?? '');
    return p && !seen.has(p) ? 1 + depth(p, seen.add(m)) : 0;
  };
  const sorted = [...mgs].sort((a, b) => depth(a) - depth(b));
  let orgId =
    sorted[0] && !byName.has(parentOf(sorted[0]) ?? '') ? `mg:${str(raw(sorted[0]).name)}` : undefined;
  if (!orgId) {
    orgId = 'org:locataire';
    containers.push({ id: orgId, kind: 'org', label: 'Locataire Azure' });
  }
  for (const m of sorted) {
    const name = str(raw(m).name) ?? m.id;
    const id = `mg:${name}`;
    const parent = byName.has(parentOf(m) ?? '') ? `mg:${parentOf(m)}` : undefined;
    const label = str(props(m).displayName) ?? name;
    containers.push(
      id === orgId
        ? { id, kind: 'org', label: `Locataire · ${label}` }
        : { id, kind: 'ou', label, parentId: parent ?? orgId },
    );
    target.set(m.id, id);
  }

  const known = new Set(byName.keys());
  const subscriptionId = (r: Resource) => r.id.split('/')[2] ?? r.id;
  for (const s of subs) {
    const guid = subscriptionId(s);
    const ancestors = chain(s);
    if (ancestors.some((a) => a && !known.has(a)))
      warnings.push(
        `Abonnement ${guid} : groupes d'administration non lisibles avec ces droits (lecture au niveau ` +
          "du groupe d'administration requise pour la hiérarchie complète).",
      );
    const parent = ancestors.find((a) => known.has(a));
    const state = str(props(s).state);
    const id = `sub:${guid}`;
    target.set(s.id, id);
    nodes.push({
      id,
      resourceRef: s.id,
      type: SUB,
      label: str(raw(s).name) ?? guid,
      sublabel: guid === snapshot.meta.accountId ? `${guid} · analysé` : guid,
      icon: 'account',
      category: 'management',
      status: subscriptionStatus(state),
      containerId: parent ? `mg:${parent}` : orgId,
      details: {
        typeLabel: 'Abonnement Azure',
        resourceId: guid,
        arn: s.id,
        statusSource: state ? `Azure : ${state}` : 'état inconnu',
        groupesAdministration: ancestors,
        politiquesDirectes: [] as string[],
        acces: [] as string[],
      },
    });
  }

  /** Portée → nœud ou conteneur (une portée de groupe de ressources désigne son abonnement). */
  const scopeTarget = (scope: string | undefined): { to: string; rg?: string } | undefined => {
    if (!scope) return undefined;
    const exact = target.get(scope);
    if (exact) return { to: exact };
    const m = /^(\/subscriptions\/[^/]+)\/resourcegroups\/([^/]+)/.exec(scope);
    const sub = m?.[1] ? target.get(m[1]) : undefined;
    return sub ? { to: sub, ...(m?.[2] ? { rg: m[2] } : {}) } : undefined;
  };
  const detail = (to: string, key: 'politiquesDirectes' | 'acces', text: string) => {
    const n = nodes.find((x) => x.id === to);
    if (n) (n.details[key] as string[]).push(text);
  };

  let n = 0;
  const edge = (source: string, to: string, label: string, evidence: string[], labelOnFocus = false) =>
    edges.push({
      id: `org-e${n++}`,
      source,
      target: to,
      kind: 'dependency',
      label,
      state: 'autorise',
      evidence,
      ...(labelOnFocus ? { labelOnFocus } : {}),
    });

  for (const p of of('microsoft.authorization/policyassignments')) {
    const pp = props(p);
    const name = str(pp.displayName) ?? str(raw(p).name) ?? p.id;
    const initiative = (str(pp.policyDefinitionId) ?? '').includes('/policysetdefinitions/');
    const kind = initiative ? 'Initiative' : 'Stratégie';
    const where = scopeTarget(str(pp.scope));
    const id = `pol:${p.id}`;
    nodes.push({
      id,
      resourceRef: p.id,
      type: p.type,
      label: name,
      sublabel: kind,
      icon: 'policy',
      category: 'security',
      status: where ? (pp.enforcementMode === 'DoNotEnforce' ? 'en-veille' : 'actif') : 'inconnu',
      details: {
        typeLabel: `Affectation Azure Policy (${kind.toLowerCase()})`,
        resourceId: p.id,
        statusSource: pp.enforcementMode === 'DoNotEnforce' ? 'mode audit (non appliquée)' : 'appliquée',
        portee: str(pp.scope),
        definition: str(pp.policyDefinitionId),
        description: str(pp.description),
      },
    });
    if (!where) continue;
    const label = where.rg ? `${kind} (${where.rg})` : kind;
    edge(id, where.to, label, [`${name} affectée à ${str(pp.scope)}`]);
    detail(where.to, 'politiquesDirectes', where.rg ? `${name} (groupe de ressources ${where.rg})` : name);
  }

  // Attributions de rôle fusionnées par paire principal / cible.
  const pairs = new Map<string, { source: string; to: string; roles: string[] }>();
  for (const a of of('microsoft.authorization/roleassignments')) {
    const ap = props(a);
    const principal = str(ap.principalId);
    const where = scopeTarget(str(ap.scope));
    if (!principal || !where) continue;
    const [kindLabel, icon] = PRINCIPAL[str(ap.principalType) ?? ''] ?? ['Principal', 'user'];
    const source = `prn:${principal}`;
    if (!nodes.some((x) => x.id === source))
      nodes.push({
        id: source,
        resourceRef: principal,
        type: 'microsoft.authorization/principal',
        // Noms des groupes et utilisateurs : Microsoft Graph, hors du périmètre en lecture seule ARM.
        label: `${kindLabel} ${principal.slice(0, 8)}`,
        sublabel: kindLabel,
        icon,
        category: 'external',
        status: 'actif',
        details: { typeLabel: kindLabel, resourceId: principal, statusSource: 'attribution de rôle Azure' },
      });
    const role = (str(raw(a).roleName) ?? 'rôle') + (where.rg ? ` (${where.rg})` : '');
    const key = `${source}>${where.to}`;
    const pair = pairs.get(key) ?? { source, to: where.to, roles: [] };
    if (!pair.roles.includes(role)) pair.roles.push(role);
    pairs.set(key, pair);
  }
  for (const p of pairs.values()) {
    edge(
      p.source,
      p.to,
      p.roles.join(', '),
      p.roles.map((r) => `rôle ${r}`),
      true,
    );
    const who = nodes.find((x) => x.id === p.source)?.label ?? p.source;
    detail(p.to, 'acces', `${who} : ${p.roles.join(', ')}`);
  }

  return { containers, nodes, edges, warnings };
}
