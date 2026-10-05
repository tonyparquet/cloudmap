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
  /** Portée ARM en minuscules (Resource Graph varie la casse selon la table) → conteneur ou nœud. */
  const target = new Map<string, string>();
  const key = (name: string) => name.toLowerCase();
  const chain = (r: Resource) =>
    ((props(r).managementGroupAncestorsChain ?? []) as { name?: string; displayName?: string }[]).flatMap(
      (x) => (x.name ? [{ name: x.name, label: x.displayName || x.name }] : []),
    );

  // Groupes d'administration lus, complétés par la chaîne d'ancêtres des abonnements (lisible même
  // sans droit sur les groupes ; parent direct en tête, racine du locataire en dernier).
  const groups = new Map<string, { label: string; parent?: string }>();
  for (const m of mgs) {
    const name = str(raw(m).name) ?? m.id;
    const parent =
      str(((props(m).details as Props | undefined)?.parent as Props | undefined)?.name) ?? chain(m)[0]?.name;
    groups.set(key(name), {
      label: str(props(m).displayName) || name,
      ...(parent ? { parent: key(parent) } : {}),
    });
  }
  const readable = new Set(groups.keys());
  for (const s of subs)
    chain(s).forEach((a, i, all) => {
      const parent = all[i + 1]?.name;
      if (!groups.has(key(a.name)))
        groups.set(key(a.name), { label: a.label, ...(parent ? { parent: key(parent) } : {}) });
    });

  // Parents avant enfants.
  const depth = (k: string, seen = new Set<string>()): number => {
    const p = groups.get(k)?.parent;
    return p && groups.has(p) && !seen.has(p) ? 1 + depth(p, seen.add(k)) : 0;
  };
  const sorted = [...groups].sort(([a], [b]) => depth(a) - depth(b));
  const top = sorted[0];
  let orgId = top && !groups.has(top[1].parent ?? '') ? `mg:${top[0]}` : undefined;
  if (!orgId) {
    orgId = 'org:locataire';
    containers.push({ id: orgId, kind: 'org', label: 'Locataire Azure' });
  }
  for (const [k, g] of sorted) {
    const id = `mg:${k}`;
    containers.push(
      id === orgId
        ? { id, kind: 'org', label: `Locataire · ${g.label}` }
        : {
            id,
            kind: 'ou',
            label: g.label,
            parentId: g.parent && groups.has(g.parent) ? `mg:${g.parent}` : orgId,
          },
    );
    target.set(`/providers/microsoft.management/managementgroups/${k}`, id);
  }

  const subscriptionId = (r: Resource) => r.id.split('/')[2] ?? r.id;
  for (const s of subs) {
    const guid = subscriptionId(s);
    const ancestors = chain(s).map((a) => a.name);
    if (ancestors.some((a) => !readable.has(key(a))))
      warnings.push(
        `Abonnement ${guid} : groupes d'administration non lisibles avec ces droits, hiérarchie limitée ` +
          "aux ancêtres de l'abonnement (lecture au niveau du groupe d'administration requise pour la vue complète).",
      );
    const parent = ancestors[0];
    const state = str(props(s).state);
    const id = `sub:${guid}`;
    target.set(key(s.id), id);
    nodes.push({
      id,
      resourceRef: s.id,
      type: SUB,
      label: str(raw(s).name) ?? guid,
      sublabel: guid === snapshot.meta.accountId ? `${guid} · analysé` : guid,
      icon: 'account',
      category: 'management',
      status: subscriptionStatus(state),
      containerId: parent ? `mg:${key(parent)}` : orgId,
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
    const exact = target.get(key(scope));
    if (exact) return { to: exact };
    const m = /^(\/subscriptions\/[^/]+)\/resourcegroups\/([^/]+)/i.exec(scope);
    const sub = m?.[1] ? target.get(key(m[1])) : undefined;
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
    const name = str(pp.displayName) || str(raw(p).name) || p.id;
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
