import type {
  Graph,
  GraphContainer,
  GraphEdge,
  GraphNode,
  NodeStatus,
  RawSnapshot,
  Resource,
} from './schemas.ts';

/**
 * Vue « Organisation » (fonction pure) : organisation > OU imbriquées > comptes, politiques
 * (SCP, RCP, tags…) reliées à leurs cibles, groupes et utilisateurs Identity Center reliés aux
 * comptes avec les permission sets en étiquette. `null` sans données Organizations ni Identity Center.
 */

const SHORT: Record<string, string> = {
  SERVICE_CONTROL_POLICY: 'SCP',
  RESOURCE_CONTROL_POLICY: 'RCP',
  TAG_POLICY: 'Tags',
  BACKUP_POLICY: 'Backup',
  AISERVICES_OPT_OUT_POLICY: 'IA opt-out',
  CHATBOT_POLICY: 'Chatbot',
  DECLARATIVE_POLICY_EC2: 'Déclarative EC2',
};

type Raw = Record<string, unknown>;
const raw = (r: Resource) => (r.raw ?? {}) as Raw;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function accountStatus(state: string | undefined): NodeStatus {
  if (state === 'ACTIVE') return 'actif';
  if (state === 'SUSPENDED' || state === 'CLOSED') return 'arrete';
  if (state?.startsWith('PENDING')) return 'en-veille';
  return 'inconnu';
}

export function buildOrgGraph(snapshot: RawSnapshot): Graph | null {
  const of = (type: string) => snapshot.resources.filter((r) => r.type === type);
  const orgRes = of('AWS::Organizations::Organization')[0];
  const instances = of('AWS::SSO::Instance');
  if (!orgRes && instances.length === 0) return null;

  const containers: GraphContainer[] = [];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const warnings: string[] = [];
  /** Identifiant AWS (racine, OU, compte) → identifiant du conteneur ou nœud du graphe. */
  const target = new Map<string, string>();
  const parentOf = new Map<string, string>();
  const names = new Map<string, string>();

  const org = orgRes ? raw(orgRes) : undefined;
  const mgmt = str(org?.MasterAccountId);
  let orgContainer: string | undefined;
  if (orgRes) {
    orgContainer = `org:${orgRes.id}`;
    containers.push({
      id: orgContainer,
      kind: 'org',
      label: `Organisation ${orgRes.id}`,
      ...(mgmt ? { sublabel: `Compte de gestion ${mgmt}` } : {}),
    });
    for (const root of of('AWS::Organizations::Root')) {
      target.set(root.id, orgContainer);
      names.set(root.id, 'Racine');
    }
    if (org?._scope === 'membre') {
      warnings.push(
        `Ce compte est membre de l'organisation ${orgRes.id} : la structure (OU, comptes, politiques) ` +
          "n'est lisible que depuis le compte de gestion ou un administrateur délégué.",
      );
    }
  }

  // OU, dans l'ordre du parcours (un parent est toujours émis avant ses enfants).
  for (const ou of of('AWS::Organizations::OrganizationalUnit')) {
    const r = raw(ou);
    const parent = target.get(str(r._parentId) ?? '') ?? orgContainer;
    const id = `ou:${ou.id}`;
    target.set(ou.id, id);
    if (r._parentId) parentOf.set(ou.id, String(r._parentId));
    names.set(ou.id, str(r.Name) ?? ou.id);
    containers.push({ id, kind: 'ou', label: str(r.Name) ?? ou.id, ...(parent ? { parentId: parent } : {}) });
  }

  // Politiques attachées par cible (identifiant AWS).
  const policies = of('AWS::Organizations::Policy');
  const attached = new Map<string, string[]>();
  for (const p of policies) {
    const r = raw(p);
    for (const t of (r._targets ?? []) as Raw[]) {
      const id = str(t.TargetId);
      if (id)
        attached.set(id, [
          ...(attached.get(id) ?? []),
          `${str(r.Name) ?? p.id} (${SHORT[str(r.Type) ?? ''] ?? r.Type})`,
        ]);
    }
  }
  const inherited = (awsId: string): string[] => {
    const out: string[] = [];
    for (let p = parentOf.get(awsId); p; p = parentOf.get(p)) out.push(...(attached.get(p) ?? []));
    return out;
  };
  for (const c of containers) {
    if (c.kind !== 'ou') continue;
    const own = (attached.get(c.id.slice(3)) ?? []).filter((n) => !n.startsWith('FullAWSAccess'));
    if (own.length) c.sublabel = own.join(', ');
  }

  const accountNode = (id: string, r: Raw | undefined, containerId: string | undefined): string => {
    const nodeId = `acct:${id}`;
    if (target.has(id)) return target.get(id) as string;
    target.set(id, nodeId);
    const state = str(r?.State) ?? str(r?.Status);
    nodes.push({
      id: nodeId,
      resourceRef: id,
      type: 'AWS::Organizations::Account',
      label: str(r?.Name) ?? id,
      sublabel: id === mgmt ? `${id} · gestion` : id,
      icon: 'account',
      category: 'management',
      status: accountStatus(state),
      ...(containerId ? { containerId } : {}),
      details: {
        typeLabel: 'Compte AWS',
        resourceId: id,
        arn: str(r?.Arn),
        statusSource: state ? `Organizations : ${state}` : 'compte vu uniquement dans Identity Center',
        email: str(r?.Email),
        adhesion: str(r?.JoinedTimestamp),
        politiquesDirectes: attached.get(id) ?? [],
        politiquesHeritees: r ? inherited(id) : [],
        servicesDelegues: (r?._delegatedServices ?? []) as string[],
      },
    });
    return nodeId;
  };

  for (const a of of('AWS::Organizations::Account')) {
    const r = raw(a);
    if (r._parentId) parentOf.set(a.id, String(r._parentId));
    accountNode(a.id, r, target.get(str(r._parentId) ?? '') ?? orgContainer);
  }
  // Compte membre : seul le compte scanné est connu.
  if (org?._scope === 'membre') accountNode(snapshot.meta.accountId, undefined, orgContainer);

  let n = 0;
  const edge = (source: string, targetId: string, label: string, evidence: string[], labelOnFocus = false) =>
    edges.push({
      id: `org-e${n++}`,
      source,
      target: targetId,
      kind: 'dependency',
      label,
      state: 'autorise',
      evidence,
      ...(labelOnFocus ? { labelOnFocus } : {}),
    });

  for (const p of policies) {
    const r = raw(p);
    if (r.AwsManaged === true) continue; // FullAWSAccess & co : attachées partout, sans intérêt visuel.
    const id = `pol:${p.id}`;
    const short = SHORT[str(r.Type) ?? ''] ?? str(r.Type) ?? 'Politique';
    const targets = ((r._targets ?? []) as Raw[]).flatMap((t) => {
      const to = target.get(str(t.TargetId) ?? '');
      return to ? [{ to, name: str(t.Name) ?? names.get(str(t.TargetId) ?? '') ?? '' }] : [];
    });
    nodes.push({
      id,
      resourceRef: p.id,
      type: 'AWS::Organizations::Policy',
      label: str(r.Name) ?? p.id,
      sublabel: short,
      icon: 'policy',
      category: 'security',
      status: targets.length ? 'actif' : 'en-veille',
      details: {
        typeLabel: `Politique ${short}`,
        resourceId: p.id,
        arn: p.arn,
        statusSource: targets.length ? 'attachée' : 'attachée à aucune cible',
        description: str(r.Description),
        contenu: str(r.Content),
      },
    });
    for (const t of targets) edge(id, t.to, short, [`${str(r.Name) ?? p.id} attachée à ${t.name}`]);
  }

  // Identity Center : affectations fusionnées par paire principal / compte.
  const principals = new Map<string, string>();
  for (const g of of('AWS::IdentityStore::Group')) {
    const r = raw(g);
    const id = `grp:${g.id}`;
    principals.set(`GROUP|${g.id}`, id);
    const count = typeof r._memberCount === 'number' ? r._memberCount : undefined;
    nodes.push({
      id,
      resourceRef: g.id,
      type: g.type,
      label: str(r.DisplayName) ?? g.id,
      ...(count !== undefined ? { sublabel: `${count} membre${count > 1 ? 's' : ''}` } : {}),
      icon: 'group',
      category: 'external',
      status: 'actif',
      details: {
        typeLabel: 'Groupe Identity Center',
        resourceId: g.id,
        statusSource: 'Identity Store',
        description: str(r.Description),
      },
    });
  }
  for (const u of of('AWS::IdentityStore::User')) {
    const r = raw(u);
    const id = `usr:${u.id}`;
    principals.set(`USER|${u.id}`, id);
    nodes.push({
      id,
      resourceRef: u.id,
      type: u.type,
      label: str(r.DisplayName) ?? str(r.UserName) ?? u.id,
      ...(str(r.UserName) ? { sublabel: str(r.UserName) } : {}),
      icon: 'user',
      category: 'external',
      status: 'actif',
      details: {
        typeLabel: 'Utilisateur Identity Center (affectation directe)',
        resourceId: u.id,
        statusSource: 'Identity Store',
      },
    });
  }
  const pairs = new Map<string, { source: string; target: string; sets: string[] }>();
  for (const a of of('AWS::SSO::AccountAssignment')) {
    const r = raw(a);
    const source = principals.get(`${str(r.PrincipalType)}|${str(r.PrincipalId)}`);
    const account = str(r.AccountId);
    if (!source || !account) continue;
    const to = accountNode(account, undefined, undefined);
    const key = `${source}>${to}`;
    const pair = pairs.get(key) ?? { source, target: to, sets: [] };
    const set = str(r._permissionSetName) ?? str(r.PermissionSetArn) ?? '?';
    if (!pair.sets.includes(set)) pair.sets.push(set);
    pairs.set(key, pair);
  }
  for (const p of pairs.values()) {
    // Un groupe est souvent affecté à de nombreux comptes : étiquettes visibles à la sélection.
    edge(
      p.source,
      p.target,
      p.sets.join(', '),
      p.sets.map((s) => `permission set ${s}`),
      true,
    );
    const acct = nodes.find((x) => x.id === p.target);
    const who = nodes.find((x) => x.id === p.source)?.label ?? p.source;
    if (acct)
      acct.details.acces = [...((acct.details.acces ?? []) as string[]), `${who} : ${p.sets.join(', ')}`];
  }

  return { containers, nodes, edges, warnings };
}
