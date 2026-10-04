import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parseRules, rawSnapshotSchema, type RawSnapshot, type RuleSet } from '@cloudmap/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { AppSettings } from './config.ts';
import type { Db } from './db/index.ts';
import { badRequest } from './errors.ts';

export interface SnapshotRow {
  id: string;
  profile_id: string;
  created_at: string;
  file: string;
  source: 'scan' | 'import' | 'demo';
  account_id: string;
  resource_count: number;
  error_count: number;
}

export const layoutSchema = z.strictObject({
  positions: z.record(
    z.string().max(2200),
    z.strictObject({ x: z.number().finite(), y: z.number().finite() }),
  ),
});
export type Layout = z.infer<typeof layoutSchema>;

const SAFE_ID = /^[\w-]{1,64}$/;
function safeId(id: string): string {
  if (!SAFE_ID.test(id)) throw badRequest('Identifiant invalide');
  return id;
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out: Record<string, unknown> = { ...((base as Record<string, unknown>) ?? {}) };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(out[k], v);
  return out;
}

/** Fichiers de DATA_DIR (snapshots gzip, mises en page) et lecture de CONFIG_DIR (règles, thème). */
export class Storage {
  private rulesCache?: { signature: string; set: RuleSet };

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly configDir: string,
    private readonly settings: AppSettings,
  ) {
    for (const d of ['snapshots', 'layouts', 'logs']) mkdirSync(join(dataDir, d), { recursive: true });
  }

  // ------------------------------------------------------------------ snapshots

  saveSnapshot(profileId: string, snapshot: RawSnapshot, source: SnapshotRow['source']): SnapshotRow {
    const dir = join(this.dataDir, 'snapshots', safeId(profileId));
    mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const file = `${createdAt.replace(/[:.]/g, '-')}-${id.slice(0, 8)}.json.gz`;
    writeFileSync(
      join(dir, file),
      gzipSync(JSON.stringify({ ...snapshot, meta: { ...snapshot.meta, profileId } })),
      { mode: 0o600 },
    );
    const row: SnapshotRow = {
      id,
      profile_id: profileId,
      created_at: createdAt,
      file,
      source,
      account_id: snapshot.meta.accountId,
      resource_count: snapshot.resources.length,
      error_count: snapshot.errors.length,
    };
    this.db
      .prepare(
        `INSERT INTO snapshots (id, profile_id, created_at, file, source, account_id, resource_count, error_count)
         VALUES (@id, @profile_id, @created_at, @file, @source, @account_id, @resource_count, @error_count)`,
      )
      .run(row);
    this.applyRetention(profileId);
    return row;
  }

  listSnapshots(profileId: string): SnapshotRow[] {
    return this.db
      .prepare('SELECT * FROM snapshots WHERE profile_id = ? ORDER BY created_at DESC')
      .all(profileId) as SnapshotRow[];
  }

  snapshotRow(id: string): SnapshotRow | undefined {
    return this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as SnapshotRow | undefined;
  }

  loadSnapshot(row: SnapshotRow): RawSnapshot {
    const path = join(this.dataDir, 'snapshots', safeId(row.profile_id), row.file);
    return rawSnapshotSchema.parse(JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')));
  }

  /** Rétention : nombre maximal de snapshots par profil et âge maximal. */
  applyRetention(profileId: string): void {
    const rows = this.listSnapshots(profileId);
    const limit = Date.now() - this.settings.snapshots.maxAgeDays * 86_400_000;
    const doomed = rows.filter(
      (r, i) => i >= this.settings.snapshots.maxCount || (i > 0 && Date.parse(r.created_at) < limit),
    );
    for (const r of doomed) {
      rmSync(join(this.dataDir, 'snapshots', safeId(profileId), r.file), { force: true });
      this.db.prepare('DELETE FROM snapshots WHERE id = ?').run(r.id);
    }
  }

  deleteProfileFiles(profileId: string): void {
    rmSync(join(this.dataDir, 'snapshots', safeId(profileId)), { recursive: true, force: true });
    rmSync(join(this.dataDir, 'layouts', `${safeId(profileId)}.json`), { force: true });
  }

  // ------------------------------------------------------------------ mises en page

  readLayout(profileId: string): Layout {
    const path = join(this.dataDir, 'layouts', `${safeId(profileId)}.json`);
    if (!existsSync(path)) return { positions: {} };
    const r = layoutSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return r.success ? r.data : { positions: {} };
  }

  writeLayout(profileId: string, layout: Layout): void {
    if (Object.keys(layout.positions).length > 20_000) throw badRequest('Mise en page trop volumineuse');
    writeFileSync(join(this.dataDir, 'layouts', `${safeId(profileId)}.json`), JSON.stringify(layout), {
      mode: 0o600,
    });
  }

  // ------------------------------------------------------------------ CONFIG_DIR

  /** Règles rechargées dès qu'un fichier de CONFIG_DIR/rules change (ajout d'une règle sans rebuild). */
  rules(): { set: RuleSet; signature: string } {
    const dir = join(this.configDir, 'rules');
    const files = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => /\.ya?ml$/.test(f))
          .sort()
      : [];
    const signature = files.map((f) => `${f}:${statSync(join(dir, f)).mtimeMs}`).join('|');
    if (this.rulesCache?.signature !== signature) {
      this.rulesCache = {
        signature,
        set: parseRules(files.map((name) => ({ name, content: readFileSync(join(dir, name), 'utf8') }))),
      };
    }
    return this.rulesCache;
  }

  /** Thème : `sombre` + surcharges de chaque variante. */
  theme(): { defaut: string; themes: Record<string, unknown> } {
    const path = join(this.configDir, 'theme.yaml');
    const raw = (existsSync(path) ? parseYaml(readFileSync(path, 'utf8')) : {}) as {
      defaut?: string;
      themes?: Record<string, unknown>;
    };
    const themes = raw.themes ?? {};
    const base = themes.sombre ?? {};
    return {
      defaut: raw.defaut ?? 'sombre',
      themes: Object.fromEntries(
        Object.entries(themes).map(([name, t]) => [name, name === 'sombre' ? t : deepMerge(base, t)]),
      ),
    };
  }

  appYaml(): string {
    const path = join(this.configDir, 'app.yaml');
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  icon(name: string, category: string | undefined): Buffer | undefined {
    const candidates = [
      join(this.configDir, 'icons', 'aws', `${name}.svg`),
      join(this.configDir, 'icons', 'generic', `${name}.svg`),
      ...(category ? [join(this.configDir, 'icons', 'generic', `${category}.svg`)] : []),
      join(this.configDir, 'icons', 'generic', 'generic.svg'),
    ];
    const found = candidates.find((p) => existsSync(p));
    return found ? readFileSync(found) : undefined;
  }
}
