import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICES } from '@cloudmap/scanner';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app.ts';
import { notFound } from '../errors.ts';
import { requireRole, requireUser } from '../http.ts';
import { visibleProfile } from './profiles.ts';
import { servicesOf } from './snapshots.ts';
import { changelogSection } from '../changelog.ts';
import { APP_VERSION } from '../version.ts';

export function registerConfigRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { storage, config } = ctx;

  app.get('/api/config/rules', async (req) => {
    requireRole(req, 'admin');
    const { set } = storage.rules();
    return {
      files: set.files,
      errors: set.errors,
      types: set.byType.size + set.wildcards.length,
    };
  });

  app.get('/api/config/theme', async (req) => {
    requireUser(req);
    return storage.theme();
  });

  app.get('/api/config/app', async (req) => {
    requireRole(req, 'admin');
    return {
      yaml: storage.appYaml(),
      effective: config.app,
      authMode: config.authMode,
      hubCredentials: config.hubCredentials,
      demoMode: config.demoMode,
    };
  });

  app.get<{ Querystring: { provider?: string } }>('/api/config/services', async (req) => {
    requireUser(req);
    const provider = req.query.provider ?? 'aws';
    const services = servicesOf(provider);
    return {
      services,
      defaults:
        provider === 'aws'
          ? (config.app.scanner.defaultServices ?? SERVICES.map((s) => s.key))
          : services.map((s) => s.key),
      hubAvailable: ctx.vault.hubAvailable,
    };
  });

  /** Aide Azure / Google Cloud : documents de docs/<fournisseur>/ (rôle en lecture seule, commandes). */
  app.get<{ Params: { provider: string } }>('/api/help/cloud/:provider', async (req) => {
    requireUser(req);
    if (!['azure', 'gcp'].includes(req.params.provider)) throw notFound();
    const dir = join(config.appRoot, 'docs', req.params.provider);
    const documents = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => /^[\w.-]+\.(md|json|ya?ml|sh)$/.test(f))
          .sort()
          .map((name) => ({ name, content: readFileSync(join(dir, name), 'utf8') }))
      : [];
    return { documents };
  });

  /** Version installée et dernière version publiée (cache côté serveur). */
  app.get('/api/updates', async (req) => {
    requireUser(req);
    return ctx.updates.status();
  });

  /** Recherche forcée d'une mise à jour (administrateurs), journalisée. */
  app.post('/api/updates/check', async (req) => {
    const user = requireRole(req, 'admin');
    const status = await ctx.updates.status(true);
    ctx.audit.log({
      user: user.username,
      ip: req.ip,
      action: 'mise-a-jour.verification',
      result: status.error ? 'echec' : 'succes',
      details: { courante: status.current, ...(status.latest ? { publiee: status.latest } : {}) },
    });
    return status;
  });

  /** Notes de la version installée (CHANGELOG.md livré avec l'application). */
  app.get('/api/changelog', async (req) => {
    requireUser(req);
    const file = join(config.appRoot, 'CHANGELOG.md');
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    return { version: APP_VERSION, notes: changelogSection(text, APP_VERSION) ?? '' };
  });

  /** Aide « rôle IAM client » : documents de docs/iam/, External ID du profil choisi inséré. */
  app.get<{ Querystring: { profileId?: string } }>('/api/help/iam', async (req) => {
    requireUser(req);
    const dir = join(config.appRoot, 'docs', 'iam');
    const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
    let externalId: string | undefined;
    if (req.query.profileId) {
      const { profile } = visibleProfile(ctx, req, req.query.profileId);
      if (profile.auth.kind === 'assume-role-hub') externalId = profile.auth.externalId;
      else if (profile.auth.kind === 'access-keys') externalId = profile.auth.externalId;
      else if (profile.auth.kind === 'assume-role-profile') externalId = profile.auth.externalId;
    }
    const fill = (s: string) => (externalId ? s.replaceAll('<EXTERNAL_ID>', externalId) : s);
    return {
      trustPolicy: fill(read('trust-policy.json')),
      readonlyPolicy: read('readonly-policy.json'),
      cliExample: fill(read('creer-role.sh')),
      stackSet: read('stackset-lecture-seule.yaml'),
      externalId,
    };
  });

  /** Icônes : pack AWS s'il est présent dans CONFIG_DIR, sinon icônes génériques de repli. */
  app.get<{ Params: { name: string }; Querystring: { category?: string } }>(
    '/icons/:name',
    async (req, reply) => {
      requireUser(req);
      const name = req.params.name.replace(/\.svg$/, '');
      const category = req.query.category;
      if (!/^[\w-]{1,40}$/.test(name) || (category !== undefined && !/^[\w-]{1,40}$/.test(category)))
        throw notFound();
      const svg = storage.icon(name, category);
      if (!svg) throw notFound('Icône introuvable');
      return reply
        .type('image/svg+xml')
        .header('cache-control', 'private, max-age=3600')
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .send(svg);
    },
  );
}
