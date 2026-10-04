import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.ts';
import { badRequest, notFound, parse } from '../errors.ts';
import { requireUser } from '../http.ts';
import { visibleProfile } from './profiles.ts';

interface FolderRow {
  id: string;
  parent_id: string | null;
  name: string;
}

const MAX_FOLDERS = 500;
const folderId = z.string().regex(/^[\w-]{1,64}$/);
const nameSchema = z.string().trim().min(1, 'Nom de dossier vide').max(80);
const createSchema = z.strictObject({ name: nameSchema, parentId: folderId.nullable().optional() });
const updateSchema = z.strictObject({
  name: nameSchema.optional(),
  parentId: folderId.nullable().optional(),
});
const placeSchema = z.strictObject({ folderId: folderId.nullable() });

/**
 * Dossiers personnels : chaque utilisateur range à sa façon les profils (et leurs diagrammes) qu'il voit,
 * en arborescence. Ranger ne change aucun droit : la visibilité reste celle des groupes du profil.
 */
export function registerFolderRoutes(app: FastifyInstance, ctx: Ctx): void {
  const foldersOf = (userId: string) =>
    ctx.db
      .prepare('SELECT id, parent_id, name FROM folders WHERE user_id = ? ORDER BY name COLLATE NOCASE')
      .all(userId) as FolderRow[];
  const own = (userId: string, id: string): FolderRow => {
    const row = ctx.db
      .prepare('SELECT id, parent_id, name FROM folders WHERE id = ? AND user_id = ?')
      .get(id, userId) as FolderRow | undefined;
    if (!row) throw notFound('Dossier introuvable');
    return row;
  };

  app.get('/api/folders', async (req) => {
    const user = requireUser(req);
    const entries = ctx.db
      .prepare('SELECT profile_id, folder_id FROM folder_entries WHERE user_id = ?')
      .all(user.id) as { profile_id: string; folder_id: string }[];
    return {
      folders: foldersOf(user.id).map((f) => ({ id: f.id, parentId: f.parent_id, name: f.name })),
      entries: Object.fromEntries(entries.map((e) => [e.profile_id, e.folder_id])),
    };
  });

  app.post('/api/folders', async (req) => {
    const user = requireUser(req);
    const body = parse(createSchema, req.body);
    if (body.parentId) own(user.id, body.parentId);
    const count = (
      ctx.db.prepare('SELECT COUNT(*) AS n FROM folders WHERE user_id = ?').get(user.id) as { n: number }
    ).n;
    if (count >= MAX_FOLDERS) throw badRequest(`${MAX_FOLDERS} dossiers au plus`, 'TROP_DE_DOSSIERS');
    const id = randomUUID();
    ctx.db
      .prepare('INSERT INTO folders (id, user_id, parent_id, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, user.id, body.parentId ?? null, body.name, new Date().toISOString());
    return { folder: { id, parentId: body.parentId ?? null, name: body.name } };
  });

  /** Renommer et / ou déplacer (`parentId: null` : à la racine) ; jamais dans lui-même ou un descendant. */
  app.patch<{ Params: { id: string } }>('/api/folders/:id', async (req) => {
    const user = requireUser(req);
    const folder = own(user.id, parse(folderId, req.params.id));
    const body = parse(updateSchema, req.body);
    let parentId = folder.parent_id;
    if (body.parentId !== undefined) {
      parentId = body.parentId;
      for (let p = parentId; p; p = own(user.id, p).parent_id)
        if (p === folder.id) throw badRequest('Un dossier ne peut pas aller dans lui-même', 'CYCLE');
    }
    const name = body.name ?? folder.name;
    ctx.db.prepare('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?').run(name, parentId, folder.id);
    return { folder: { id: folder.id, parentId, name } };
  });

  /** Suppression : sous-dossiers et profils remontent d'un niveau (rien n'est perdu). */
  app.delete<{ Params: { id: string } }>('/api/folders/:id', async (req) => {
    const user = requireUser(req);
    const folder = own(user.id, parse(folderId, req.params.id));
    ctx.db.transaction(() => {
      ctx.db.prepare('UPDATE folders SET parent_id = ? WHERE parent_id = ?').run(folder.parent_id, folder.id);
      if (folder.parent_id)
        ctx.db
          .prepare('UPDATE folder_entries SET folder_id = ? WHERE folder_id = ?')
          .run(folder.parent_id, folder.id);
      ctx.db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id);
    })();
    return { ok: true };
  });

  /** Range un profil visible dans un dossier (`folderId: null` : hors dossier). */
  app.put<{ Params: { id: string } }>('/api/profiles/:id/folder', async (req) => {
    const { profile, user } = visibleProfile(ctx, req, req.params.id);
    const body = parse(placeSchema, req.body);
    if (body.folderId === null) {
      ctx.db
        .prepare('DELETE FROM folder_entries WHERE user_id = ? AND profile_id = ?')
        .run(user.id, profile.id);
      return { ok: true };
    }
    own(user.id, body.folderId);
    ctx.db
      .prepare(
        `INSERT INTO folder_entries (user_id, profile_id, folder_id) VALUES (?, ?, ?)
         ON CONFLICT(user_id, profile_id) DO UPDATE SET folder_id = excluded.folder_id`,
      )
      .run(user.id, profile.id, body.folderId);
    return { ok: true };
  });
}
