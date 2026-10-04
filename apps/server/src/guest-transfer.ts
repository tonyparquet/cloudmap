import { isDemoProfile } from './http.ts';
import { listProfiles, saveProfile } from './routes/profiles.ts';
import { GUEST_USER, type Workspace } from './workspace.ts';

/**
 * Invité qui crée un compte : son travail (profils, snapshots, mises en page, identifiants mémorisés,
 * dossiers) passe dans l'espace des comptes, rattaché au nouveau compte. Les profils de démonstration
 * restent dans l'espace invité, effacé ensuite. `group` absent : premier compte (administrateur, voit tout).
 */
export function adoptGuestWorkspace(
  main: Workspace,
  guest: Workspace,
  owner: { userId: string; group: string | undefined },
): { profiles: number; snapshots: number } {
  const profiles = listProfiles(guest.db).filter((p) => !isDemoProfile(p.id));
  const ids = new Set(profiles.map((p) => p.id));
  let snapshots = 0;
  main.db.transaction(() => {
    for (const p of profiles) {
      const groups = p.allowedGroups.filter((g) => g !== GUEST_USER.groups[0]);
      saveProfile(main.db, {
        ...p,
        allowedGroups: owner.group ? [...new Set([...groups, owner.group])] : groups,
      });
      for (const row of guest.storage.listSnapshots(p.id).reverse()) {
        const data = guest.storage.snapshotFile(row);
        if (!data) continue;
        main.storage.adoptSnapshot(row, data);
        snapshots++;
      }
      const layout = guest.storage.readLayout(p.id);
      if (Object.keys(layout.positions).length) main.storage.writeLayout(p.id, layout);
    }
    // Identifiants mémorisés : même clé maître, même données associées (profil|référence).
    const creds = guest.db.prepare('SELECT * FROM credentials').all() as Record<string, unknown>[];
    for (const c of creds.filter((c) => ids.has(String(c.profile_id))))
      main.db
        .prepare(
          `INSERT INTO credentials (ref, profile_id, kind, masked_key_id, envelope, key_version, created_at, created_by)
           VALUES (@ref, @profile_id, @kind, @masked_key_id, @envelope, @key_version, @created_at, NULL)`,
        )
        .run(c);
    // Dossiers personnels : l'arborescence et le rangement des profils transférés.
    const folders = guest.db
      .prepare('SELECT id, parent_id, name, created_at FROM folders ORDER BY created_at')
      .all() as { id: string; parent_id: string | null; name: string; created_at: string }[];
    const insertFolder = main.db.prepare(
      'INSERT INTO folders (id, user_id, parent_id, name, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    const done = new Set<string>();
    // Parents avant enfants (clé étrangère) : passes successives, l'arborescence est sans cycle.
    while (done.size < folders.length) {
      const before = done.size;
      for (const f of folders)
        if (!done.has(f.id) && (!f.parent_id || done.has(f.parent_id))) {
          insertFolder.run(f.id, owner.userId, f.parent_id, f.name, f.created_at);
          done.add(f.id);
        }
      if (done.size === before) break;
    }
    const entries = guest.db.prepare('SELECT profile_id, folder_id FROM folder_entries').all() as {
      profile_id: string;
      folder_id: string;
    }[];
    for (const e of entries)
      if (ids.has(e.profile_id) && done.has(e.folder_id))
        main.db
          .prepare('INSERT INTO folder_entries (user_id, profile_id, folder_id) VALUES (?, ?, ?)')
          .run(owner.userId, e.profile_id, e.folder_id);
  })();
  return { profiles: profiles.length, snapshots };
}
