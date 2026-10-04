import {
  buildGraph,
  buildOrgGraph,
  diff,
  rawSnapshotSchema,
  cloudRegionSchema,
  providerIdProblems,
  resourceKey,
  resourceName,
  type Graph,
} from '@cloudmap/core';
import { AZURE_SERVICES, GCP_SERVICES, SERVICES } from '@cloudmap/scanner';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.ts';
import { badRequest, conflict, notFound, parse } from '../errors.ts';
import { requireUser, securityHeaders } from '../http.ts';
import type { ServerScanEvent } from '../scans.ts';
import type { SnapshotRow } from '../storage.ts';
import { layoutSchema } from '../storage.ts';
import { resolveCredentials } from './credentials.ts';
import { editableProfile, visibleProfile } from './profiles.ts';

const scanInputSchema = z.strictObject({
  regions: z.array(cloudRegionSchema).min(1).max(40).optional(),
  services: z.array(z.string().max(64)).max(64).optional(),
});

/** Services proposés au scan, par fournisseur. */
export const servicesOf = (provider: string) =>
  provider === 'azure' ? AZURE_SERVICES : provider === 'gcp' ? GCP_SERVICES : SERVICES;
const expandSchema = z.string().max(4000).optional();

export function registerSnapshotRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { storage, audit, config } = ctx;
  const graphCache = new Map<string, Graph>();

  /** Snapshot accessible : son profil doit être visible par l'utilisateur. */
  const visibleSnapshot = (req: FastifyRequest, id: string): SnapshotRow => {
    requireUser(req);
    const row = /^[\w-]{1,64}$/.test(id) ? storage.snapshotRow(id) : undefined;
    if (!row) throw notFound('Snapshot introuvable');
    visibleProfile(ctx, req, row.profile_id);
    return row;
  };

  const graphOf = async (req: FastifyRequest, row: SnapshotRow, expanded: string[]): Promise<Graph> => {
    const { profile } = visibleProfile(ctx, req, row.profile_id);
    const rules = storage.rules();
    const key = `${row.id}|${rules.signature}|${JSON.stringify(profile)}|${expanded.join(',')}`;
    const cached = graphCache.get(key);
    if (cached) return cached;
    const graph = await buildGraph(storage.loadSnapshot(row), rules.set, profile, {
      groupingThreshold: config.app.grouping.threshold,
      expandedGroups: expanded,
    });
    if (graphCache.size > 30) graphCache.delete(graphCache.keys().next().value as string);
    graphCache.set(key, graph);
    return graph;
  };

  app.get<{ Params: { id: string } }>('/api/profiles/:id/snapshots', async (req) => {
    const { profile } = visibleProfile(ctx, req, req.params.id);
    return { snapshots: storage.listSnapshots(profile.id) };
  });

  app.get<{ Params: { id: string }; Querystring: { expand?: string } }>(
    '/api/snapshots/:id/graph',
    async (req) => {
      const row = visibleSnapshot(req, req.params.id);
      const expand = parse(expandSchema, req.query.expand);
      const graph = await graphOf(req, row, expand ? expand.split(',').filter(Boolean) : []);
      const snapshot = storage.loadSnapshot(row);
      return { snapshot: row, meta: snapshot.meta, errors: snapshot.errors, graph };
    },
  );

  /** Vue « Organisation » : `graph` nul si le snapshot ne contient ni Organizations ni Identity Center. */
  app.get<{ Params: { id: string } }>('/api/snapshots/:id/org-graph', async (req) => {
    const row = visibleSnapshot(req, req.params.id);
    return { graph: buildOrgGraph(storage.loadSnapshot(row)) };
  });

  app.get<{ Params: { a: string; b: string } }>('/api/snapshots/:a/diff/:b', async (req) => {
    const a = visibleSnapshot(req, req.params.a);
    const b = visibleSnapshot(req, req.params.b);
    const [before, after] = [await graphOf(req, a, []), await graphOf(req, b, [])];
    return { before, after, diff: diff(before, after) };
  });

  /** Inventaire : toutes les ressources du snapshot (y compris celles rendues en conteneurs), sans le brut. */
  app.get<{ Params: { id: string } }>('/api/snapshots/:id/inventory', async (req) => {
    const row = visibleSnapshot(req, req.params.id);
    const snapshot = storage.loadSnapshot(row);
    const rules = storage.rules().set;
    return {
      resources: snapshot.resources.map((r) => {
        const raw = (r.raw ?? {}) as { _status?: unknown };
        return {
          key: resourceKey(r),
          type: r.type,
          typeLabel: rules.byType.get(r.type)?.typeLabel ?? r.type,
          id: r.id,
          name: r.tags?.Name ?? resourceName(r),
          arn: r.arn ?? '',
          region: r.region,
          tags: r.tags ?? {},
          unknown: raw._status === 'inconnu',
        };
      }),
      errors: snapshot.errors,
    };
  });

  app.post<{ Params: { id: string } }>(
    '/api/profiles/:id/import',
    { bodyLimit: config.app.import.maxBytes },
    async (req) => {
      const { profile, user } = editableProfile(ctx, req, req.params.id);
      const result = rawSnapshotSchema.safeParse(req.body);
      if (!result.success) {
        audit.log({
          user: user.username,
          ip: req.ip,
          action: 'import',
          profileId: profile.id,
          result: 'refus',
          details: { motif: 'schéma' },
        });
        throw badRequest(
          'Snapshot invalide : le fichier ne respecte pas le format produit par la CLI',
          'SNAPSHOT_INVALIDE',
        );
      }
      if ((result.data.meta.provider ?? 'aws') !== (profile.provider ?? 'aws'))
        throw badRequest(
          `Ce snapshot vient d'un autre fournisseur (${result.data.meta.provider ?? 'aws'}) que le profil (${profile.provider ?? 'aws'})`,
          'FOURNISSEUR_DIFFERENT',
        );
      if (result.data.meta.accountId !== profile.accountId) {
        audit.log({
          user: user.username,
          ip: req.ip,
          action: 'import',
          profileId: profile.id,
          result: 'refus',
          details: { motif: 'compte' },
        });
        throw badRequest(
          `Ce snapshot concerne le compte ${result.data.meta.accountId}, le profil attend ${profile.accountId}`,
          'COMPTE_DIFFERENT',
        );
      }
      const row = storage.saveSnapshot(profile.id, result.data, 'import');
      audit.log({
        user: user.username,
        ip: req.ip,
        action: 'import',
        profileId: profile.id,
        result: 'succes',
        details: { snapshot: row.id, ressources: row.resource_count },
      });
      return { snapshot: row };
    },
  );

  app.get<{ Params: { id: string } }>('/api/profiles/:id/layout', async (req) => {
    const { profile } = visibleProfile(ctx, req, req.params.id);
    return storage.readLayout(profile.id);
  });

  app.put<{ Params: { id: string } }>(
    '/api/profiles/:id/layout',
    { bodyLimit: 4 * 1024 * 1024 },
    async (req) => {
      const { profile } = editableProfile(ctx, req, req.params.id);
      storage.writeLayout(profile.id, parse(layoutSchema, req.body));
      return { ok: true };
    },
  );

  // ------------------------------------------------------------------ scans

  app.post<{ Params: { id: string } }>(
    '/api/profiles/:id/scans',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const { profile, user } = editableProfile(ctx, req, req.params.id);
      const input = parse(scanInputSchema, req.body ?? {});
      if (ctx.scans.isRunning(profile.id))
        throw conflict('Un scan est déjà en cours pour ce profil', 'SCAN_EN_COURS');
      const regions = input.regions ?? profile.regions;
      if (regions.length === 0) throw badRequest('Aucune région sélectionnée');
      const provider = profile.provider ?? 'aws';
      const known = servicesOf(provider);
      const unknown = (input.services ?? []).filter((s) => !known.some((k) => k.key === s));
      const problems = [
        ...providerIdProblems({ provider, accountId: profile.accountId, regions }),
        ...(unknown.length ? [`Service inconnu : ${unknown.join(', ')}`] : []),
      ];
      if (problems.length) throw badRequest(problems.join(' ; '), 'VALIDATION');
      const credentials = await resolveCredentials(ctx, req, profile);
      const scanId = ctx.scans.start(
        profile,
        credentials,
        { regions, services: input.services },
        { user: user.username, ip: req.ip },
      );
      return { scanId };
    },
  );

  /** Progression en temps réel (Server-Sent Events). */
  app.get<{ Params: { id: string } }>('/api/scans/:id/events', async (req, reply) => {
    requireUser(req);
    const state = ctx.scans.get(req.params.id);
    if (!state) throw notFound('Scan introuvable');
    visibleProfile(ctx, req, state.profileId);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      ...securityHeaders(req.nonce, req.url),
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
    });
    const send = (e: ServerScanEvent) => raw.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    for (const e of state.events) send(e);
    if (state.finished) {
      raw.end();
      return;
    }
    const keepAlive = setInterval(() => raw.write(': attente\n\n'), 20_000);
    const unsubscribe = ctx.scans.subscribe(state.id, (e) => {
      send(e);
      if (e.type === 'end') {
        clearInterval(keepAlive);
        raw.end();
      }
    });
    req.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  /** Journalise un export réalisé dans le navigateur (SVG, PNG, PDF, draw.io, JSON, CSV). */
  app.post('/api/audit/export', async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.strictObject({
        format: z.enum(['svg', 'png', 'pdf', 'drawio', 'json', 'csv']),
        profileId: z.string().max(64).optional(),
      }),
      req.body,
    );
    if (body.profileId) visibleProfile(ctx, req, body.profileId);
    audit.log({
      user: user.username,
      ip: req.ip,
      action: 'export',
      profileId: body.profileId,
      result: 'succes',
      details: { format: body.format },
    });
    return { ok: true };
  });
}
