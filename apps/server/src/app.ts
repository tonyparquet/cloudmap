import { timingSafeEqual } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { redactString } from '@carto/security';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { Audit } from './audit.ts';
import { LoginLimiter } from './auth/ratelimit.ts';
import { readCookie, Sessions } from './auth/sessions.ts';
import { Oidc } from './auth/oidc.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import type { ServerConfig } from './config.ts';
import { checkMasterKey, openDb, type Db } from './db/index.ts';
import { AppError, forbidden, unauthorized } from './errors.ts';
import { newNonce, securityHeaders, type AuthUser, type Role } from './http.ts';
import { createLogger } from './logger.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerConfigRoutes } from './routes/config.ts';
import { registerCredentialRoutes } from './routes/credentials.ts';
import { registerProfileRoutes, seedDemo } from './routes/profiles.ts';
import { registerMultiRoutes } from './routes/multi.ts';
import { registerSnapshotRoutes } from './routes/snapshots.ts';
import { registerStaticRoutes } from './routes/static.ts';
import { ScanManager } from './scans.ts';
import { Storage } from './storage.ts';
import { tlsOptions } from './tls.ts';
import { Vault } from './vault.ts';
import { StartupError } from './config.ts';

/** Dépendances partagées par les routes. */
export interface Ctx {
  config: ServerConfig;
  db: Db;
  log: Logger;
  sessions: Sessions;
  limiter: LoginLimiter;
  audit: Audit;
  vault: Vault;
  storage: Storage;
  scans: ScanManager;
  oidc?: Oidc;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Routes accessibles sans session complète : santé, page de connexion et ses ressources, API d'authentification. */
const isPublicApi = (url: string) => url.startsWith('/api/auth/');

export async function buildApp(
  config: ServerConfig,
  opts: { logger?: Logger } = {},
): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const log = opts.logger ?? createLogger(config.logLevel, config.dataDir);
  const db = openDb(config.dataDir);
  const keyProblem = checkMasterKey(db, config.masterKey);
  if (keyProblem) {
    db.close();
    throw new StartupError([keyProblem]);
  }
  const audit = new Audit(db);
  const storage = new Storage(db, config.dataDir, config.configDir, config.app);
  const ctx: Ctx = {
    config,
    db,
    log,
    sessions: new Sessions(db, config.app.session),
    limiter: new LoginLimiter(
      db,
      config.app.rateLimit.loginAttempts,
      config.app.rateLimit.loginWindowMinutes,
    ),
    audit,
    vault: new Vault(db, config.masterKey, config.app.credentials, config.hubCredentials),
    storage,
    scans: new ScanManager(storage, audit, config.app),
    ...(config.oidc ? { oidc: new Oidc(config.oidc, config.publicOrigin) } : {}),
  };

  const app = Fastify({
    https: tlsOptions(config.tls),
    loggerInstance: log as FastifyBaseLogger,
    trustProxy: config.trustedProxyCidrs.length ? config.trustedProxyCidrs : false,
    bodyLimit: 1024 * 1024,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    return503OnClosing: true,
  });

  await app.register(rateLimit, {
    global: true,
    max: config.app.rateLimit.apiPerMinute,
    timeWindow: '1 minute',
    errorResponseBuilder: () =>
      new AppError(429, 'TROP_DE_REQUETES', 'Trop de requêtes, réessayez dans un instant'),
  });

  const loadUser = (id: string): AuthUser | undefined => {
    const u = db.prepare('SELECT id, username, role, disabled FROM users WHERE id = ?').get(id) as
      { id: string; username: string; role: Role; disabled: number } | undefined;
    if (!u || u.disabled) return undefined;
    const groups = (
      db.prepare('SELECT group_name FROM user_groups WHERE user_id = ?').all(id) as { group_name: string }[]
    ).map((g) => g.group_name);
    return { id: u.id, username: u.username, role: u.role, groups };
  };

  app.addHook('onRequest', async (req) => {
    req.nonce = newNonce();
    const session = ctx.sessions.find(readCookie(req.headers.cookie));
    if (session) {
      ctx.sessions.touch(session);
      req.session = session;
      if (session.stage === 'full' && session.user_id) {
        const user = loadUser(session.user_id);
        if (user) req.user = user;
        else {
          ctx.sessions.destroy(session);
          req.session = undefined;
        }
      }
    }
    const url = req.url;
    if (!url.startsWith('/api/')) return;
    // CSRF : toute requête non-GET exige Origin = PUBLIC_ORIGIN et le jeton synchronisé de la session.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers.origin !== config.publicOrigin)
        throw forbidden('Origine de la requête refusée', 'CSRF');
      const token = req.headers['x-csrf-token'];
      if (!req.session || typeof token !== 'string' || !safeEqual(token, req.session.csrf_token)) {
        throw forbidden('Jeton CSRF absent ou invalide', 'CSRF');
      }
    }
    if (!isPublicApi(url) && (!req.user || req.session?.stage !== 'full')) throw unauthorized();
  });

  app.addHook('onSend', async (req, reply, payload) => {
    for (const [k, v] of Object.entries(securityHeaders(req.nonce ?? newNonce(), req.url))) {
      if (!reply.hasHeader(k)) reply.header(k, v);
    }
    reply.removeHeader('server');
    reply.removeHeader('x-powered-by');
    return payload;
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const status = err.statusCode ?? 500;
    if (status === 413)
      return reply
        .status(413)
        .send({ error: { code: 'TROP_VOLUMINEUX', message: 'Contenu trop volumineux' } });
    if (status === 415) {
      return reply
        .status(415)
        .send({ error: { code: 'TYPE_NON_SUPPORTE', message: 'Type de contenu non supporté' } });
    }
    if (status === 429)
      return reply.status(429).send({ error: { code: 'TROP_DE_REQUETES', message: 'Trop de requêtes' } });
    if (status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'REQUETE_INVALIDE', message: 'Requête invalide' } });
    }
    req.log.error({ err: { name: err.name, message: redactString(err.message) } }, 'erreur interne');
    return reply
      .status(500)
      .send({ error: { code: 'ERREUR_INTERNE', message: 'Erreur interne du serveur' } });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: 'INTROUVABLE', message: 'Ressource introuvable' } }),
  );

  registerAuthRoutes(app, ctx);
  registerProfileRoutes(app, ctx);
  registerCredentialRoutes(app, ctx);
  registerSnapshotRoutes(app, ctx);
  registerMultiRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  await registerStaticRoutes(app, ctx);

  if (config.demoMode) seedDemo(ctx);

  const timer = setInterval(() => {
    for (const family of ctx.sessions.purge()) ctx.vault.wipeFamily(family);
    ctx.vault.purgeExpired();
  }, 60_000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    db.close();
  });
  return { app, ctx };
}
