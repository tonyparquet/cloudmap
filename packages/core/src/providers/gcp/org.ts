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
 * Vue « Organisation » Google Cloud (fonction pure) : organisation > dossiers imbriqués > projets,
 * contraintes de règles d'administration reliées à leurs portées, groupes et utilisateurs reliés aux
 * projets / dossiers avec leurs rôles (étiquettes visibles à la sélection). `null` sans données.
 */
export const GCP_ORG_TYPES = {
  organization: 'cloudresourcemanager.googleapis.com/Organization',
  folder: 'cloudresourcemanager.googleapis.com/Folder',
  project: 'cloudresourcemanager.googleapis.com/Project',
  policy: 'orgpolicy.googleapis.com/Policy',
  binding: 'iam.googleapis.com/Binding',
} as const;

type Raw = Record<string, unknown>;
const raw = (r: Resource) => (r.raw ?? {}) as Raw;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function projectStatus(state: string | undefined): NodeStatus {
  if (state === 'ACTIVE') return 'actif';
  if (state === 'DELETE_REQUESTED' || state === 'DELETE_IN_PROGRESS') return 'arrete';
  return 'inconnu';
}

export function buildGcpOrgGraph(snapshot: RawSnapshot): Graph | null {
  const of = (type: string) => snapshot.resources.filter((r) => r.type === type);
  const orgs = of(GCP_ORG_TYPES.organization);
  const folders = of(GCP_ORG_TYPES.folder);
  const projects = of(GCP_ORG_TYPES.project);
  if (!orgs.length && !folders.length && !projects.length) return null;

  const containers: GraphContainer[] = [];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const warnings: string[] = [];
  /** Nom Resource Manager (`organizations/1`, `folders/2`, `projects/3`) → conteneur ou nœud du graphe. */
  const target = new Map<string, string>();
  const labels = new Map<string, string>();

  for (const o of orgs) {
    const r = raw(o);
    const name = str(r.name) ?? o.id;
    const id = `org:${name}`;
    target.set(name, id);
    labels.set(name, str(r.displayName) ?? name);
    containers.push({ id, kind: 'org', label: `Organisation ${str(r.displayName) ?? name}`, sublabel: name });
    if (r._scope === 'membre')
      warnings.push(
        `Accès limité à l'organisation ${str(r.displayName) ?? name} : seuls les dossiers et projets parents ` +
          'du projet scanné sont connus (rôle de lecture sur l’organisation nécessaire pour la vue complète).',
      );
  }

  // Dossiers : parents avant enfants (profondeur croissante), quel que soit l'ordre du snapshot.
  const parentOf = new Map(folders.map((f) => [str(raw(f).name) ?? f.id, str(raw(f).parent)]));
  const depth = (name: string): number => {
    let d = 0;
    for (let p = parentOf.get(name); p && parentOf.has(p) && d < 50; p = parentOf.get(p)) d++;
    return d;
  };
  for (const f of [...folders].sort(
    (a, b) => depth(str(raw(a).name) ?? a.id) - depth(str(raw(b).name) ?? b.id),
  )) {
    const r = raw(f);
    const name = str(r.name) ?? f.id;
    const id = `ou:${name}`;
    const parent = target.get(str(r.parent) ?? '');
    target.set(name, id);
    labels.set(name, str(r.displayName) ?? name);
    containers.push({
      id,
      kind: 'ou',
      label: str(r.displayName) ?? name,
      ...(parent ? { parentId: parent } : {}),
    });
  }

  // Contraintes par portée.
  const policies = of(GCP_ORG_TYPES.policy);
  const scopeOf = (p: Resource) => (str(raw(p).name) ?? '').replace(/\/policies\/.*$/, '');
  const constraintOf = (p: Resource) => (str(raw(p).name) ?? p.id).replace(/^.*\/policies\//, '');
  const attached = new Map<string, string[]>();
  for (const p of policies) attached.set(scopeOf(p), [...(attached.get(scopeOf(p)) ?? []), constraintOf(p)]);
  for (const c of containers) {
    const own = attached.get(c.id.replace(/^(org|ou):/, ''));
    if (c.kind === 'ou' && own?.length) c.sublabel = own.join(', ');
  }

  for (const p of projects) {
    const r = raw(p);
    const name = str(r.name) ?? p.id;
    const projectId = str(r.projectId) ?? name;
    const id = `acct:${name}`;
    const state = str(r.state);
    target.set(name, id);
    labels.set(name, str(r.displayName) ?? projectId);
    const parent = target.get(str(r.parent) ?? '');
    nodes.push({
      id,
      resourceRef: name,
      type: p.type,
      label: str(r.displayName) ?? projectId,
      sublabel: projectId === snapshot.meta.accountId ? `${projectId} · scanné` : projectId,
      icon: 'account',
      category: 'management',
      status: projectStatus(state),
      ...(parent ? { containerId: parent } : {}),
      details: {
        typeLabel: 'Projet Google Cloud',
        resourceId: projectId,
        arn: p.id,
        statusSource: state ? `Resource Manager : ${state}` : 'état inconnu',
        numero: name.replace('projects/', ''),
        parent: str(r.parent),
        contraintes: attached.get(name) ?? [],
      },
    });
  }

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

  for (const p of policies) {
    const scope = scopeOf(p);
    const to = target.get(scope);
    const id = `pol:${p.id}`;
    const constraint = constraintOf(p);
    nodes.push({
      id,
      resourceRef: p.id,
      type: p.type,
      label: constraint,
      sublabel: 'Contrainte',
      icon: 'policy',
      category: 'security',
      status: to ? 'actif' : 'en-veille',
      details: {
        typeLabel: "Règle d'administration",
        resourceId: str(raw(p).name) ?? p.id,
        statusSource: to ? `définie sur ${labels.get(scope) ?? scope}` : 'portée hors du périmètre lu',
        regles: JSON.stringify(raw(p).spec ?? {}),
      },
    });
    if (to) edge(id, to, 'Contrainte', [`${constraint} définie sur ${labels.get(scope) ?? scope}`]);
  }

  // Liaisons IAM : un nœud par groupe ou utilisateur, rôles fusionnés par paire principal / portée.
  const principals = new Map<string, string>();
  const pairs = new Map<string, { source: string; to: string; scope: string; roles: string[] }>();
  for (const b of of(GCP_ORG_TYPES.binding)) {
    const r = raw(b);
    const member = str(r.member) ?? '';
    const scope = str(r.resource) ?? '';
    const to = target.get(scope);
    const [kind, ident] = member.split(':');
    if (!to || !ident || (kind !== 'group' && kind !== 'user')) continue;
    let source = principals.get(member);
    if (!source) {
      source = `${kind === 'group' ? 'grp' : 'usr'}:${ident}`;
      principals.set(member, source);
      nodes.push({
        id: source,
        resourceRef: member,
        type: b.type,
        label: ident,
        sublabel: kind === 'group' ? 'groupe' : 'utilisateur',
        icon: kind === 'group' ? 'group' : 'user',
        category: 'external',
        status: 'actif',
        details: {
          typeLabel: kind === 'group' ? 'Groupe Google' : 'Utilisateur Google',
          resourceId: ident,
          statusSource: 'liaison IAM',
        },
      });
    }
    const key = `${source}>${to}`;
    const pair = pairs.get(key) ?? { source, to, scope, roles: [] };
    const role = (str(r.role) ?? '?').replace(/^roles\//, '');
    if (!pair.roles.includes(role)) pair.roles.push(role);
    pairs.set(key, pair);
  }
  for (const p of pairs.values()) {
    edge(
      p.source,
      p.to,
      p.roles.join(', '),
      p.roles.map((x) => `rôle ${x} sur ${labels.get(p.scope) ?? p.scope}`),
      true,
    );
    const node = nodes.find((x) => x.id === p.to);
    const who = nodes.find((x) => x.id === p.source)?.label ?? p.source;
    if (node)
      node.details.acces = [...((node.details.acces ?? []) as string[]), `${who} : ${p.roles.join(', ')}`];
  }

  return { containers, nodes, edges, warnings };
}
