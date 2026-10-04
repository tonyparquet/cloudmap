import { randomBytes, randomUUID } from 'node:crypto';
import { decryptEnvelope, encryptEnvelope, envelopeSchema } from '@cloudmap/security';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.ts';
import { keyVersion } from '../db/index.ts';
import { AppError, badRequest, forbidden, notFound, parse, tooMany, unauthorized } from '../errors.ts';
import { requireElevated, requireUser, type AuthUser } from '../http.ts';
import { adoptGuestWorkspace } from '../guest-transfer.ts';
import { GUEST_USER } from '../workspace.ts';
import type { OidcPending } from './oidc.ts';
import {
  generateRecoveryCodes,
  hashPassword,
  hashRecoveryCode,
  passwordProblem,
  verifyPassword,
} from './passwords.ts';
import { loginKeys } from './ratelimit.ts';
import { clearSessionCookie, readCookie, sessionCookie, type SessionRow, type Stage } from './sessions.ts';
import { checkTotp, enrollmentData, newTotpSecret } from './totp.ts';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string | null;
  role: 'admin' | 'editor' | 'viewer';
  totp_secret: string | null;
  totp_enabled: number;
  totp_last_step: number;
  oidc_subject: string | null;
  disabled: number;
}

const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Identifiant : 3 caractères minimum')
  .max(64)
  .regex(/^[\w.@-]+$/, 'Identifiant : lettres, chiffres, . _ @ -');
const credentialsSchema = z.strictObject({ username: usernameSchema, password: z.string().min(1).max(256) });
const codeSchema = z.strictObject({ code: z.string().trim().min(6).max(20) });
const reauthSchema = z.strictObject({
  password: z.string().min(1).max(256),
  // Exigé seulement si le compte a activé le MFA.
  code: z.string().trim().min(6).max(20).optional(),
});

const OIDC_COOKIE = '__Host-oidc';
const INVALID = () => new AppError(401, 'IDENTIFIANTS_INVALIDES', 'Identifiant ou mot de passe incorrect');
const BAD_CODE = () => new AppError(401, 'CODE_INVALIDE', 'Code de vérification incorrect');

export function totpAad(userId: string) {
  return `totp|${userId}`;
}

/** Groupe personnel d'un compte créé librement : ses profils ne sont visibles que de lui (et des admins). */
export const personalGroup = (username: string) => `perso.${username.replace(/[^\w.-]/g, '-')}`.slice(0, 64);

export function registerAuthRoutes(app: FastifyInstance, ctx: Ctx): void {
  // Comptes, sessions et journal : toujours l'espace des comptes, même depuis une session invitée.
  const { db, audit } = ctx.main;
  const { sessions, limiter, config } = ctx;
  const oidcPending = new Map<string, OidcPending & { sessionHash?: string; userId?: string }>();

  const userById = (id: string | null) =>
    id ? (db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) : undefined;
  const userByName = (name: string) =>
    db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(name.trim()) as
      UserRow | undefined;
  const usersCount = () => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  const groupsOf = (id: string) =>
    (
      db.prepare('SELECT group_name FROM user_groups WHERE user_id = ?').all(id) as { group_name: string }[]
    ).map((g) => g.group_name);
  const publicUser = (u: UserRow): AuthUser => ({
    id: u.id,
    username: u.username,
    role: u.role,
    groups: groupsOf(u.id),
  });

  const totpSecret = (u: UserRow): string | undefined =>
    u.totp_secret
      ? decryptEnvelope(
          config.masterKey,
          envelopeSchema.parse(JSON.parse(u.totp_secret)),
          totpAad(u.id),
        ).toString('utf8')
      : undefined;

  const requireSession = (req: FastifyRequest, ...stages: Stage[]): SessionRow => {
    const s = req.session;
    if (!s || (stages.length && !stages.includes(s.stage)))
      throw unauthorized('Session absente ou étape invalide');
    return s;
  };
  const regenerate = (
    reply: FastifyReply,
    row: SessionRow,
    patch: Parameters<typeof sessions.regenerate>[1],
    restart: boolean,
  ) => {
    const next = sessions.regenerate(row, patch, restart);
    reply.header('set-cookie', sessionCookie(next.token));
    return next.row;
  };
  const localOnly = () => {
    if (config.authMode !== 'local') throw notFound();
  };

  /** État de l'authentification ; crée une session anonyme (porteuse du jeton CSRF) si besoin. */
  app.get('/api/auth/state', async (req, reply) => {
    let session = req.session;
    if (!session) {
      const created = sessions.create('anon', null, req.ip);
      session = created.row;
      reply.header('set-cookie', sessionCookie(created.token));
    }
    const elevatedUntil = session.elevated_at
      ? session.elevated_at + config.app.session.reauthMinutes * 60_000
      : undefined;
    const firstAccount = config.authMode === 'local' && usersCount() === 0;
    return {
      authMode: config.authMode,
      setupRequired: firstAccount,
      registrationOpen: config.authMode === 'local' && (firstAccount || config.app.access.selfRegistration),
      guestsAllowed: config.app.access.guests,
      guest: !!session.guest,
      stage: session.stage,
      csrfToken: session.csrf_token,
      demoMode: config.demoMode,
      ...(req.user ? { user: req.user } : {}),
      ...(req.user && !req.user.guest ? { mfaEnabled: !!userById(req.user.id)?.totp_enabled } : {}),
      ...(elevatedUntil && elevatedUntil > Date.now() ? { elevatedUntil } : {}),
    };
  });

  /**
   * Création de compte (mode local) : le premier compte devient administrateur ; les suivants, si la
   * création libre est ouverte, sont éditeurs de leur groupe personnel. MFA activable plus tard. Depuis
   * une session invitée, le travail en cours est transféré dans le nouveau compte.
   */
  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      localOnly();
      const session = requireSession(req);
      if (session.stage !== 'anon' && !session.guest) throw forbidden('Déjà connecté');
      const body = parse(credentialsSchema, req.body);
      const problem = passwordProblem(body.password, body.username);
      if (problem) throw badRequest(problem, 'MOT_DE_PASSE_FAIBLE');
      const guestSpace = session.guest ? ctx.guests.get(session.family) : undefined;
      if (guestSpace?.scans.anyRunning())
        throw badRequest('Un scan est en cours : attendez sa fin avant de créer le compte', 'SCAN_EN_COURS');
      const hash = await hashPassword(body.password);
      const id = randomUUID();
      const now = new Date().toISOString();
      const group = personalGroup(body.username);
      const role = db.transaction((): UserRow['role'] => {
        const first = usersCount() === 0;
        if (!first && !config.app.access.selfRegistration)
          throw forbidden('La création de compte est réservée aux administrateurs', 'INSCRIPTION_FERMEE');
        if (userByName(body.username))
          throw badRequest('Cet identifiant est déjà utilisé', 'IDENTIFIANT_PRIS');
        db.prepare(
          'INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, body.username, hash, first ? 'admin' : 'editor', now, now);
        if (!first) {
          db.prepare('INSERT OR IGNORE INTO groups (name, created_at) VALUES (?, ?)').run(group, now);
          db.prepare('INSERT INTO user_groups (user_id, group_name) VALUES (?, ?)').run(id, group);
        }
        return first ? 'admin' : 'editor';
      })();
      const transferred = guestSpace
        ? adoptGuestWorkspace(ctx.main, guestSpace, {
            userId: id,
            group: role === 'admin' ? undefined : group,
          })
        : undefined;
      if (guestSpace) {
        guestSpace.vault.moveFamilyTo(ctx.main.vault, session.family);
        ctx.guests.drop(session.family);
      }
      const row = regenerate(reply, session, { stage: 'full', user_id: id, elevated_at: null }, true);
      audit.log({
        user: body.username,
        ip: req.ip,
        action: role === 'admin' ? 'setup.administrateur' : 'compte.creation',
        result: 'succes',
        ...(transferred ? { details: { reprisInvite: transferred } } : {}),
      });
      const user = userById(id);
      return { csrfToken: row.csrf_token, user: user ? publicUser(user) : undefined, transferred };
    },
  );

  /** Session invitée : espace en mémoire, aucune donnée enregistrée ni journalisée. */
  app.post(
    '/api/auth/guest',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!config.app.access.guests) throw forbidden('Le mode invité est désactivé', 'INVITE_DESACTIVE');
      const session = requireSession(req, 'anon');
      sessions.destroy(session);
      const created = sessions.create('full', GUEST_USER.id, req.ip, session.family, true);
      ctx.guests.create(session.family);
      reply.header('set-cookie', sessionCookie(created.token));
      return { csrfToken: created.row.csrf_token, user: GUEST_USER };
    },
  );

  app.post('/api/auth/login', async (req, reply) => {
    localOnly();
    const session = requireSession(req);
    const body = parse(credentialsSchema, req.body);
    const keys = loginKeys(body.username, req.ip);
    if (limiter.isLocked(keys)) {
      audit.log({
        user: body.username,
        ip: req.ip,
        action: 'connexion',
        result: 'refus',
        details: { motif: 'verrouillage' },
      });
      throw tooMany();
    }
    const user = userByName(body.username);
    const ok = await verifyPassword(user && !user.disabled ? user.password_hash : null, body.password);
    if (!ok || !user || user.disabled) {
      limiter.fail(keys);
      audit.log({ user: body.username, ip: req.ip, action: 'connexion', result: 'echec' });
      throw INVALID();
    }
    const stage: Stage = user.totp_enabled ? 'mfa' : 'full';
    const row = regenerate(reply, session, { stage, user_id: user.id, elevated_at: null }, true);
    if (stage === 'full') {
      limiter.succeed(keys);
      audit.log({ user: user.username, ip: req.ip, action: 'connexion', result: 'succes' });
    }
    return { stage, csrfToken: row.csrf_token, ...(stage === 'full' ? { user: publicUser(user) } : {}) };
  });

  /** Compte connecté : état du MFA (activable et désactivable à tout moment). */
  app.get('/api/auth/account', async (req) => {
    const current = requireUser(req);
    if (current.guest) throw forbidden('Session invitée : aucun compte');
    const user = userById(current.id);
    if (!user) throw unauthorized();
    const left = (
      db
        .prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
        .get(user.id) as { n: number }
    ).n;
    return {
      username: user.username,
      role: user.role,
      local: config.authMode === 'local',
      mfaEnabled: !!user.totp_enabled,
      recoveryCodesLeft: left,
    };
  });

  /** Activation du MFA (après ré-authentification) : secret TOTP à scanner. */
  const enrollingUser = (req: FastifyRequest): UserRow => {
    localOnly();
    const current = requireElevated(req, config.app.session.reauthMinutes);
    if (current.guest) throw forbidden('Session invitée : créez un compte pour activer le MFA');
    const user = userById(current.id);
    if (!user) throw unauthorized();
    if (user.totp_enabled) throw badRequest('Le MFA est déjà activé', 'MFA_DEJA_ACTIF');
    return user;
  };

  app.get('/api/auth/totp/enroll', async (req) => {
    const user = enrollingUser(req);
    let secret = !user.totp_enabled ? totpSecret(user) : undefined;
    if (!secret) {
      secret = newTotpSecret();
      const env = encryptEnvelope(config.masterKey, keyVersion(db), secret, totpAad(user.id));
      db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0, updated_at = ? WHERE id = ?').run(
        JSON.stringify(env),
        new Date().toISOString(),
        user.id,
      );
    }
    return enrollmentData(user.username, secret);
  });

  app.post('/api/auth/totp/enroll', async (req, reply) => {
    const user = enrollingUser(req);
    const session = requireSession(req, 'full');
    const secret = totpSecret(user);
    if (!secret) throw badRequest('Enrôlement non commencé');
    const keys = loginKeys(user.username, req.ip);
    if (limiter.isLocked(keys)) throw tooMany();
    const body = parse(codeSchema, req.body);
    const step = await checkTotp(secret, body.code, 0);
    if (!step) {
      limiter.fail(keys);
      throw BAD_CODE();
    }
    const codes = generateRecoveryCodes();
    db.transaction(() => {
      db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ?, updated_at = ? WHERE id = ?').run(
        step,
        new Date().toISOString(),
        user.id,
      );
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(user.id);
      for (const c of codes)
        db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)').run(
          user.id,
          hashRecoveryCode(c),
        );
    })();
    limiter.succeed(keys);
    const row = regenerate(reply, session, { elevated_at: null }, false);
    audit.log({ user: user.username, ip: req.ip, action: 'mfa.activation', result: 'succes' });
    return { recoveryCodes: codes, csrfToken: row.csrf_token, user: publicUser(user) };
  });

  /** Désactivation du MFA (après ré-authentification avec le code) : secret et codes de secours effacés. */
  app.delete('/api/auth/totp', async (req) => {
    localOnly();
    const current = requireElevated(req, config.app.session.reauthMinutes);
    if (current.guest) throw forbidden();
    db.transaction(() => {
      db.prepare(
        'UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = 0, updated_at = ? WHERE id = ?',
      ).run(new Date().toISOString(), current.id);
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(current.id);
    })();
    audit.log({ user: current.username, ip: req.ip, action: 'mfa.desactivation', result: 'succes' });
    return { ok: true };
  });

  /** Second facteur : code TOTP (anti-rejeu) ou code de secours à usage unique. */
  const verifySecondFactor = async (user: UserRow, code: string): Promise<boolean> => {
    const secret = totpSecret(user);
    if (/^\d{6}$/.test(code)) {
      const step = secret ? await checkTotp(secret, code, user.totp_last_step) : undefined;
      if (!step) return false;
      db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
      return true;
    }
    const used = db
      .prepare(
        'UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
      )
      .run(new Date().toISOString(), user.id, hashRecoveryCode(code));
    return used.changes === 1;
  };

  app.post('/api/auth/totp', async (req, reply) => {
    localOnly();
    const session = requireSession(req, 'mfa');
    const user = userById(session.user_id);
    if (!user || user.disabled) throw unauthorized();
    const keys = loginKeys(user.username, req.ip);
    if (limiter.isLocked(keys)) throw tooMany();
    const body = parse(codeSchema, req.body);
    if (!(await verifySecondFactor(user, body.code))) {
      limiter.fail(keys);
      audit.log({ user: user.username, ip: req.ip, action: 'connexion.mfa', result: 'echec' });
      throw BAD_CODE();
    }
    limiter.succeed(keys);
    const row = regenerate(reply, session, { stage: 'full' }, true);
    audit.log({ user: user.username, ip: req.ip, action: 'connexion', result: 'succes' });
    return { csrfToken: row.csrf_token, user: publicUser(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const session = req.session;
    if (session) {
      sessions.destroy(session);
      // Invité : l'espace entier disparaît (profils, snapshots, identifiants), sans journal.
      if (session.guest) ctx.guests.drop(session.family);
      else {
        ctx.main.vault.wipeFamily(session.family);
        if (req.user)
          audit.log({ user: req.user.username, ip: req.ip, action: 'deconnexion', result: 'succes' });
      }
    }
    reply.header('set-cookie', clearSessionCookie);
    return { ok: true };
  });

  /** Ré-authentification (mot de passe + TOTP, ou nouvelle connexion OIDC) avant les actions sensibles. */
  app.post('/api/auth/reauth', async (req, reply) => {
    const user = requireUser(req);
    const session = requireSession(req, 'full');
    if (user.guest) throw forbidden('Session invitée : aucune ré-authentification nécessaire');
    if (config.authMode === 'oidc' && ctx.oidc) {
      const { url, pending } = await ctx.oidc.start(true);
      const id = randomBytes(24).toString('base64url');
      oidcPending.set(id, { ...pending, sessionHash: session.id_hash, userId: user.id });
      reply.header('set-cookie', `${OIDC_COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`);
      return { redirect: url };
    }
    const row = userById(user.id);
    if (!row) throw unauthorized();
    const keys = loginKeys(row.username, req.ip);
    if (limiter.isLocked(keys)) throw tooMany();
    const body = parse(reauthSchema, req.body);
    const ok =
      (await verifyPassword(row.password_hash, body.password)) &&
      (!row.totp_enabled || (!!body.code && (await verifySecondFactor(row, body.code))));
    if (!ok) {
      limiter.fail(keys);
      audit.log({ user: row.username, ip: req.ip, action: 'reauth', result: 'echec' });
      throw new AppError(401, 'REAUTH_ECHEC', 'Mot de passe ou code incorrect');
    }
    limiter.succeed(keys);
    const next = regenerate(reply, session, { elevated_at: Date.now() }, false);
    audit.log({ user: row.username, ip: req.ip, action: 'reauth', result: 'succes' });
    return {
      csrfToken: next.csrf_token,
      elevatedUntil: Date.now() + config.app.session.reauthMinutes * 60_000,
    };
  });

  // ------------------------------------------------------------------ OIDC

  app.get('/api/auth/oidc/start', async (req, reply) => {
    if (config.authMode !== 'oidc' || !ctx.oidc) throw notFound();
    const { url, pending } = await ctx.oidc.start(false);
    const id = randomBytes(24).toString('base64url');
    oidcPending.set(id, pending);
    setTimeout(() => oidcPending.delete(id), 10 * 60_000).unref();
    // Cookie Lax : le cookie de session (Strict) n'est pas envoyé au retour du fournisseur d'identité.
    reply.header('set-cookie', `${OIDC_COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`);
    return reply.redirect(url, 302);
  });

  app.get('/api/auth/oidc/callback', async (req, reply) => {
    if (config.authMode !== 'oidc' || !ctx.oidc) throw notFound();
    const id = readCookie(req.headers.cookie, OIDC_COOKIE);
    const pending = id ? oidcPending.get(id) : undefined;
    if (id) oidcPending.delete(id);
    if (!pending) throw badRequest('Tentative de connexion OIDC inconnue ou expirée');
    let identity;
    try {
      identity = await ctx.oidc.callback(new URL(req.url, config.publicOrigin), pending);
    } catch (err) {
      audit.log({
        ip: req.ip,
        action: 'connexion.oidc',
        result: 'echec',
        details: { motif: (err as Error).message },
      });
      throw new AppError(401, 'OIDC_ECHEC', 'Connexion OIDC refusée');
    }
    const role = ctx.oidc.roleFor(identity.groups);
    const now = new Date().toISOString();
    let user = db.prepare('SELECT * FROM users WHERE oidc_subject = ?').get(identity.subject) as
      UserRow | undefined;
    db.transaction(() => {
      if (!user) {
        const uid = randomUUID();
        const name = userByName(identity.username)
          ? `${identity.username}#${identity.subject.slice(0, 8)}`
          : identity.username;
        db.prepare(
          'INSERT INTO users (id, username, role, oidc_subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(uid, name, role, identity.subject, now, now);
        user = userById(uid);
      } else db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, now, user.id);
      const uid = (user as UserRow).id;
      db.prepare('DELETE FROM user_groups WHERE user_id = ?').run(uid);
      for (const g of identity.groups) {
        db.prepare('INSERT OR IGNORE INTO groups (name, created_at) VALUES (?, ?)').run(g, now);
        db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_name) VALUES (?, ?)').run(uid, g);
      }
    })();
    const u = user as unknown as UserRow;
    if (u.disabled) throw forbidden('Compte désactivé');
    if (pending.sessionHash) {
      const current = sessions.byHash(pending.sessionHash);
      if (!current || current.user_id !== u.id) throw forbidden('Ré-authentification refusée');
      regenerate(reply, current, { elevated_at: Date.now() }, false);
      audit.log({ user: u.username, ip: req.ip, action: 'reauth', result: 'succes' });
    } else {
      const created = sessions.create('anon', null, req.ip);
      regenerate(reply, created.row, { stage: 'full', user_id: u.id }, true);
      audit.log({
        user: u.username,
        ip: req.ip,
        action: 'connexion',
        result: 'succes',
        details: { mode: 'oidc' },
      });
    }
    reply.header('set-cookie', `${OIDC_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
    // Page intermédiaire de même origine : la navigation suivante enverra le cookie Strict.
    return reply
      .type('text/html; charset=utf-8')
      .send(
        '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>Connexion…</title>',
      );
  });
}
