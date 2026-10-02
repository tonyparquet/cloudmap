import type { Profile } from '@carto/core';
import { assumeRole, getSessionToken, hubCredentials } from '@carto/scanner';
import { decryptEnvelope, encryptEnvelope, envelopeSchema, maskAccessKeyId } from '@carto/security';
import { z } from 'zod';
import type { AppSettings } from './config.ts';
import { keyVersion, type Db } from './db/index.ts';
import { badRequest } from './errors.ts';

export type CredentialType = 'temporary' | 'user' | 'user-role' | 'hub-role';

export interface StaticCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

interface MemoryEntry {
  creds: StaticCredentials;
  type: CredentialType;
  masked: string;
  addedAt: number;
  expiresAt: number;
}

const storedSecretSchema = z.object({
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  roleArn: z.string().optional(),
  externalId: z.string().optional(),
});
export type StoredSecret = z.infer<typeof storedSecretSchema>;

/** Métadonnées renvoyées au navigateur : jamais de secret (section 4.3). */
export interface CredentialInfo {
  storage: 'memoire' | 'chiffre' | 'role-hub';
  type: CredentialType;
  maskedAccessKeyId?: string;
  addedAt: string;
  expiresAt?: string;
}

/**
 * Coffre d'identifiants AWS.
 * - Par défaut : en mémoire du serveur, liés à la session (famille), effacés à la déconnexion,
 *   à l'expiration de la session ou après `memoryTtlMinutes`.
 * - « Mémoriser » : clés longue durée chiffrées en enveloppe dans SQLite (AAD = profileId|credentialRef).
 */
export class Vault {
  private readonly memory = new Map<string, MemoryEntry>();

  constructor(
    private readonly db: Db,
    private readonly masterKey: Buffer,
    private readonly settings: AppSettings['credentials'],
    private readonly hubMode: 'none' | 'default-chain',
  ) {}

  private key(family: string, profileId: string): string {
    return `${family}|${profileId}`;
  }

  putMemory(
    family: string,
    profileId: string,
    creds: StaticCredentials,
    type: CredentialType,
    maskedFrom: string,
  ): void {
    const ttl = Date.now() + this.settings.memoryTtlMinutes * 60_000;
    const credsExpiry = creds.expiration ? creds.expiration.getTime() - 60_000 : Infinity;
    this.memory.set(this.key(family, profileId), {
      creds,
      type,
      masked: maskAccessKeyId(maskedFrom),
      addedAt: Date.now(),
      expiresAt: Math.min(ttl, credsExpiry),
    });
  }

  private getMemory(family: string, profileId: string): MemoryEntry | undefined {
    const k = this.key(family, profileId);
    const e = this.memory.get(k);
    if (e && e.expiresAt <= Date.now()) {
      this.memory.delete(k);
      return undefined;
    }
    return e;
  }

  storeEncrypted(
    profileId: string,
    ref: string,
    kind: CredentialType,
    secret: StoredSecret,
    user: string,
  ): void {
    const envelope = encryptEnvelope(
      this.masterKey,
      keyVersion(this.db),
      JSON.stringify(secret),
      `${profileId}|${ref}`,
    );
    this.db
      .prepare(
        `INSERT INTO credentials (ref, profile_id, kind, masked_key_id, envelope, key_version, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET kind = excluded.kind, masked_key_id = excluded.masked_key_id,
           envelope = excluded.envelope, key_version = excluded.key_version, created_at = excluded.created_at,
           created_by = excluded.created_by`,
      )
      .run(
        ref,
        profileId,
        kind,
        maskAccessKeyId(secret.accessKeyId),
        JSON.stringify(envelope),
        envelope.v,
        new Date().toISOString(),
        user,
      );
  }

  private encryptedRow(profileId: string, ref: string) {
    return this.db
      .prepare('SELECT * FROM credentials WHERE ref = ? AND profile_id = ?')
      .get(ref, profileId) as
      | { kind: CredentialType; masked_key_id: string | null; envelope: string; created_at: string }
      | undefined;
  }

  private readEncrypted(profileId: string, ref: string): StoredSecret | undefined {
    const row = this.encryptedRow(profileId, ref);
    if (!row) return undefined;
    const env = envelopeSchema.parse(JSON.parse(row.envelope));
    return storedSecretSchema.parse(
      JSON.parse(decryptEnvelope(this.masterKey, env, `${profileId}|${ref}`).toString('utf8')),
    );
  }

  /** Suppression : mémoire de la session et entrée chiffrée. */
  forget(family: string, profileId: string, ref: string | undefined): void {
    this.memory.delete(this.key(family, profileId));
    if (ref) this.db.prepare('DELETE FROM credentials WHERE ref = ? AND profile_id = ?').run(ref, profileId);
  }

  wipeFamily(family: string): void {
    for (const k of this.memory.keys()) if (k.startsWith(`${family}|`)) this.memory.delete(k);
  }

  wipeProfile(profileId: string): void {
    for (const k of this.memory.keys()) if (k.endsWith(`|${profileId}`)) this.memory.delete(k);
    this.db.prepare('DELETE FROM credentials WHERE profile_id = ?').run(profileId);
  }

  purgeExpired(): void {
    const now = Date.now();
    for (const [k, e] of this.memory) if (e.expiresAt <= now) this.memory.delete(k);
  }

  info(family: string, profile: Profile): CredentialInfo[] {
    const out: CredentialInfo[] = [];
    if (profile.auth.kind === 'assume-role-hub') {
      out.push({ storage: 'role-hub', type: 'hub-role', addedAt: '' });
    }
    const mem = this.getMemory(family, profile.id);
    if (mem) {
      out.push({
        storage: 'memoire',
        type: mem.type,
        maskedAccessKeyId: mem.masked,
        addedAt: new Date(mem.addedAt).toISOString(),
        expiresAt: new Date(mem.expiresAt).toISOString(),
      });
    }
    if (profile.auth.kind === 'access-keys') {
      const row = this.encryptedRow(profile.id, profile.auth.credentialRef);
      if (row) {
        out.push({
          storage: 'chiffre',
          type: row.kind,
          ...(row.masked_key_id ? { maskedAccessKeyId: row.masked_key_id } : {}),
          addedAt: row.created_at,
        });
      }
    }
    return out;
  }

  /** Identifiants temporaires utilisables pour un scan ou un test, côté serveur uniquement. */
  async resolve(family: string, profile: Profile): Promise<StaticCredentials> {
    const duration = this.settings.defaultDurationSeconds;
    const auth = profile.auth;
    if (auth.kind === 'import-only')
      throw badRequest('Ce profil n’accepte que des imports de snapshots', 'IMPORT_SEUL');
    if (auth.kind === 'assume-role-hub') {
      if (this.hubMode !== 'default-chain') {
        throw badRequest(
          'HUB_CREDENTIALS=default-chain est requis pour assumer le rôle sans clé',
          'HUB_INDISPONIBLE',
        );
      }
      return assumeRole(hubCredentials(), auth.roleArn, auth.externalId, duration);
    }
    const mem = this.getMemory(family, profile.id);
    if (mem) return mem.creds;
    const stored = this.readEncrypted(profile.id, auth.credentialRef);
    if (!stored) {
      throw badRequest(
        'Aucun identifiant disponible : saisissez-les dans « Identifiants »',
        'IDENTIFIANTS_ABSENTS',
      );
    }
    const base = { accessKeyId: stored.accessKeyId, secretAccessKey: stored.secretAccessKey };
    const temp = stored.roleArn
      ? await assumeRole(base, stored.roleArn, stored.externalId, duration)
      : await getSessionToken(base, duration);
    this.putMemory(family, profile.id, temp, stored.roleArn ? 'user-role' : 'user', stored.accessKeyId);
    return temp;
  }
}
