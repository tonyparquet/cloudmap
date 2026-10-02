import { externalIdSchema, roleArnSchema, type Profile } from '@carto/core';
import {
  assumeRole,
  getCallerIdentity,
  getSessionToken,
  hasWritePermissions,
  hubCredentials,
  isRootArn,
} from '@carto/scanner';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.ts';
import { AppError, badRequest, parse } from '../errors.ts';
import { requireElevated } from '../http.ts';
import type { CredentialType, StaticCredentials } from '../vault.ts';
import { editableProfile, saveProfile, visibleProfile } from './profiles.ts';

const accessKeyId = z
  .string()
  .trim()
  .regex(/^(AKIA|ASIA)[A-Z0-9]{16}$/, 'Identifiant de clé d’accès invalide');
const secretAccessKey = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9/+=]{40}$/, 'Clé secrète invalide');
const sessionToken = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9/+=]{16,4096}$/, 'Jeton de session invalide');
const duration = z.number().int().min(900).max(43200).optional();

/** Types acceptés (section 4.3), du plus recommandé au moins recommandé. */
export const credentialInputSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('temporary'), accessKeyId, secretAccessKey, sessionToken }),
  z.strictObject({
    type: z.literal('user-role'),
    accessKeyId,
    secretAccessKey,
    roleArn: roleArnSchema,
    externalId: externalIdSchema,
    remember: z.boolean().default(false),
    durationSeconds: duration,
  }),
  z.strictObject({
    type: z.literal('user'),
    accessKeyId,
    secretAccessKey,
    remember: z.boolean().default(false),
    durationSeconds: duration,
  }),
  z.strictObject({ type: z.literal('hub-role'), roleArn: roleArnSchema, externalId: externalIdSchema }),
]);

const stsFailure = (err: unknown) =>
  new AppError(
    400,
    'IDENTIFIANTS_REFUSES',
    `AWS a refusé ces identifiants (${(err as { name?: string })?.name ?? 'erreur'}) : vérifiez-les et réessayez`,
  );

export function registerCredentialRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { audit, vault, config } = ctx;
  const reauth = () => config.app.session.reauthMinutes;

  /** Saisie : validation, GetCallerIdentity, refus du compte racine et d'un compte différent, échange immédiat. */
  app.put<{ Params: { id: string } }>('/api/profiles/:id/credentials', async (req) => {
    const { profile, user } = editableProfile(ctx, req, req.params.id);
    requireElevated(req, reauth());
    const session = req.session;
    if (!session) throw badRequest('Session absente');
    if (profile.auth.kind === 'import-only')
      throw badRequest('Ce profil n’accepte que des imports de snapshots', 'IMPORT_SEUL');
    const input = parse(credentialInputSchema, req.body);
    const dur =
      ('durationSeconds' in input && input.durationSeconds) || config.app.credentials.defaultDurationSeconds;
    const fail = (motif: string): never => {
      audit.log({
        user: user.username,
        ip: req.ip,
        action: 'identifiants.ajout',
        profileId: profile.id,
        result: 'refus',
        details: { type: input.type, motif },
      });
      throw badRequest(motif, 'IDENTIFIANTS_REFUSES');
    };

    let temp: StaticCredentials;
    let identityArn: string;
    let auth: Profile['auth'];
    try {
      if (input.type === 'hub-role') {
        if (config.hubCredentials !== 'default-chain')
          fail('HUB_CREDENTIALS=default-chain est requis pour ce mode');
        temp = await assumeRole(hubCredentials(), input.roleArn, input.externalId, dur);
        auth = { kind: 'assume-role-hub', roleArn: input.roleArn, externalId: input.externalId };
      } else {
        const given = {
          accessKeyId: input.accessKeyId,
          secretAccessKey: input.secretAccessKey,
          ...(input.type === 'temporary' ? { sessionToken: input.sessionToken } : {}),
        };
        const caller = await getCallerIdentity(given);
        if (isRootArn(caller.arn))
          fail(
            'Les identifiants du compte racine (root) sont refusés : utilisez un rôle ou un utilisateur IAM en lecture seule',
          );
        if (input.type === 'user-role') {
          temp = await assumeRole(given, input.roleArn, input.externalId, dur);
        } else {
          if (caller.account !== profile.accountId)
            fail(
              `Ces identifiants appartiennent au compte ${caller.account}, le profil attend ${profile.accountId}`,
            );
          temp = input.type === 'user' ? await getSessionToken(given, dur) : given;
        }
        auth = {
          kind: 'access-keys',
          credentialRef:
            profile.auth.kind === 'access-keys' ? profile.auth.credentialRef : crypto.randomUUID(),
          ...(input.type === 'user-role' ? { roleArn: input.roleArn, externalId: input.externalId } : {}),
        };
      }
      const identity = await getCallerIdentity(temp);
      if (identity.account !== profile.accountId)
        fail(
          `Le rôle assumé appartient au compte ${identity.account}, le profil attend ${profile.accountId}`,
        );
      identityArn = identity.arn;
    } catch (err) {
      if (err instanceof AppError) throw err;
      audit.log({
        user: user.username,
        ip: req.ip,
        action: 'identifiants.ajout',
        profileId: profile.id,
        result: 'echec',
        details: { type: input.type },
      });
      throw stsFailure(err);
    }

    const warnings: string[] = [];
    if ((await hasWritePermissions(temp, identityArn)) === true)
      warnings.push('Ces identifiants ne sont pas en lecture seule');
    if (input.type === 'user') warnings.push('Préférez un rôle IAM dédié à des clés d’utilisateur IAM');

    if (input.type !== 'hub-role') {
      vault.putMemory(session.family, profile.id, temp, input.type as CredentialType, input.accessKeyId);
      if (
        (input.type === 'user' || input.type === 'user-role') &&
        input.remember &&
        auth.kind === 'access-keys'
      ) {
        vault.storeEncrypted(
          profile.id,
          auth.credentialRef,
          input.type,
          {
            accessKeyId: input.accessKeyId,
            secretAccessKey: input.secretAccessKey,
            ...(input.type === 'user-role' ? { roleArn: input.roleArn, externalId: input.externalId } : {}),
          },
          user.username,
        );
      }
    }
    if (JSON.stringify(auth) !== JSON.stringify(profile.auth)) saveProfile(ctx.db, { ...profile, auth });
    audit.log({
      user: user.username,
      ip: req.ip,
      action: 'identifiants.ajout',
      profileId: profile.id,
      result: 'succes',
      details: { type: input.type, memorise: 'remember' in input ? input.remember : false },
    });
    return { credentials: vault.info(session.family, { ...profile, auth }), warnings };
  });

  app.get<{ Params: { id: string } }>('/api/profiles/:id/credentials/status', async (req) => {
    const { profile } = editableProfile(ctx, req, req.params.id);
    requireElevated(req, reauth());
    return {
      credentials: vault.info(req.session?.family ?? '', profile),
      hubAvailable: config.hubCredentials === 'default-chain',
    };
  });

  app.post<{ Params: { id: string } }>('/api/profiles/:id/credentials/test', async (req) => {
    const { profile, user } = editableProfile(ctx, req, req.params.id);
    requireElevated(req, reauth());
    const creds = await vault.resolve(req.session?.family ?? '', profile);
    try {
      const identity = await getCallerIdentity(creds);
      audit.log({
        user: user.username,
        ip: req.ip,
        action: 'identifiants.test',
        profileId: profile.id,
        result: 'succes',
      });
      return {
        account: identity.account,
        arn: identity.arn,
        matches: identity.account === profile.accountId,
      };
    } catch (err) {
      audit.log({
        user: user.username,
        ip: req.ip,
        action: 'identifiants.test',
        profileId: profile.id,
        result: 'echec',
      });
      throw stsFailure(err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/profiles/:id/credentials', async (req) => {
    const { profile, user } = editableProfile(ctx, req, req.params.id);
    requireElevated(req, reauth());
    vault.forget(
      req.session?.family ?? '',
      profile.id,
      profile.auth.kind === 'access-keys' ? profile.auth.credentialRef : undefined,
    );
    audit.log({
      user: user.username,
      ip: req.ip,
      action: 'identifiants.suppression',
      profileId: profile.id,
      result: 'succes',
    });
    return { credentials: vault.info(req.session?.family ?? '', profile) };
  });

  // Lecture de l'état par un simple lecteur : jamais de détail.
  app.get<{ Params: { id: string } }>('/api/profiles/:id/credentials/available', async (req) => {
    const { profile } = visibleProfile(ctx, req, req.params.id);
    return { available: vault.info(req.session?.family ?? '', profile).length > 0 };
  });
}
