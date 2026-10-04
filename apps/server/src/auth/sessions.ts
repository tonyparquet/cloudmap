import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AppSettings } from '../config.ts';
import type { Db } from '../db/index.ts';

export type Stage = 'anon' | 'mfa' | 'enroll' | 'full';

export interface SessionRow {
  id_hash: string;
  family: string;
  user_id: string | null;
  stage: Stage;
  csrf_token: string;
  created_at: number;
  last_seen_at: number;
  elevated_at: number | null;
  ip: string | null;
  /** Session invitée : en mémoire uniquement, liée à un espace de travail éphémère. */
  guest?: boolean;
}

export const COOKIE_NAME = '__Host-session';
/** Sessions non authentifiées (pré-connexion, MFA en attente) : 15 minutes au plus. */
const PENDING_TTL_MS = 15 * 60_000;

/** Cookie de session : `__Host-`, Secure, HttpOnly, SameSite=Strict, Path=/ (section 4.4). */
export const sessionCookie = (token: string) =>
  `${COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict`;
export const clearSessionCookie = `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;

export function readCookie(header: string | undefined, name = COOKIE_NAME): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/**
 * Sessions opaques : identifiant aléatoire de 256 bits, seule son empreinte SHA-256 est stockée.
 * La « famille » survit aux régénérations et sert de clé au coffre d'identifiants en mémoire.
 * Seules les sessions de comptes connectés sont en base ; pré-connexion et invités restent en mémoire
 * (aucune trace sur disque d'une visite sans compte).
 */
export class Sessions {
  private readonly volatile = new Map<string, SessionRow>();

  constructor(
    private readonly db: Db,
    private readonly settings: AppSettings['session'],
  ) {}

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('base64url');
  }

  create(
    stage: Stage,
    userId: string | null,
    ip: string | undefined,
    family: string = randomUUID(),
    guest = false,
  ): { token: string; row: SessionRow } {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const row: SessionRow = {
      id_hash: this.hash(token),
      family,
      user_id: userId,
      stage,
      csrf_token: randomBytes(32).toString('base64url'),
      created_at: now,
      last_seen_at: now,
      elevated_at: null,
      ip: guest ? null : (ip ?? null),
      ...(guest ? { guest: true } : {}),
    };
    if (guest || stage !== 'full') {
      this.volatile.set(row.id_hash, row);
      return { token, row };
    }
    this.db
      .prepare(
        `INSERT INTO sessions (id_hash, family, user_id, stage, csrf_token, created_at, last_seen_at, elevated_at, ip)
         VALUES (@id_hash, @family, @user_id, @stage, @csrf_token, @created_at, @last_seen_at, @elevated_at, @ip)`,
      )
      .run(row);
    return { token, row };
  }

  private expired(row: SessionRow, now: number): boolean {
    if (row.stage !== 'full') return now - row.created_at > PENDING_TTL_MS;
    return (
      now - row.last_seen_at > this.settings.idleMinutes * 60_000 ||
      now - row.created_at > this.settings.absoluteHours * 3_600_000
    );
  }

  find(token: string | undefined): SessionRow | undefined {
    if (!token || token.length > 100) return undefined;
    const row = this.byHashRaw(this.hash(token));
    if (!row) return undefined;
    if (this.expired(row, Date.now())) {
      this.destroy(row);
      return undefined;
    }
    return row;
  }

  touch(row: SessionRow): void {
    const now = Date.now();
    if (now - row.last_seen_at < 15_000) return;
    row.last_seen_at = now;
    if (this.volatile.has(row.id_hash)) return;
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, row.id_hash);
  }

  /**
   * Régénération (connexion, MFA, élévation) : nouvel identifiant et nouveau jeton CSRF, ancienne
   * session supprimée. `restart` remet à zéro la durée de vie absolue (nouvelle connexion).
   */
  regenerate(
    row: SessionRow,
    patch: Partial<Pick<SessionRow, 'stage' | 'user_id' | 'elevated_at'>>,
    restart: boolean,
  ) {
    this.destroy(row);
    const stage = patch.stage ?? row.stage;
    const next = this.create(
      stage,
      patch.user_id !== undefined ? patch.user_id : row.user_id,
      row.ip ?? undefined,
      row.family,
      // Une session invitée qui devient un compte connecté quitte la mémoire pour la base.
      !!row.guest && patch.user_id === undefined,
    );
    const createdAt = restart ? next.row.created_at : row.created_at;
    const elevated = patch.elevated_at !== undefined ? patch.elevated_at : row.elevated_at;
    if (!this.volatile.has(next.row.id_hash))
      this.db
        .prepare('UPDATE sessions SET created_at = ?, elevated_at = ? WHERE id_hash = ?')
        .run(createdAt, elevated, next.row.id_hash);
    Object.assign(next.row, { created_at: createdAt, elevated_at: elevated });
    return next;
  }

  private byHashRaw(idHash: string): SessionRow | undefined {
    return (
      this.volatile.get(idHash) ??
      (this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as SessionRow | undefined)
    );
  }

  byHash(idHash: string): SessionRow | undefined {
    const row = this.byHashRaw(idHash);
    return row && !this.expired(row, Date.now()) ? row : undefined;
  }

  destroy(row: SessionRow): void {
    if (this.volatile.delete(row.id_hash)) return;
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(row.id_hash);
  }

  private all(): SessionRow[] {
    return [...(this.db.prepare('SELECT * FROM sessions').all() as SessionRow[]), ...this.volatile.values()];
  }

  /** Supprime toutes les sessions d'un utilisateur ; renvoie leurs familles (pour vider le coffre). */
  destroyUser(userId: string): string[] {
    const rows = this.all().filter((r) => r.user_id === userId);
    for (const r of rows) this.destroy(r);
    return [...new Set(rows.map((r) => r.family))];
  }

  /** Purge des sessions expirées ; renvoie les familles qui n'ont plus aucune session active. */
  purge(): string[] {
    const now = Date.now();
    const rows = this.all();
    const dead = rows.filter((r) => this.expired(r, now));
    for (const r of dead) this.destroy(r);
    const alive = new Set(rows.filter((r) => !dead.includes(r)).map((r) => r.family));
    return [...new Set(dead.map((r) => r.family))].filter((f) => !alive.has(f));
  }

  familyAlive(family: string): boolean {
    return (
      [...this.volatile.values()].some((r) => r.family === family) ||
      !!this.db.prepare('SELECT 1 FROM sessions WHERE family = ?').get(family)
    );
  }
}
