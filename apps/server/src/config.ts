import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMasterKey } from '@carto/security';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { readTlsMaterial, type TlsFiles, type TlsMaterial } from './tls.ts';

/** Erreur de démarrage : l'application refuse de démarrer et affiche chaque problème. */
export class StartupError extends Error {
  constructor(readonly problems: string[]) {
    super(`Démarrage refusé :\n${problems.map((p) => ` - ${p}`).join('\n')}`);
  }
}

const capped = (max: number, def: number) =>
  z
    .number()
    .int()
    .positive()
    .default(def)
    .transform((v) => Math.min(v, max));

export const appSettingsSchema = z.object({
  session: z
    .object({ idleMinutes: capped(30, 30), absoluteHours: capped(8, 8), reauthMinutes: capped(15, 5) })
    .default({ idleMinutes: 30, absoluteHours: 8, reauthMinutes: 5 }),
  credentials: z
    .object({
      memoryTtlMinutes: capped(720, 60),
      defaultDurationSeconds: z.number().int().min(900).max(43200).default(3600),
    })
    .default({ memoryTtlMinutes: 60, defaultDurationSeconds: 3600 }),
  scanner: z
    .object({
      concurrency: z.number().int().min(1).max(32).default(6),
      probeTimeoutMs: z.number().int().min(500).max(30000).default(5000),
      defaultServices: z.array(z.string()).optional(),
    })
    .default({ concurrency: 6, probeTimeoutMs: 5000 }),
  grouping: z.object({ threshold: z.number().int().min(1).default(5) }).default({ threshold: 5 }),
  snapshots: z
    .object({
      maxCount: z.number().int().min(1).default(50),
      maxAgeDays: z.number().int().min(1).default(365),
    })
    .default({ maxCount: 50, maxAgeDays: 365 }),
  import: z
    .object({
      maxBytes: z
        .number()
        .int()
        .min(1024)
        .max(1024 ** 3)
        .default(50 * 1024 ** 2),
    })
    .default({ maxBytes: 50 * 1024 ** 2 }),
  rateLimit: z
    .object({
      apiPerMinute: z.number().int().min(10).default(600),
      loginAttempts: capped(5, 5),
      loginWindowMinutes: z.number().int().min(15).default(15),
    })
    .default({ apiPerMinute: 600, loginAttempts: 5, loginWindowMinutes: 15 }),
  // Recherche de mise à jour : flux des releases (API GitHub), consulté côté serveur et mis en cache.
  updates: z
    .object({
      enabled: z.boolean().default(true),
      feedUrl: z
        .url({ protocol: /^https$/ })
        .max(2048)
        .optional(),
      intervalHours: z.number().int().min(1).max(168).default(24),
    })
    .default({ enabled: true, intervalHours: 24 }),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  adminGroup?: string;
  editorGroup?: string;
  groupsClaim: string;
}

export interface ServerConfig {
  port: number;
  host: string;
  appRoot: string;
  configDir: string;
  dataDir: string;
  tlsFiles: TlsFiles;
  tls: TlsMaterial;
  masterKey: Buffer;
  /** Jeton de lecture du flux de mises à jour (UPDATES_TOKEN_FILE), jamais renvoyé au navigateur. */
  updatesToken?: string;
  publicOrigin: string;
  trustedProxyCidrs: string[];
  authMode: 'local' | 'oidc';
  oidc?: OidcSettings;
  hubCredentials: 'none' | 'default-chain';
  logLevel: string;
  demoMode: boolean;
  app: AppSettings;
}

/** Racine de l'application : contient `config/` (valeurs par défaut), `fixtures/`, `docs/` et `apps/web/dist`. */
export const defaultAppRoot = () => fileURLToPath(new URL('../../../', import.meta.url));

/** Premier démarrage : copie des valeurs par défaut (règles, thème, icônes, app.yaml) dans CONFIG_DIR. */
export function ensureConfigDir(configDir: string, appRoot: string): void {
  mkdirSync(configDir, { recursive: true });
  const defaults = join(appRoot, 'config');
  if (
    !existsSync(join(configDir, 'app.yaml')) &&
    existsSync(defaults) &&
    resolve(defaults) !== resolve(configDir)
  ) {
    cpSync(defaults, configDir, { recursive: true, force: false, errorOnExist: false });
  }
}

/**
 * Paramètres : app.yaml de CONFIG_DIR, complété section par section par les valeurs livrées avec
 * l'application (une mise à jour apporte ses nouveaux réglages sans écraser ceux de l'utilisateur).
 */
export function loadAppSettings(configDir: string, appRoot?: string): AppSettings {
  const read = (file: string): Record<string, unknown> =>
    existsSync(file) ? ((parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown> | null) ?? {}) : {};
  const user = read(join(configDir, 'app.yaml'));
  const shipped = appRoot ? read(join(appRoot, 'config', 'app.yaml')) : {};
  const merged: Record<string, unknown> = { ...shipped, ...user };
  for (const [k, v] of Object.entries(shipped)) {
    const u = user[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && u && typeof u === 'object' && !Array.isArray(u))
      merged[k] = { ...v, ...u };
  }
  const r = appSettingsSchema.safeParse(merged);
  if (!r.success) {
    throw new StartupError(r.error.issues.map((i) => `app.yaml : ${i.path.join('.')} — ${i.message}`));
  }
  return r.data;
}

/**
 * Contrôles bloquants de la section 4.1 : TLS, clé maître et origine publique HTTPS obligatoires,
 * certificat non expiré. Aucune variable ne permet de désactiver TLS, l'authentification ou le MFA.
 */
/**
 * Configuration du serveur. `options.masterKey` : clé maître fournie en mémoire par l'application de
 * bureau (déchiffrée depuis le trousseau du système) ; elle remplace MASTER_KEY_FILE, sans écriture
 * en clair sur disque. Tous les autres contrôles bloquants sont identiques.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { masterKey?: Buffer } = {},
): ServerConfig {
  const problems: string[] = [];
  const required = (name: string, why: string) => {
    const v = env[name]?.trim();
    if (!v) problems.push(`${name} est obligatoire : ${why}`);
    return v ?? '';
  };
  const certFile = required('TLS_CERT_FILE', "l'application ne démarre qu'en HTTPS (TLS 1.3)");
  const keyFile = required('TLS_KEY_FILE', "l'application ne démarre qu'en HTTPS (TLS 1.3)");
  const masterKeyFile = options.masterKey
    ? ''
    : required('MASTER_KEY_FILE', 'clé maître de chiffrement des identifiants (32 octets en base64)');
  const originText = required('PUBLIC_ORIGIN', 'origine publique HTTPS, ex. https://carto.exemple.fr');

  let publicOrigin = '';
  if (originText) {
    try {
      const u = new URL(originText);
      if (u.protocol !== 'https:')
        problems.push(`PUBLIC_ORIGIN doit commencer par https:// (reçu : ${u.protocol}//)`);
      else if (u.pathname !== '/' || u.search || u.hash)
        problems.push('PUBLIC_ORIGIN doit être une origine seule, sans chemin');
      publicOrigin = u.origin;
    } catch {
      problems.push('PUBLIC_ORIGIN n’est pas une URL valide');
    }
  }

  let tls: TlsMaterial | undefined;
  const tlsFiles: TlsFiles = { certFile, keyFile, ...(env.TLS_CA_FILE ? { caFile: env.TLS_CA_FILE } : {}) };
  if (certFile && keyFile) {
    try {
      tls = readTlsMaterial(tlsFiles);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }

  let masterKey: Buffer | undefined;
  if (options.masterKey) {
    if (options.masterKey.length === 32) masterKey = options.masterKey;
    else problems.push('Clé maître fournie invalide : 32 octets attendus');
  } else if (masterKeyFile) {
    try {
      masterKey = parseMasterKey(readFileSync(masterKeyFile, 'utf8'));
    } catch (err) {
      problems.push(
        (err as NodeJS.ErrnoException).code
          ? `Clé maître illisible : ${masterKeyFile}`
          : `MASTER_KEY_FILE : ${(err as Error).message}`,
      );
    }
  }

  const port = Number(env.PORT ?? 8443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT invalide');

  const authMode = (env.AUTH_MODE ?? 'local').trim();
  if (authMode !== 'local' && authMode !== 'oidc')
    problems.push('AUTH_MODE doit valoir « local » ou « oidc »');
  let oidc: OidcSettings | undefined;
  if (authMode === 'oidc') {
    const issuer = required('OIDC_ISSUER', 'émetteur OpenID Connect (HTTPS)');
    const clientId = required('OIDC_CLIENT_ID', 'identifiant client OpenID Connect');
    const secretFile = required(
      'OIDC_CLIENT_SECRET_FILE',
      'fichier contenant le secret client OpenID Connect',
    );
    if (issuer && !issuer.startsWith('https://')) problems.push('OIDC_ISSUER doit être en https://');
    let clientSecret = '';
    if (secretFile) {
      try {
        clientSecret = readFileSync(secretFile, 'utf8').trim();
      } catch {
        problems.push(`Secret OIDC illisible : ${secretFile}`);
      }
    }
    oidc = {
      issuer,
      clientId,
      clientSecret,
      ...(env.OIDC_ADMIN_GROUP ? { adminGroup: env.OIDC_ADMIN_GROUP } : {}),
      ...(env.OIDC_EDITOR_GROUP ? { editorGroup: env.OIDC_EDITOR_GROUP } : {}),
      groupsClaim: env.OIDC_GROUPS_CLAIM ?? 'groups',
    };
  }

  const hub = (env.HUB_CREDENTIALS ?? 'none').trim();
  if (hub !== 'none' && hub !== 'default-chain')
    problems.push('HUB_CREDENTIALS doit valoir « none » ou « default-chain »');

  const trustedProxyCidrs = (env.TRUSTED_PROXY_CIDRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of trustedProxyCidrs) {
    if (!/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(c))
      problems.push(`TRUSTED_PROXY_CIDRS : plage invalide « ${c} »`);
  }

  // Jeton facultatif pour un flux de mises à jour privé (dépôt GitHub privé) : lecture des releases seule.
  let updatesToken: string | undefined;
  if (env.UPDATES_TOKEN_FILE) {
    try {
      updatesToken = readFileSync(env.UPDATES_TOKEN_FILE, 'utf8').trim();
    } catch {
      problems.push(`Jeton de mises à jour illisible : ${env.UPDATES_TOKEN_FILE}`);
    }
  }

  if (problems.length || !tls || !masterKey) throw new StartupError(problems);

  const appRoot = env.APP_ROOT ?? defaultAppRoot();
  const configDir = resolve(env.CONFIG_DIR ?? '/config');
  const dataDir = resolve(env.DATA_DIR ?? '/data');
  ensureConfigDir(configDir, appRoot);
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    appRoot,
    configDir,
    dataDir,
    tlsFiles,
    tls,
    masterKey,
    publicOrigin,
    trustedProxyCidrs,
    authMode: authMode as 'local' | 'oidc',
    ...(oidc ? { oidc } : {}),
    hubCredentials: hub as 'none' | 'default-chain',
    logLevel: env.LOG_LEVEL ?? 'info',
    demoMode: env.DEMO_MODE === 'true',
    app: loadAppSettings(configDir, appRoot),
    ...(updatesToken ? { updatesToken } : {}),
  };
}
