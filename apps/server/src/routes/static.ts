import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../app.ts';

const FALLBACK_HTML =
  '<!doctype html><html lang="fr"><meta charset="utf-8"><title>Cartographe AWS</title><body><p>Interface non construite : lancez « pnpm build ».</p></body></html>';

/**
 * Interface web : `/login` et les ressources statiques sont publiques ; toute autre page exige une
 * session complète (sinon redirection vers /login). Le nonce CSP est injecté dans index.html.
 */
export async function registerStaticRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const dist = process.env.WEB_DIST_DIR ?? join(ctx.config.appRoot, 'apps', 'web', 'dist');
  const indexPath = join(dist, 'index.html');
  let cached: string | undefined;
  const template = () => {
    if (process.env.NODE_ENV === 'development' || !cached)
      cached = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : FALLBACK_HTML;
    return cached;
  };
  const sendIndex = (req: FastifyRequest, reply: FastifyReply) =>
    reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(template().replaceAll('__CSP_NONCE__', req.nonce));

  if (existsSync(join(dist, 'assets'))) {
    await app.register(fastifyStatic, {
      root: join(dist, 'assets'),
      prefix: '/assets/',
      decorateReply: false,
      index: false,
      immutable: true,
      maxAge: '365d',
      cacheControl: true,
    });
  }

  app.get('/healthz', async (_req, reply) => reply.type('text/plain; charset=utf-8').send('ok'));

  app.get('/favicon.svg', async (_req, reply) => {
    const p = join(dist, 'favicon.svg');
    if (!existsSync(p)) return reply.status(404).send();
    return reply.type('image/svg+xml').header('cache-control', 'public, max-age=86400').send(readFileSync(p));
  });

  app.get('/login', async (req, reply) => sendIndex(req, reply));

  app.get('/*', async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: { code: 'INTROUVABLE', message: 'Ressource introuvable' } });
    }
    if (!req.user) return reply.redirect('/login', 302);
    return sendIndex(req, reply);
  });
}
