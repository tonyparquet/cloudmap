import { AsyncLocalStorage } from 'node:async_hooks';
import { Audit } from './audit.ts';
import type { ServerConfig } from './config.ts';
import { openMemoryDb, type Db } from './db/index.ts';
import { tooMany } from './errors.ts';
import type { AuthUser } from './http.ts';
import { ScanManager } from './scans.ts';
import { Storage } from './storage.ts';
import { Vault } from './vault.ts';

/**
 * Espace de travail : base, fichiers, journal d'audit, coffre et scans. Celui des comptes est sur
 * disque (DATA_DIR) ; chaque invité a le sien, entièrement en mémoire, détruit avec sa session.
 */
export interface Workspace {
  db: Db;
  storage: Storage;
  audit: Audit;
  vault: Vault;
  scans: ScanManager;
  guest: boolean;
}

export function createWorkspace(
  db: Db,
  config: ServerConfig,
  opts: { dataDir?: string; guest: boolean },
): Workspace {
  const audit = new Audit(db);
  const storage = new Storage(db, opts.dataDir, config.configDir, config.app);
  return {
    db,
    storage,
    audit,
    // Invité : jamais l'identité AWS propre de l'outil (HUB_CREDENTIALS), sinon n'importe qui pourrait
    // assumer les rôles des clients avec elle.
    vault: new Vault(
      db,
      config.masterKey,
      config.app.credentials,
      opts.guest ? 'none' : config.hubCredentials,
    ),
    scans: new ScanManager(storage, audit, config.app),
    guest: opts.guest,
  };
}

/** Utilisateur d'un espace invité : éditeur de son seul espace, groupe propre à cet espace. */
export const GUEST_USER: AuthUser = {
  id: 'invite',
  username: 'Invité',
  role: 'editor',
  groups: ['invite'],
  guest: true,
};

/** Espaces invités par famille de session ; nombre limité (mémoire du serveur). */
export class Guests {
  private readonly spaces = new Map<string, Workspace>();

  constructor(
    private readonly config: ServerConfig,
    private readonly seed: (w: Workspace) => void,
  ) {}

  get(family: string): Workspace | undefined {
    return this.spaces.get(family);
  }

  create(family: string): Workspace {
    if (this.spaces.size >= this.config.app.access.maxGuests)
      throw tooMany('Trop de sessions invitées en cours : réessayez plus tard ou créez un compte');
    const db = openMemoryDb();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO users (id, username, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      GUEST_USER.id,
      GUEST_USER.username,
      GUEST_USER.role,
      now,
      now,
    );
    db.prepare('INSERT INTO groups (name, created_at) VALUES (?, ?)').run('invite', now);
    db.prepare('INSERT INTO user_groups (user_id, group_name) VALUES (?, ?)').run(GUEST_USER.id, 'invite');
    const w = createWorkspace(db, this.config, { guest: true });
    this.seed(w);
    this.spaces.set(family, w);
    return w;
  }

  /** Efface l'espace (déconnexion, expiration, création d'un compte) : rien n'en subsiste. */
  drop(family: string): void {
    const w = this.spaces.get(family);
    if (!w) return;
    this.spaces.delete(family);
    w.db.close();
  }

  families(): string[] {
    return [...this.spaces.keys()];
  }
}

/**
 * Aiguillage par requête : les routes utilisent `ctx.db`, `ctx.storage`… qui désignent l'espace de la
 * requête en cours (invité ou comptes). L'espace est fixé une fois pour toute la requête.
 */
export class WorkspaceRouter {
  private readonly current = new AsyncLocalStorage<Workspace>();

  constructor(readonly main: Workspace) {}

  get(): Workspace {
    return this.current.getStore() ?? this.main;
  }

  run(w: Workspace, fn: () => void): void {
    this.current.run(w, fn);
  }

  /** Objet qui délègue chaque accès au service de l'espace courant. */
  proxy<T extends object>(pick: (w: Workspace) => T): T {
    return new Proxy({} as T, {
      get: (_t, prop) => {
        const target = pick(this.get());
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }
}
