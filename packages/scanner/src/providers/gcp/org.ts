import type { Resource } from '@carto/core';
import { isCloudDenied, type ReadOnlyHttp } from '../http.ts';
import type { GcpProject } from './auth.ts';

const CRM = 'https://cloudresourcemanager.googleapis.com/v3';
const crmId = (name: string) => `//cloudresourcemanager.googleapis.com/${name}`;
const global = (type: string, id: string, raw: Record<string, unknown>): Resource => ({
  id,
  arn: id,
  type,
  region: 'global',
  raw,
});

type Page<K extends string, T> = { nextPageToken?: string } & Partial<Record<K, T[]>>;

/** Toutes les pages d'une liste Google (`pageToken`). */
export async function allPages<K extends string, T>(http: ReadOnlyHttp, url: string, key: K): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const sep = url.includes('?') ? '&' : '?';
    const page = await http.get<Page<K, T>>(
      `${url}${token ? `${sep}pageToken=${encodeURIComponent(token)}` : ''}`,
    );
    out.push(...((page[key] as T[] | undefined) ?? []));
    token = page.nextPageToken;
  } while (token);
  return out;
}

interface CrmNode {
  name: string;
  parent?: string;
  displayName?: string;
  state?: string;
  projectId?: string;
}

/**
 * Organisation, dossiers, projets, contraintes et liaisons IAM (groupes, utilisateurs), en lecture seule.
 * Sans droit sur l'organisation, seuls les parents du projet scanné sont connus : l'organisation est
 * marquée `_scope: 'membre'` (avertissement dans la vue, pas une erreur de scan).
 */
export async function collectOrganisation(
  http: ReadOnlyHttp,
  project: GcpProject,
  emit: (r: Resource) => void,
  fail: (err: unknown, permission: string) => void,
): Promise<void> {
  const known: CrmNode[] = [{ ...project, name: project.name }];
  emit(global('cloudresourcemanager.googleapis.com/Project', crmId(project.name), { ...project }));
  let org: (CrmNode & { _scope?: string }) | undefined;

  // Parents du projet : dossiers jusqu'à l'organisation.
  for (let parent = project.parent; parent;) {
    const current: string = parent;
    try {
      const node = await http.get<CrmNode>(`${CRM}/${current}`);
      known.push(node);
      if (current.startsWith('organizations/')) {
        org = node;
        break;
      }
      emit(global('cloudresourcemanager.googleapis.com/Folder', crmId(node.name), { ...node }));
      parent = node.parent;
    } catch (err) {
      if (!isCloudDenied(err)) throw err;
      if (current.startsWith('organizations/')) org = { name: current, _scope: 'membre' };
      break;
    }
  }

  // Descendants de l'organisation (dossiers et projets), si elle est lisible.
  if (org && !org._scope) {
    const seen = new Set(known.map((k) => k.name));
    try {
      for (const queue = [org.name]; queue.length;) {
        const parent = queue.shift() as string;
        for (const f of await allPages<'folders', CrmNode>(
          http,
          `${CRM}/folders?parent=${parent}`,
          'folders',
        )) {
          queue.push(f.name);
          if (seen.has(f.name)) continue;
          seen.add(f.name);
          known.push(f);
          emit(global('cloudresourcemanager.googleapis.com/Folder', crmId(f.name), { ...f }));
        }
        for (const p of await allPages<'projects', CrmNode>(
          http,
          `${CRM}/projects?parent=${parent}`,
          'projects',
        )) {
          if (seen.has(p.name)) continue;
          seen.add(p.name);
          known.push(p);
          emit(global('cloudresourcemanager.googleapis.com/Project', crmId(p.name), { ...p }));
        }
      }
    } catch (err) {
      if (!isCloudDenied(err)) throw err;
      org._scope = 'membre';
    }
  }
  if (org) emit(global('cloudresourcemanager.googleapis.com/Organization', crmId(org.name), { ...org }));

  // Contraintes définies sur chaque nœud connu ; un refus hors du projet scanné est attendu (compte membre).
  for (const node of known) {
    try {
      const policies = await allPages<'policies', { name: string }>(
        http,
        `https://orgpolicy.googleapis.com/v2/${node.name}/policies`,
        'policies',
      );
      for (const p of policies)
        emit(global('orgpolicy.googleapis.com/Policy', `//orgpolicy.googleapis.com/${p.name}`, { ...p }));
    } catch (err) {
      if (node.name === project.name) fail(err, 'orgpolicy.policies.list');
      else if (!isCloudDenied(err)) throw err;
    }
  }

  // Liaisons IAM des groupes et utilisateurs (identifiants seulement) sur l'organisation, les dossiers, les projets.
  const scope = org && !org._scope ? org.name : project.name;
  try {
    const results = await allPages<
      'results',
      { resource?: string; policy?: { bindings?: { role?: string; members?: string[] }[] } }
    >(http, `https://cloudasset.googleapis.com/v1/${scope}:searchAllIamPolicies`, 'results');
    for (const res of results) {
      const resource = (res.resource ?? '').replace('//cloudresourcemanager.googleapis.com/', '');
      if (!/^(organizations|folders|projects)\//.test(resource)) continue;
      for (const b of res.policy?.bindings ?? [])
        for (const member of b.members ?? []) {
          if (!/^(group|user):/.test(member) || !b.role) continue;
          const id = `${crmId(resource)}#${b.role}#${member}`;
          emit({
            id,
            type: 'iam.googleapis.com/Binding',
            region: 'global',
            raw: { resource, role: b.role, member },
          });
        }
    }
  } catch (err) {
    fail(err, 'cloudasset.assets.searchAllIamPolicies');
  }
}
