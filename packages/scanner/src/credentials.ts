import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import {
  AssumeRoleCommand,
  GetCallerIdentityCommand,
  GetSessionTokenCommand,
  STSClient,
} from '@aws-sdk/client-sts';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { Credentials } from './context.ts';

/**
 * Opérations STS / IAM utilisées pour valider et échanger les identifiants (section 4.3).
 * Uniquement GetCallerIdentity, AssumeRole, GetSessionToken et SimulatePrincipalPolicy (lecture).
 */

export interface TemporaryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

export interface CallerIdentity {
  account: string;
  arn: string;
  userId: string;
}

const STS_REGION = 'us-east-1';
const sts = (credentials: Credentials) => new STSClient({ region: STS_REGION, credentials, maxAttempts: 3 });

export async function getCallerIdentity(credentials: Credentials): Promise<CallerIdentity> {
  const out = await sts(credentials).send(new GetCallerIdentityCommand({}));
  if (!out.Account || !out.Arn) throw new Error('Réponse STS incomplète');
  return { account: out.Account, arn: out.Arn, userId: out.UserId ?? '' };
}

export const isRootArn = (arn: string) => /^arn:aws[a-z-]*:iam::\d{12}:root$/.test(arn);

function toTemporary(
  c:
    | {
        AccessKeyId?: string;
        SecretAccessKey?: string;
        SessionToken?: string;
        Expiration?: Date;
      }
    | undefined,
): TemporaryCredentials {
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
    throw new Error('Réponse STS sans identifiants temporaires');
  }
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration,
  };
}

export async function assumeRole(
  credentials: Credentials,
  roleArn: string,
  externalId: string | undefined,
  durationSeconds: number,
): Promise<TemporaryCredentials> {
  const out = await sts(credentials).send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `cartographe-${Date.now()}`,
      DurationSeconds: durationSeconds,
      ...(externalId ? { ExternalId: externalId } : {}),
    }),
  );
  return toTemporary(out.Credentials);
}

export async function getSessionToken(
  credentials: Credentials,
  durationSeconds: number,
): Promise<TemporaryCredentials> {
  const out = await sts(credentials).send(new GetSessionTokenCommand({ DurationSeconds: durationSeconds }));
  return toTemporary(out.Credentials);
}

/** Identité de l'outil lui-même (HUB_CREDENTIALS=default-chain : rôle d'instance ou de tâche). */
export const hubCredentials = (): Credentials => fromNodeProviderChain();

const WRITE_ACTIONS = [
  'ec2:RunInstances',
  'ec2:DeleteVpc',
  's3:PutObject',
  'iam:CreateUser',
  'iam:AttachRolePolicy',
  'rds:DeleteDBInstance',
  'lambda:UpdateFunctionCode',
];

/** ARN IAM à simuler : un rôle assumé devient l'ARN du rôle (sans chemin). */
export function principalForSimulation(callerArn: string): string | undefined {
  const assumed = /^arn:(aws[a-z-]*):sts::(\d{12}):assumed-role\/([^/]+)\//.exec(callerArn);
  if (assumed) return `arn:${assumed[1]}:iam::${assumed[2]}:role/${assumed[3]}`;
  return /^arn:aws[a-z-]*:iam::\d{12}:(user|role)\//.test(callerArn) ? callerArn : undefined;
}

/**
 * Vrai si la simulation montre des droits d'écriture ; undefined si la simulation est impossible
 * (iam:SimulatePrincipalPolicy refusé, rôle avec chemin…). Avertissement non bloquant.
 */
export async function hasWritePermissions(
  credentials: Credentials,
  callerArn: string,
): Promise<boolean | undefined> {
  const principal = principalForSimulation(callerArn);
  if (!principal) return undefined;
  try {
    const iam = new IAMClient({ region: STS_REGION, credentials, maxAttempts: 2 });
    const out = await iam.send(
      new SimulatePrincipalPolicyCommand({ PolicySourceArn: principal, ActionNames: WRITE_ACTIONS }),
    );
    return (out.EvaluationResults ?? []).some((r) => r.EvalDecision === 'allowed');
  } catch {
    return undefined;
  }
}
