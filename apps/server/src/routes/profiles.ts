import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cloudIdSchema,
  cloudRegionSchema,
  externalIdSchema,
  profileSchema,
  providerIdProblems,
  rawSnapshotSchema,
  roleArnSchema,
  type Profile,
} from '@cloudmap/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.ts';
import type { Db } from '../db/index.ts';
import type { Storage } from '../storage.ts';
import { badRequest, forbidden, notFound, parse } from '../errors.ts';
import {
  canEdit,
  canView,
  isDemoProfile,
  requireElevated,
  requireRole,
  requireUser,
  type AuthUser,
} from '../http.ts';

export function getProfile(db: Db, id: string): Profile | undefined {
  const row = db.prepare('SELECT data FROM profiles WHERE id = ?').get(id) as { data: string } | undefined;
  return row ? profileSchema.parse(JSON.parse(row.data)) : undefined;
}

export function saveProfile(db: Db, profile: Profile): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO profiles (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).run(profile.id, JSON.stringify(profile), now, now);
}

export function listProfiles(db: Db): Profile[] {
  return (db.prepare('SELECT data FROM profiles ORDER BY created_at').all() as { data: string }[]).map((r) =>
    profileSchema.parse(JSON.parse(r.data)),
  );
}

/** Profil visible par l'utilisateur, sinon 404 (l'existence d'un profil d'un autre groupe n'est pas révélée). */
export function visibleProfile(
  ctx: Ctx,
  req: FastifyRequest,
  id: string,
): { profile: Profile; user: AuthUser } {
  const user = requireUser(req);
  const profile = /^[\w-]{1,64}$/.test(id) ? getProfile(ctx.db, id) : undefined;
  if (!profile || !canView(user, profile, ctx.config.demoMode)) throw notFound('Profil introuvable');
  return { profile, user };
}

export function editableProfile(
  ctx: Ctx,
  req: FastifyRequest,
  id: string,
): { profile: Profile; user: AuthUser } {
  const r = visibleProfile(ctx, req, id);
  if (!canEdit(r.user, r.profile)) throw forbidden('Droits insuffisants sur ce profil');
  return r;
}

const newExternalId = () => randomBytes(24).toString('base64url');

/** Entrée de l'interface : l'id, le credentialRef et l'External ID par défaut sont générés côté serveur. */
const profileInputSchema = profileSchema.omit({ id: true, auth: true }).extend({
  auth: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('assume-role-hub'),
      roleArn: profileSchema.shape.auth.options[0].shape.roleArn,
      externalId: profileSchema.shape.auth.options[0].shape.externalId.optional(),
    }),
    z.strictObject({ kind: z.literal('access-keys') }),
    z.strictObject({ kind: z.literal('import-only') }),
    z.strictObject({
      kind: z.literal('assume-role-profile'),
      parentProfileId: z.string().regex(/^[\w-]{1,64}$/),
      roleArn: roleArnSchema.optional(),
      externalId: externalIdSchema.optional(),
    }),
  ]),
});

/** Règles propres au fournisseur : identifiants de compte et régions, modes d'accès disponibles. */
function checkProvider(input: z.infer<typeof profileInputSchema>): void {
  const provider = input.provider ?? 'aws';
  const problems = providerIdProblems({ provider, accountId: input.accountId, regions: input.regions });
  if (input.auth.kind === 'assume-role-hub' && provider !== 'aws')
    problems.push("Le rôle assumé par l'outil n'existe que pour AWS");
  if (input.auth.kind === 'assume-role-profile' && provider === 'aws' && !input.auth.roleArn)
    problems.push('ARN du rôle du compte membre requis');
  if (problems.length) throw badRequest(problems.join(' ; '), 'VALIDATION');
}

// AWS : rôle à assumer (nom + External ID). Azure / Google Cloud : mêmes identifiants que le hub.
const orgAccountsSchema = z.strictObject({
  accountIds: z.array(cloudIdSchema).min(1).max(500),
  roleName: z
    .string()
    .regex(/^[\w+=,.@-]{1,64}$/, 'Nom de rôle IAM invalide')
    .optional(),
  externalId: externalIdSchema.optional(),
  regions: z.array(cloudRegionSchema).min(1).max(40),
  allowedGroups: profileSchema.shape.allowedGroups,
});

/** Profils pouvant servir de hub : ils portent eux-mêmes des identifiants (pas de chaîne de hubs). */
export const canBeHub = (p: Profile) => p.auth.kind === 'access-keys' || p.auth.kind === 'assume-role-hub';

export function registerProfileRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, audit } = ctx;

  const checkGroups = (user: AuthUser, groups: string[]) => {
    if (user.role === 'admin') return;
    if (groups.length === 0 || groups.some((g) => !user.groups.includes(g))) {
      throw forbidden('Les groupes autorisés doivent faire partie de vos groupes');
    }
  };

  /** Hub d'un profil « via un autre profil » : modifiable par l'utilisateur et porteur d'identifiants. */
  const checkParent = (req: FastifyRequest, parentId: string, provider: string, selfId?: string) => {
    const { profile: parent } = editableProfile(ctx, req, parentId);
    if (parent.id === selfId || !canBeHub(parent) || (parent.provider ?? 'aws') !== provider)
      throw badRequest(
        'Ce profil ne peut pas servir de hub : il doit porter ses propres identifiants',
        'HUB_INVALIDE',
      );
    return parent;
  };

  const withAuth = (input: z.infer<typeof profileInputSchema>, previous?: Profile): Profile['auth'] => {
    if (input.auth.kind === 'assume-role-profile') {
      // Azure / Google Cloud : pas de rôle à assumer, donc pas d'External ID.
      if ((input.provider ?? 'aws') !== 'aws')
        return { kind: 'assume-role-profile', parentProfileId: input.auth.parentProfileId };
      const prevExt = previous?.auth.kind === 'assume-role-profile' ? previous.auth.externalId : undefined;
      return { ...input.auth, externalId: input.auth.externalId ?? prevExt ?? newExternalId() };
    }
    if (input.auth.kind === 'assume-role-hub') {
      const prevExt = previous?.auth.kind === 'assume-role-hub' ? previous.auth.externalId : undefined;
      return {
        kind: 'assume-role-hub',
        roleArn: input.auth.roleArn,
        externalId: input.auth.externalId ?? prevExt ?? newExternalId(),
      };
    }
    if (input.auth.kind === 'access-keys') {
      if (previous?.auth.kind === 'access-keys') return previous.auth;
      return { kind: 'access-keys', credentialRef: randomUUID() };
    }
    return { kind: 'import-only' };
  };

  app.get('/api/profiles', async (req) => {
    const user = requireUser(req);
    return {
      profiles: listProfiles(db)
        .filter((p) => canView(user, p, ctx.config.demoMode))
        .map((p) => {
          const last = ctx.storage.listSnapshots(p.id)[0];
          return {
            ...p,
            canEdit: canEdit(user, p),
            lastSnapshot: last
              ? {
                  id: last.id,
                  createdAt: last.created_at,
                  resourceCount: last.resource_count,
                  errorCount: last.error_count,
                }
              : null,
          };
        }),
    };
  });

  app.get<{ Params: { id: string } }>('/api/profiles/:id', async (req) => {
    const { profile, user } = visibleProfile(ctx, req, req.params.id);
    return { profile: { ...profile, canEdit: canEdit(user, profile) } };
  });

  app.post('/api/profiles', async (req) => {
    const user = requireRole(req, 'admin', 'editor');
    const input = parse(profileInputSchema, req.body);
    checkProvider(input);
    checkGroups(user, input.allowedGroups);
    if (input.auth.kind === 'assume-role-profile')
      checkParent(req, input.auth.parentProfileId, input.provider ?? 'aws');
    const profile = profileSchema.parse({ ...input, id: randomUUID(), auth: withAuth(input) });
    saveProfile(db, profile);
    audit.log({
      user: user.username,
      ip: req.ip,
      action: 'profil.creation',
      profileId: profile.id,
      result: 'succes',
    });
    return { profile };
  });

  app.put<{ Params: { id: string } }>('/api/profiles/:id', async (req) => {
    const { profile: previous, user } = editableProfile(ctx, req, req.params.id);
    if (isDemoProfile(previous.id) && ctx.config.demoMode)
      throw forbidden('Les profils de démonstration sont en lecture seule');
    const input = parse(profileInputSchema, req.body);
    checkProvider(input);
    checkGroups(user, input.allowedGroups);
    if (input.auth.kind === 'assume-role-profile')
      checkParent(req, input.auth.parentProfileId, input.provider ?? 'aws', previous.id);
    if (input.accountId !== previous.accountId) {
      // Changer de compte invalide les identifiants mémorisés pour l'ancien compte.
      ctx.vault.wipeProfile(previous.id);
    }
    const profile = profileSchema.parse({ ...input, id: previous.id, auth: withAuth(input, previous) });
    saveProfile(db, profile);
    audit.log({
      user: user.username,
      ip: req.ip,
      action: 'profil.modification',
      profileId: profile.id,
      result: 'succes',
    });
    return { profile };
  });

  // ------------------------------------------------------------------ comptes de l'organisation

  /** Comptes de l'organisation vus dans le dernier snapshot du hub, avec les profils qui les couvrent déjà. */
  app.get<{ Params: { id: string } }>('/api/profiles/:id/org-accounts', async (req) => {
    const { profile, user } = visibleProfile(ctx, req, req.params.id);
    const visible = listProfiles(db).filter((p) => canView(user, p, ctx.config.demoMode));
    const row = ctx.storage.listSnapshots(profile.id)[0];
    const root = row
      ? ctx.storage.loadSnapshot(row).resources.find((r) => r.type === 'AWS::Organizations::Root')
      : undefined;
    return {
      hubAccountId: profile.accountId,
      ...(root ? { rootId: root.id } : {}),
      canCreate: user.role !== 'viewer' && canEdit(user, profile) && canBeHub(profile),
      accounts: orgAccounts(profile).map((a) => ({
        ...a,
        profiles: visible.filter((p) => p.accountId === a.id).map((p) => ({ id: p.id, name: p.name })),
      })),
    };
  });

  /** Un profil par compte membre choisi : rôle `roleName` assumé avec les identifiants du hub. */
  app.post<{ Params: { id: string } }>('/api/profiles/:id/org-accounts', async (req) => {
    const user = requireRole(req, 'admin', 'editor');
    const provider = visibleProfile(ctx, req, req.params.id).profile.provider ?? 'aws';
    const parent = checkParent(req, req.params.id, provider);
    const input = parse(orgAccountsSchema, req.body);
    checkGroups(user, input.allowedGroups);
    const problems = input.accountIds.flatMap((accountId) =>
      providerIdProblems({ provider, accountId, regions: input.regions }),
    );
    if (provider === 'aws' && (!input.roleName || !input.externalId))
      problems.push('Nom du rôle et External ID requis pour AWS');
    if (problems.length) throw badRequest([...new Set(problems)].join(' ; '), 'VALIDATION');
    const known = new Map(orgAccounts(parent).map((a) => [a.id, a]));
    const covered = new Set(
      listProfiles(db)
        .filter((p) => p.auth.kind === 'assume-role-profile' && p.auth.parentProfileId === parent.id)
        .map((p) => p.accountId),
    );
    const created: Profile[] = [];
    for (const accountId of new Set(input.accountIds)) {
      if (accountId === parent.accountId || covered.has(accountId)) continue;
      const account = known.get(accountId);
      const profile = profileSchema.parse({
        id: randomUUID(),
        name: account?.name ?? accountId,
        ...(parent.client ? { client: parent.client } : {}),
        ...(provider !== 'aws' ? { provider } : {}),
        accountId,
        regions: input.regions,
        auth:
          provider === 'aws'
            ? {
                kind: 'assume-role-profile',
                parentProfileId: parent.id,
                roleArn: `arn:${account?.partition ?? 'aws'}:iam::${accountId}:role/${input.roleName ?? ''}`,
                externalId: input.externalId,
              }
            : { kind: 'assume-role-profile', parentProfileId: parent.id },
        allowedGroups: input.allowedGroups,
      });
      saveProfile(db, profile);
      audit.log({
        user: user.username,
        ip: req.ip,
        action: 'profil.creation',
        profileId: profile.id,
        result: 'succes',
        details: { hub: parent.id },
      });
      created.push(profile);
    }
    return { created: created.map((p) => ({ id: p.id, name: p.name, accountId: p.accountId })) };
  });

  /**
   * Comptes membres vus dans le dernier snapshot du hub : comptes AWS Organizations, abonnements Azure,
   * projets Google Cloud (types d'actifs des collecteurs de chaque fournisseur).
   */
  const orgAccounts = (profile: Profile) => {
    const row = ctx.storage.listSnapshots(profile.id)[0];
    const resources = row ? ctx.storage.loadSnapshot(row).resources : [];
    const pick = (raw: Record<string, unknown>, ...keys: string[]) =>
      keys.map((k) => raw[k]).find((v): v is string => typeof v === 'string' && v !== '');
    return resources.flatMap((r) => {
      const raw = (r.raw ?? {}) as Record<string, unknown>;
      const type = r.type.toLowerCase();
      if (r.type === 'AWS::Organizations::Account')
        return [
          {
            id: pick(raw, 'Id') ?? r.id,
            name: pick(raw, 'Name') ?? r.id,
            status: pick(raw, 'State', 'Status') ?? 'inconnu',
            partition: /^arn:(aws[a-z-]*):/.exec(pick(raw, 'Arn') ?? r.arn ?? '')?.[1] ?? 'aws',
          },
        ];
      if (type === 'microsoft.resources/subscriptions') {
        const id = pick(raw, 'subscriptionId') ?? r.id.split('/').pop() ?? r.id;
        return [
          {
            id,
            name: pick(raw, 'displayName', 'name') ?? id,
            status: pick(raw, 'state') ?? 'inconnu',
            partition: 'azure',
          },
        ];
      }
      if (type === 'cloudresourcemanager.googleapis.com/project') {
        const id = pick(raw, 'projectId') ?? r.id.split('/').pop() ?? r.id;
        return [
          {
            id,
            name: pick(raw, 'displayName', 'name') ?? id,
            status: pick(raw, 'state', 'lifecycleState') ?? 'inconnu',
            partition: 'gcp',
          },
        ];
      }
      return [];
    });
  };

  app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (req) => {
    const { profile, user } = editableProfile(ctx, req, req.params.id);
    requireElevated(req, ctx.config.app.session.reauthMinutes);
    if (ctx.scans.isRunning(profile.id)) throw badRequest('Un scan est en cours sur ce profil');
    ctx.vault.wipeProfile(profile.id);
    db.prepare('DELETE FROM profiles WHERE id = ?').run(profile.id);
    ctx.storage.deleteProfileFiles(profile.id);
    audit.log({
      user: user.username,
      ip: req.ip,
      action: 'profil.suppression',
      profileId: profile.id,
      result: 'succes',
    });
    return { ok: true };
  });
}

/** Mode démo : profils fictifs chargés depuis fixtures/ (AWS « Démo » et « Partenaire », Azure). */
export function seedDemo(w: { db: Db; storage: Storage }, appRoot: string): void {
  const dir = join(appRoot, 'fixtures');
  const json = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  for (const prefix of ['demo', 'demo-partenaire', 'demo-azure', 'demo-gcp']) {
    const profile = profileSchema.parse(json(`${prefix}-profile.json`));
    saveProfile(w.db, profile);
    // Nouveau snapshot si la fixture a changé depuis le dernier démarrage (mise à jour de l'application).
    const snapshot = rawSnapshotSchema.parse(json(`${prefix}-snapshot.json`));
    const latest = w.storage.listSnapshots(profile.id).find((r) => r.source === 'demo');
    if (!latest || JSON.stringify(w.storage.loadSnapshot(latest)) !== JSON.stringify(snapshot)) {
      w.storage.saveSnapshot(profile.id, snapshot, 'demo');
    }
  }
}
