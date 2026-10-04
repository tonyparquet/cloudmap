import { randomUUID } from 'node:crypto';
import type { Profile } from '@cloudmap/core';
import {
  azureHasWriteAccess,
  azureSubscription,
  azureTokenFromPasted,
  azureTokenFromSecret,
  CloudHttpError,
  gcpHasWriteAccess,
  gcpProject,
  gcpTokenFromPasted,
  gcpTokenFromServiceAccount,
} from '@cloudmap/scanner';
import { z } from 'zod';
import type { Ctx } from '../app.ts';
import { AppError } from '../errors.ts';
import type { AuthUser } from '../http.ts';
import type { StoredSecret, TokenCredentials } from '../vault.ts';
import { saveProfile } from './profiles.ts';

const guid = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'GUID attendu');

/** Identifiants Azure et Google Cloud saisis dans l'interface (écriture seule, comme pour AWS). */
export const tokenInputSchemas = [
  z.strictObject({
    type: z.literal('azure-token'),
    accessToken: z
      .string()
      .trim()
      .regex(/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/, 'Jeton Azure invalide (az account get-access-token)')
      .max(16384),
  }),
  z.strictObject({
    type: z.literal('azure-sp'),
    tenantId: guid,
    clientId: guid,
    clientSecret: z.string().trim().min(8).max(512),
    remember: z.boolean().default(false),
  }),
  z.strictObject({
    type: z.literal('gcp-token'),
    accessToken: z
      .string()
      .trim()
      .regex(/^ya29\.[\w.-]{20,4096}$/, 'Jeton Google Cloud invalide (gcloud auth print-access-token)'),
  }),
  z.strictObject({
    type: z.literal('gcp-sa'),
    serviceAccountJson: z.string().trim().min(50).max(16384),
    remember: z.boolean().default(false),
  }),
] as const;
export type TokenInput = z.infer<(typeof tokenInputSchemas)[number]>;

export const isTokenInputType = (type: string): type is TokenInput['type'] =>
  ['azure-token', 'azure-sp', 'gcp-token', 'gcp-sa'].includes(type);

/** Secret mémorisé Azure / Google Cloud → saisie équivalente (réutilisation entre profils). */
export function tokenInputFromStored(secret: StoredSecret): TokenInput | undefined {
  if (secret.kind === 'azure-sp') return { type: 'azure-sp', ...secret, remember: true };
  if (secret.kind === 'gcp-sa')
    return { type: 'gcp-sa', serviceAccountJson: secret.serviceAccountJson, remember: true };
  return undefined;
}

/** Accès du jeton à l'abonnement ou au projet du profil : identité affichable, sinon erreur explicite. */
export async function checkTokenScope(profile: Profile, token: TokenCredentials): Promise<string> {
  try {
    if (token.provider === 'azure') {
      const sub = await azureSubscription(token, profile.accountId);
      if (sub.subscriptionId.toLowerCase() !== profile.accountId.toLowerCase()) throw new Error('abonnement');
      return `${sub.displayName} (${sub.subscriptionId})`;
    }
    const project = await gcpProject(token, profile.accountId);
    if (project.projectId !== profile.accountId) throw new Error('projet');
    return `${project.displayName ?? project.projectId} (${project.projectId})`;
  } catch (err) {
    const what = token.provider === 'azure' ? 'à l’abonnement' : 'au projet';
    const detail = err instanceof CloudHttpError ? ` (HTTP ${err.status} ${err.code})` : '';
    throw new AppError(
      400,
      'IDENTIFIANTS_REFUSES',
      `Ces identifiants n’ont pas accès ${what} ${profile.accountId}${detail}`,
    );
  }
}

/**
 * Saisie Azure / Google Cloud : validation du jeton ou échange immédiat du secret contre un jeton
 * temporaire (portée lecture seule pour un compte de service Google), accès à l'abonnement / au projet
 * vérifié, avertissement si les droits permettent d'écrire. En mémoire par défaut ; secret chiffré en
 * enveloppe seulement si « Mémoriser ».
 */
export async function saveTokenCredentials(
  ctx: Ctx,
  args: {
    profile: Profile;
    user: AuthUser;
    ip: string;
    family: string;
    input: TokenInput;
    source?: string;
    fail: (motif: string, code?: string) => never;
  },
) {
  const { profile, user, ip, family, input, fail } = args;
  const provider = profile.provider ?? 'aws';
  const expected = input.type.startsWith('azure') ? 'azure' : 'gcp';
  if (provider !== expected)
    fail(
      `Ces identifiants (${expected}) ne correspondent pas au fournisseur du profil (${provider})`,
      'TYPE_INCOMPATIBLE',
    );

  let token: TokenCredentials;
  let masked = 'jeton';
  let secret: StoredSecret | undefined;
  try {
    switch (input.type) {
      case 'azure-token':
        token = azureTokenFromPasted(input.accessToken);
        break;
      case 'azure-sp':
        token = await azureTokenFromSecret(input);
        masked = input.clientId;
        if (input.remember)
          secret = {
            kind: 'azure-sp',
            tenantId: input.tenantId,
            clientId: input.clientId,
            clientSecret: input.clientSecret,
          };
        break;
      case 'gcp-token':
        token = gcpTokenFromPasted(input.accessToken);
        break;
      case 'gcp-sa':
        token = await gcpTokenFromServiceAccount(input.serviceAccountJson);
        masked = String(
          (JSON.parse(input.serviceAccountJson) as { client_email?: unknown }).client_email ?? 'compte',
        );
        if (input.remember) secret = { kind: 'gcp-sa', serviceAccountJson: input.serviceAccountJson };
        break;
    }
  } catch (err) {
    return fail((err as Error).message);
  }
  const identity = await checkTokenScope(profile, token).catch((err: AppError) => fail(err.message));

  const warnings: string[] = [];
  const writes =
    token.provider === 'azure'
      ? await azureHasWriteAccess(token, profile.accountId)
      : await gcpHasWriteAccess(token, profile.accountId);
  if (token.provider === 'gcp' && token.readOnlyScope) {
    if (writes)
      warnings.push('Rôle IAM avec droits d’écriture : le jeton obtenu reste limité à la lecture seule');
  } else {
    if (writes) warnings.push('Ces identifiants ne sont pas en lecture seule');
    if (token.provider === 'gcp')
      warnings.push(
        'Jeton à portée complète : préférez un compte de service (jeton limité à la lecture seule)',
      );
  }

  const credentialRef = profile.auth.kind === 'access-keys' ? profile.auth.credentialRef : randomUUID();
  const auth: Profile['auth'] = { kind: 'access-keys', credentialRef };
  ctx.vault.putMemory(family, profile.id, token, input.type, masked);
  if (secret) ctx.vault.storeEncrypted(profile.id, credentialRef, input.type, secret, user.username);
  if (JSON.stringify(auth) !== JSON.stringify(profile.auth)) saveProfile(ctx.db, { ...profile, auth });
  ctx.audit.log({
    user: user.username,
    ip,
    action: 'identifiants.ajout',
    profileId: profile.id,
    result: 'succes',
    details: {
      type: input.type,
      memorise: !!secret,
      identite: identity,
      ...(args.source ? { source: args.source } : {}),
    },
  });
  return { credentials: ctx.vault.info(family, { ...profile, auth }), warnings };
}
