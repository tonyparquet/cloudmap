import { z } from 'zod';

export const STATUSES = ['actif', 'en-veille', 'arrete', 'erreur', 'inconnu'] as const;
export const EDGE_KINDS = ['network', 'cicd', 'data', 'dependency'] as const;
export const EDGE_STATES = ['autorise', 'observe', 'bloque', 'non-explique', 'inutilise'] as const;
export const CONTAINER_KINDS = [
  'account',
  'global',
  'region',
  'vpc',
  'az',
  'subnet-public',
  'subnet-private',
  'org',
  'ou',
] as const;

export const statusSchema = z.enum(STATUSES);
export const edgeKindSchema = z.enum(EDGE_KINDS);
export type NodeStatus = z.infer<typeof statusSchema>;
export type EdgeKind = z.infer<typeof edgeKindSchema>;
export type EdgeState = (typeof EDGE_STATES)[number];
export type ContainerKind = (typeof CONTAINER_KINDS)[number];

export const accountIdSchema = z.string().regex(/^\d{12}$/, 'ID de compte AWS : 12 chiffres');
export const regionSchema = z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/, 'Code de région AWS invalide');
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Date ISO 8601 attendue');

// ---------------------------------------------------------------- Snapshot brut (section 5.3)

export const resourceSchema = z.strictObject({
  arn: z.string().max(2048).optional(),
  id: z.string().min(1).max(2048),
  type: z.string().min(1).max(256),
  region: z.string().min(1).max(64),
  raw: z.unknown(),
  tags: z.record(z.string(), z.string()).optional(),
  /** Compte d'origine : renseigné uniquement dans une vue multi-comptes (snapshots fusionnés). */
  account: z
    .string()
    .regex(/^\d{12}$/)
    .optional(),
});
export type Resource = z.infer<typeof resourceSchema>;

export const rawSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  meta: z.strictObject({
    profileId: z.string().min(1).max(200),
    accountId: accountIdSchema,
    regions: z.array(z.string().max(64)),
    startedAt: isoDate,
    finishedAt: isoDate,
    scannerVersion: z.string().max(64),
  }),
  resources: z.array(resourceSchema),
  metrics: z
    .array(
      z.strictObject({
        resourceId: z.string(),
        name: z.string(),
        value: z.number(),
        period: z.string(),
      }),
    )
    .optional(),
  flowObservations: z
    .array(
      z.strictObject({
        srcIp: z.string(),
        dstIp: z.string(),
        dstPort: z.number().int(),
        protocol: z.string(),
        bytes: z.number(),
        packets: z.number(),
      }),
    )
    .optional(),
  probes: z
    .array(
      z.strictObject({
        url: z.string(),
        status: z.number().int().optional(),
        latencyMs: z.number().optional(),
        error: z.string().optional(),
      }),
    )
    .optional(),
  errors: z.array(
    z.strictObject({ service: z.string(), region: z.string(), code: z.string(), message: z.string() }),
  ),
});
export type RawSnapshot = z.infer<typeof rawSnapshotSchema>;

// ---------------------------------------------------------------- Profils (section 3.3)

export const roleArnSchema = z
  .string()
  .regex(/^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/, 'ARN de rôle IAM invalide');
export const externalIdSchema = z.string().regex(/^[\w+=,.@:/-]{2,1224}$/, 'External ID invalide');

export const profileAuthSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('assume-role-hub'),
    roleArn: roleArnSchema,
    externalId: externalIdSchema,
  }),
  z.strictObject({
    kind: z.literal('access-keys'),
    credentialRef: z.string().min(1).max(100),
    roleArn: roleArnSchema.optional(),
    externalId: externalIdSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('import-only') }),
  // Rôle d'un compte membre assumé avec les identifiants d'un autre profil (hub d'organisation).
  z.strictObject({
    kind: z.literal('assume-role-profile'),
    parentProfileId: z.string().regex(/^[\w-]{1,64}$/),
    roleArn: roleArnSchema,
    externalId: externalIdSchema,
  }),
]);

const shortText = (max: number) => z.string().trim().min(1).max(max);

export const externalNodeSchema = z.strictObject({
  id: z.string().regex(/^[\w.-]{1,64}$/, 'Identifiant : lettres, chiffres, . _ -'),
  label: shortText(80),
  sublabel: z.string().max(80).optional(),
  icon: z.string().regex(/^[\w-]{1,40}$/),
  linksTo: z.array(z.string().max(2048)).max(50).optional(),
});

export const probeSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).max(2048),
  attachTo: z.string().max(2048).optional(),
  allowHttp: z.boolean().optional(),
  allowPrivate: z.boolean().optional(),
});

export const profileSchema = z.strictObject({
  id: z.string().regex(/^[\w-]{1,64}$/),
  name: shortText(100),
  client: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  accountId: accountIdSchema,
  regions: z.array(regionSchema).max(40),
  auth: profileAuthSchema,
  tagFilters: z
    .array(z.strictObject({ key: shortText(128), values: z.array(z.string().max(256)).max(50) }))
    .max(20)
    .optional(),
  externalNodes: z.array(externalNodeSchema).max(50).optional(),
  probes: z.array(probeSchema).max(50).optional(),
  flowLogs: z
    .strictObject({
      enabled: z.boolean(),
      logGroups: z.array(z.string().max(512)).max(20).optional(),
      lookbackHours: z.number().int().min(1).max(720),
    })
    .optional(),
  allowedGroups: z.array(z.string().regex(/^[\w.-]{1,64}$/)).max(50),
});
export type Profile = z.infer<typeof profileSchema>;
export type ProfileAuth = z.infer<typeof profileAuthSchema>;
export type ExternalNode = z.infer<typeof externalNodeSchema>;

// ---------------------------------------------------------------- Graphe normalisé (section 8)

export interface GraphContainer {
  id: string;
  kind: ContainerKind;
  label: string;
  sublabel?: string;
  parentId?: string;
}

export interface GraphNode {
  id: string;
  resourceRef?: string;
  type: string;
  label: string;
  sublabel?: string;
  icon: string;
  category: string;
  status: NodeStatus;
  containerId?: string;
  groupCount?: number;
  details: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
  state: EdgeState;
  evidence: string[];
  /** Volume observé (Flow Logs), utilisé pour l'épaisseur du trait. */
  bytes?: number;
  /** Étiquette affichée seulement quand une extrémité est sélectionnée (arêtes très nombreuses). */
  labelOnFocus?: boolean;
}

export interface Graph {
  containers: GraphContainer[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
}
