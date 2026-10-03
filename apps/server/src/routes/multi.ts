import { createHash } from 'node:crypto';
import { buildGraph, mergeSnapshots, type Graph } from '@carto/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.ts';
import { badRequest, forbidden, parse } from '../errors.ts';
import { canEdit } from '../http.ts';
import { layoutSchema } from '../storage.ts';
import { visibleProfile } from './profiles.ts';

const querySchema = z.object({
  profiles: z.string().regex(/^[\w-]{1,64}(,[\w-]{1,64}){0,49}$/, 'Sélection de profils invalide'),
  expand: z.string().max(4000).optional(),
});

/**
 * Vue multi-comptes : dernier snapshot de chaque profil sélectionné, fusionnés en un seul graphe
 * (un cadre par compte). Chaque profil doit être visible par l'utilisateur, sinon 404 comme ailleurs.
 */
export function registerMultiRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { storage, config } = ctx;
  const cache = new Map<string, Graph>();

  const selection = (req: FastifyRequest) => {
    const q = parse(querySchema, req.query);
    const ids = [...new Set(q.profiles.split(','))].sort();
    const chosen = ids.map((id) => visibleProfile(ctx, req, id));
    const layoutKey = `multi-${createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 24)}`;
    return { q, chosen, layoutKey };
  };

  app.get('/api/multi/graph', async (req) => {
    const { q, chosen } = selection(req);
    const parts = chosen.flatMap(({ profile }) => {
      const row = storage.listSnapshots(profile.id)[0];
      return row ? [{ profile, row }] : [];
    });
    if (parts.length === 0)
      throw badRequest('Aucun des profils choisis n’a encore de snapshot', 'AUCUN_SNAPSHOT');
    const expanded = q.expand ? q.expand.split(',').filter(Boolean) : [];
    const rules = storage.rules();
    const key = `${parts.map((p) => p.row.id).join(',')}|${rules.signature}|${expanded.join(',')}`;
    let graph = cache.get(key);
    const merged = mergeSnapshots(
      parts.map(({ profile, row }) => ({ name: profile.name, snapshot: storage.loadSnapshot(row), profile })),
    );
    if (!graph) {
      graph = await buildGraph(merged.snapshot, rules.set, merged.profile, {
        groupingThreshold: config.app.grouping.threshold,
        expandedGroups: expanded,
        accountLabels: merged.accountLabels,
      });
      if (cache.size > 10) cache.delete(cache.keys().next().value as string);
      cache.set(key, graph);
    }
    return {
      graph,
      errors: merged.snapshot.errors,
      accounts: parts.map(({ profile, row }) => ({
        profileId: profile.id,
        name: profile.name,
        accountId: profile.accountId,
        snapshotId: row.id,
        createdAt: row.created_at,
      })),
      missing: chosen
        .filter(({ profile }) => !parts.some((p) => p.profile.id === profile.id))
        .map((c) => c.profile.name),
      canEdit: chosen.every(({ profile, user }) => canEdit(user, profile)),
    };
  });

  app.get('/api/multi/layout', async (req) => storage.readLayout(selection(req).layoutKey));

  app.put('/api/multi/layout', { bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const { chosen, layoutKey } = selection(req);
    if (!chosen.every(({ profile, user }) => canEdit(user, profile)))
      throw forbidden('Droits insuffisants sur au moins un des profils');
    storage.writeLayout(layoutKey, parse(layoutSchema, req.body));
    return { ok: true };
  });
}
