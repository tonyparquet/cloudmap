import { redact } from '@carto/security';
import type { Db } from './db/index.ts';

export type AuditResult = 'succes' | 'echec' | 'refus';

export interface AuditEntry {
  user?: string | undefined;
  ip?: string | undefined;
  action: string;
  profileId?: string | undefined;
  result: AuditResult;
  details?: Record<string, unknown>;
}

export interface AuditRow {
  id: number;
  ts: string;
  username: string | null;
  ip: string | null;
  action: string;
  profile_id: string | null;
  result: string;
  details: string | null;
}

/** Journal d'audit en ajout seul (triggers SQLite) ; les détails sont redactés, jamais de valeur d'identifiant. */
export class Audit {
  constructor(private readonly db: Db) {}

  log(e: AuditEntry): void {
    this.db
      .prepare(
        'INSERT INTO audit (ts, username, ip, action, profile_id, result, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        new Date().toISOString(),
        e.user ?? null,
        e.ip ?? null,
        e.action,
        e.profileId ?? null,
        e.result,
        e.details ? JSON.stringify(redact(e.details)) : null,
      );
  }

  list(opts: { limit: number; offset: number; action?: string | undefined }): {
    rows: AuditRow[];
    total: number;
  } {
    const where = opts.action ? 'WHERE action LIKE ?' : '';
    const params = opts.action ? [`${opts.action}%`] : [];
    const rows = this.db
      .prepare(`SELECT * FROM audit ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, opts.limit, opts.offset) as AuditRow[];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM audit ${where}`).get(...params) as { n: number }
    ).n;
    return { rows, total };
  }

  /** Export CSV (séparateur « ; »), protégé contre l'injection de formules dans un tableur. */
  csv(): string {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY id').all() as AuditRow[];
    const cell = (v: unknown) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = ['horodatage', 'utilisateur', 'ip', 'action', 'profil', 'resultat', 'details'];
    return [
      header.join(';'),
      ...rows.map((r) =>
        [r.ts, r.username, r.ip, r.action, r.profile_id, r.result, r.details].map(cell).join(';'),
      ),
    ].join('\r\n');
  }
}
