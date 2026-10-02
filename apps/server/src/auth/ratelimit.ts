import type { Db } from '../db/index.ts';

const MAX_LOCK_MS = 24 * 3_600_000;

/**
 * Limitation des tentatives de connexion (section 4.4) : N échecs par fenêtre, par compte et par IP,
 * puis verrouillage progressif (fenêtre × 2^niveau, plafonné à 24 h). Persisté en base.
 */
export class LoginLimiter {
  constructor(
    private readonly db: Db,
    private readonly attempts: number,
    private readonly windowMinutes: number,
  ) {}

  isLocked(keys: string[], now = Date.now()): boolean {
    return keys.some((key) => {
      const row = this.db.prepare('SELECT locked_until FROM rate_limits WHERE key = ?').get(key) as
        { locked_until: number } | undefined;
      return !!row && row.locked_until > now;
    });
  }

  fail(keys: string[], now = Date.now()): void {
    const windowMs = this.windowMinutes * 60_000;
    for (const key of keys) {
      const row = this.db.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key) as
        { count: number; window_start: number; locked_until: number; lock_level: number } | undefined;
      let count = row && now - row.window_start <= windowMs ? row.count + 1 : 1;
      const windowStart = row && now - row.window_start <= windowMs ? row.window_start : now;
      let level = row?.lock_level ?? 0;
      let lockedUntil = row?.locked_until ?? 0;
      if (count >= this.attempts) {
        lockedUntil = now + Math.min(windowMs * 2 ** level, MAX_LOCK_MS);
        level += 1;
        count = 0;
      }
      this.db
        .prepare(
          `INSERT INTO rate_limits (key, count, window_start, locked_until, lock_level) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_start = excluded.window_start,
             locked_until = excluded.locked_until, lock_level = excluded.lock_level`,
        )
        .run(key, count, windowStart, lockedUntil, level);
    }
  }

  succeed(keys: string[]): void {
    for (const key of keys) this.db.prepare('DELETE FROM rate_limits WHERE key = ?').run(key);
  }
}

export const loginKeys = (username: string, ip: string) => [
  `compte:${username.trim().toLowerCase()}`,
  `ip:${ip}`,
];
