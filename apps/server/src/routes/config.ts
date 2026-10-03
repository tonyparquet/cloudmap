import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICES } from '@carto/scanner';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app.ts';
import { notFound } from '../errors.ts';
import { requireRole, requireUser } from '../http.ts';
import { visibleProfile } from './profiles.ts';

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

  app.get('/api/config/services', async (req) => {
    requireUser(req);
    return {
      services: SERVICES,
      defaults: config.app.scanner.defaultServices ?? SERVICES.map((s) => s.key),
      hubAvailable: config.hubCredentials === 'default-chain',
    };
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
    }
    const fill = (s: string) => (externalId ? s.replaceAll('<EXTERNAL_ID>', externalId) : s);
    return {
      trustPolicy: fill(read('trust-policy.json')),
      readonlyPolicy: read('readonly-policy.json'),
      cliExample: fill(read('creer-role.sh')),
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
