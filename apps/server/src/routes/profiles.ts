import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { profileSchema, rawSnapshotSchema, type Profile } from '@carto/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.ts';
import type { Db } from '../db/index.ts';
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
  ]),
});

export function registerProfileRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, audit } = ctx;

  const checkGroups = (user: AuthUser, groups: string[]) => {
    if (user.role === 'admin') return;
    if (groups.length === 0 || groups.some((g) => !user.groups.includes(g))) {
      throw forbidden('Les groupes autorisés doivent faire partie de vos groupes');
    }
  };

  const withAuth = (input: z.infer<typeof profileInputSchema>, previous?: Profile): Profile['auth'] => {
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
    checkGroups(user, input.allowedGroups);
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
    checkGroups(user, input.allowedGroups);
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

/** Mode démo : profils « Démo » et « Partenaire » (comptes fictifs reliés) chargés depuis fixtures/. */
export function seedDemo(ctx: Ctx): void {
  const dir = join(ctx.config.appRoot, 'fixtures');
  const json = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  for (const prefix of ['demo', 'demo-partenaire']) {
    const profile = profileSchema.parse(json(`${prefix}-profile.json`));
    saveProfile(ctx.db, profile);
    // Nouveau snapshot si la fixture a changé depuis le dernier démarrage (mise à jour de l'application).
    const snapshot = rawSnapshotSchema.parse(json(`${prefix}-snapshot.json`));
    const latest = ctx.storage.listSnapshots(profile.id).find((r) => r.source === 'demo');
    if (!latest || JSON.stringify(ctx.storage.loadSnapshot(latest)) !== JSON.stringify(snapshot)) {
      ctx.storage.saveSnapshot(profile.id, snapshot, 'demo');
    }
  }
}
