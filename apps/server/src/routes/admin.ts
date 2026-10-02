import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.ts';
import { hashPassword, passwordProblem } from '../auth/passwords.ts';
import { badRequest, conflict, notFound, parse } from '../errors.ts';
import { requireElevated, requireRole } from '../http.ts';

const groupName = z
  .string()
  .trim()
  .regex(/^[\w.-]{1,64}$/, 'Nom de groupe : lettres, chiffres, . _ -');
const role = z.enum(['admin', 'editor', 'viewer']);

const createUserSchema = z.strictObject({
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[\w.@-]+$/),
  password: z.string().min(1).max(256),
  role,
  groups: z.array(groupName).max(50).default([]),
});
const updateUserSchema = z.strictObject({
  role: role.optional(),
  groups: z.array(groupName).max(50).optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(1).max(256).optional(),
  resetTotp: z.boolean().optional(),
});

export function registerAdminRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, audit, config } = ctx;
  /** Gestion des utilisateurs et groupes : administrateur + ré-authentification récente. */
  const admin = (req: Parameters<typeof requireRole>[0]) => {
    const user = requireRole(req, 'admin');
    requireElevated(req, config.app.session.reauthMinutes);
    return user;
  };
  const groupsOf = (id: string) =>
    (
      db.prepare('SELECT group_name FROM user_groups WHERE user_id = ?').all(id) as { group_name: string }[]
    ).map((g) => g.group_name);
  const setGroups = (id: string, groups: string[]) => {
    const now = new Date().toISOString();
    db.prepare('DELETE FROM user_groups WHERE user_id = ?').run(id);
    for (const g of new Set(groups)) {
      db.prepare('INSERT OR IGNORE INTO groups (name, created_at) VALUES (?, ?)').run(g, now);
      db.prepare('INSERT INTO user_groups (user_id, group_name) VALUES (?, ?)').run(id, g);
    }
  };
  const adminCount = () =>
    (
      db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as {
        n: number;
      }
    ).n;

  app.get('/api/admin/users', async (req) => {
    admin(req);
    const rows = db
      .prepare(
        'SELECT id, username, role, totp_enabled, oidc_subject, disabled, created_at FROM users ORDER BY username',
      )
      .all() as {
      id: string;
      username: string;
      role: string;
      totp_enabled: number;
      oidc_subject: string | null;
      disabled: number;
      created_at: string;
    }[];
    return {
      users: rows.map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        mfa: !!u.totp_enabled,
        oidc: !!u.oidc_subject,
        disabled: !!u.disabled,
        createdAt: u.created_at,
        groups: groupsOf(u.id),
      })),
    };
  });

  app.post('/api/admin/users', async (req) => {
    const me = admin(req);
    if (config.authMode !== 'local') throw badRequest('Les comptes sont gérés par le fournisseur OIDC');
    const body = parse(createUserSchema, req.body);
    const problem = passwordProblem(body.password, body.username);
    if (problem) throw badRequest(problem, 'MOT_DE_PASSE_FAIBLE');
    if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(body.username))
      throw conflict('Cet identifiant existe déjà');
    const id = randomUUID();
    const now = new Date().toISOString();
    const hash = await hashPassword(body.password);
    db.transaction(() => {
      db.prepare(
        'INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, body.username, hash, body.role, now, now);
      setGroups(id, body.groups);
    })();
    audit.log({
      user: me.username,
      ip: req.ip,
      action: 'utilisateur.creation',
      result: 'succes',
      details: { cible: body.username, role: body.role },
    });
    return { id };
  });

  app.put<{ Params: { id: string } }>('/api/admin/users/:id', async (req) => {
    const me = admin(req);
    const body = parse(updateUserSchema, req.body);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as
      { id: string; username: string; role: string; disabled: number } | undefined;
    if (!target) throw notFound('Utilisateur introuvable');
    const demoting = (body.role && body.role !== 'admin') || body.disabled === true;
    if (target.role === 'admin' && demoting && adminCount() <= 1)
      throw badRequest('Il doit rester au moins un administrateur actif');
    if (body.password) {
      const problem = passwordProblem(body.password, target.username);
      if (problem) throw badRequest(problem, 'MOT_DE_PASSE_FAIBLE');
    }
    const hash = body.password ? await hashPassword(body.password) : undefined;
    const now = new Date().toISOString();
    db.transaction(() => {
      if (body.role)
        db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(body.role, now, target.id);
      if (body.disabled !== undefined)
        db.prepare('UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?').run(
          body.disabled ? 1 : 0,
          now,
          target.id,
        );
      if (hash)
        db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
          hash,
          now,
          target.id,
        );
      if (body.resetTotp) {
        db.prepare(
          'UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = 0, updated_at = ? WHERE id = ?',
        ).run(now, target.id);
        db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(target.id);
      }
      if (body.groups) setGroups(target.id, body.groups);
    })();
    // Toute modification sensible ferme les sessions de la cible (et vide son coffre en mémoire).
    if (body.role || body.disabled || hash || body.resetTotp || body.groups) {
      for (const family of ctx.sessions.destroyUser(target.id)) ctx.vault.wipeFamily(family);
    }
    audit.log({
      user: me.username,
      ip: req.ip,
      action: 'utilisateur.modification',
      result: 'succes',
      details: { cible: target.username, champs: Object.keys(body) },
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/users/:id', async (req) => {
    const me = admin(req);
    const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.params.id) as
      { id: string; username: string; role: string } | undefined;
    if (!target) throw notFound('Utilisateur introuvable');
    if (target.id === me.id) throw badRequest('Vous ne pouvez pas supprimer votre propre compte');
    if (target.role === 'admin' && adminCount() <= 1)
      throw badRequest('Il doit rester au moins un administrateur actif');
    for (const family of ctx.sessions.destroyUser(target.id)) ctx.vault.wipeFamily(family);
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    audit.log({
      user: me.username,
      ip: req.ip,
      action: 'utilisateur.suppression',
      result: 'succes',
      details: { cible: target.username },
    });
    return { ok: true };
  });

  app.get('/api/admin/groups', async (req) => {
    admin(req);
    const rows = db
      .prepare(
        'SELECT g.name, COUNT(ug.user_id) AS members FROM groups g LEFT JOIN user_groups ug ON ug.group_name = g.name GROUP BY g.name ORDER BY g.name',
      )
      .all() as { name: string; members: number }[];
    return { groups: rows };
  });

  app.post('/api/admin/groups', async (req) => {
    const me = admin(req);
    const body = parse(z.strictObject({ name: groupName }), req.body);
    const r = db
      .prepare('INSERT OR IGNORE INTO groups (name, created_at) VALUES (?, ?)')
      .run(body.name, new Date().toISOString());
    if (r.changes === 0) throw conflict('Ce groupe existe déjà');
    audit.log({
      user: me.username,
      ip: req.ip,
      action: 'groupe.creation',
      result: 'succes',
      details: { groupe: body.name },
    });
    return { ok: true };
  });

  app.delete<{ Params: { name: string } }>('/api/admin/groups/:name', async (req) => {
    const me = admin(req);
    const name = parse(groupName, req.params.name);
    const r = db.prepare('DELETE FROM groups WHERE name = ?').run(name);
    if (r.changes === 0) throw notFound('Groupe introuvable');
    audit.log({
      user: me.username,
      ip: req.ip,
      action: 'groupe.suppression',
      result: 'succes',
      details: { groupe: name },
    });
    return { ok: true };
  });

  /** Journal d'audit : consultation réservée aux administrateurs, export CSV. */
  app.get<{ Querystring: { limit?: string; offset?: string; action?: string } }>(
    '/api/admin/audit',
    async (req) => {
      requireRole(req, 'admin');
      const q = parse(
        z.object({
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).default(0),
          action: z
            .string()
            .max(64)
            .regex(/^[\w.-]*$/)
            .optional(),
        }),
        req.query,
      );
      return ctx.audit.list(q);
    },
  );

  app.get('/api/admin/audit.csv', async (req, reply) => {
    const me = requireRole(req, 'admin');
    audit.log({
      user: me.username,
      ip: req.ip,
      action: 'export',
      result: 'succes',
      details: { format: 'csv', objet: 'audit' },
    });
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="journal-audit.csv"')
      .send(`${String.fromCharCode(0xfeff)}${ctx.audit.csv()}`); // BOM : accents corrects dans les tableurs
  });
}
