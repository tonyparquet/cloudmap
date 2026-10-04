import jsonata from 'jsonata';
import { parseAllDocuments } from 'yaml';
import { z } from 'zod';
import { edgeKindSchema, statusSchema, type RawSnapshot, type Resource } from './schemas.ts';

/**
 * Catalogue de règles déclaratif (section 6). Une chaîne est une expression JSONata si elle référence
 * `$r` / `$all` ou commence par `$` ou `(` ; sinon c'est un libellé littéral.
 * Liaisons disponibles : `$r` (ressource), `$all` (snapshot), `$ofType(type)`, `$byId(id)`.
 */

export const RESOLVERS = [
  'arn',
  'id',
  'ecr-image',
  'dns-name',
  's3-bucket',
  'security-group',
  'target-group-targets',
] as const;
export type Resolver = (typeof RESOLVERS)[number];

const expr = z.string().min(1).max(4000);

export const ruleSchema = z.strictObject({
  type: z.string().regex(/^[\w:.*/-]{1,256}$/, 'Type invalide'),
  typeLabel: z.string().max(80).optional(),
  label: expr,
  sublabel: expr.optional(),
  icon: z.string().regex(/^[\w-]{1,40}$/),
  category: z.string().regex(/^[\w-]{1,40}$/),
  hidden: z.boolean().optional(),
  placement: z
    .strictObject({
      container: z.enum(['none', 'global', 'region', 'vpc', 'az', 'subnet']),
      ref: expr.optional(),
      /** Repli si `ref` ne désigne aucun sous-réseau connu (ex. endpoint passerelle → VPC). */
      vpcRef: expr.optional(),
      multi: z.enum(['replicate', 'first']).optional(),
    })
    .optional(),
  securityGroups: expr.optional(),
  ips: expr.optional(),
  dnsNames: expr.optional(),
  awsService: z
    .string()
    .regex(/^[\w.-]{1,64}$/)
    .optional(),
  status: z
    .array(
      z.union([
        z.strictObject({ when: expr, value: statusSchema }),
        z.strictObject({ default: statusSchema }),
      ]),
    )
    .optional(),
  relations: z
    .array(
      z.strictObject({
        kind: edgeKindSchema,
        to: expr,
        resolve: z.enum(RESOLVERS).optional(),
        label: z.string().max(80).optional(),
        reverse: z.boolean().optional(),
        unresolved: z.enum(['ignore', 'external']).optional(),
        externalType: z
          .string()
          .regex(/^External::\w+$/)
          .optional(),
      }),
    )
    .optional(),
  group: z.strictObject({ key: expr }).optional(),
  console: expr.optional(),
  details: z.record(z.string().max(60), expr).optional(),
});
export type Rule = z.infer<typeof ruleSchema>;

export interface RuleError {
  file: string;
  index?: number;
  type?: string;
  message: string;
}

export interface RuleSet {
  byType: Map<string, Rule>;
  /** Règles à joker (`AWS::DMS::*`), triées du préfixe le plus long au plus court. */
  wildcards: Rule[];
  errors: RuleError[];
  files: { file: string; types: string[] }[];
  exprs: Map<string, jsonata.Expression>;
}

export function isExpression(s: string): boolean {
  return /\$(r|all)\b/.test(s) || /^\s*[$(]/.test(s);
}

function ruleExpressions(rule: Rule): string[] {
  const out = [rule.label, rule.sublabel, rule.securityGroups, rule.ips, rule.dnsNames, rule.console];
  out.push(rule.placement?.ref, rule.placement?.vpcRef, rule.group?.key);
  for (const s of rule.status ?? []) if ('when' in s) out.push(s.when);
  for (const r of rule.relations ?? []) out.push(r.to);
  out.push(...Object.values(rule.details ?? {}));
  return out.filter((s): s is string => typeof s === 'string' && isExpression(s));
}

function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');
}

/** Charge et valide les fichiers de règles ; une règle invalide est ignorée et signalée. */
export function parseRules(files: { name: string; content: string }[]): RuleSet {
  const set: RuleSet = { byType: new Map(), wildcards: [], errors: [], files: [], exprs: new Map() };
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const types: string[] = [];
    let items: unknown[] = [];
    try {
      for (const doc of parseAllDocuments(file.content)) {
        if (doc.errors.length) throw doc.errors[0];
        const value: unknown = doc.toJS({ maxAliasCount: 500 });
        if (Array.isArray(value)) items.push(...value);
        else if (value && typeof value === 'object' && Array.isArray((value as { rules?: unknown }).rules)) {
          items.push(...(value as { rules: unknown[] }).rules);
        } else if (value !== null && value !== undefined) items.push(value);
      }
    } catch (err) {
      set.errors.push({ file: file.name, message: `YAML invalide : ${(err as Error).message}` });
      items = [];
    }
    items.forEach((item, index) => {
      const parsed = ruleSchema.safeParse(item);
      const type = (item as { type?: unknown } | null)?.type;
      if (!parsed.success) {
        set.errors.push({
          file: file.name,
          index,
          type: typeof type === 'string' ? type : undefined,
          message: zodMessage(parsed.error),
        });
        return;
      }
      const rule = parsed.data;
      const compiled = new Map<string, jsonata.Expression>();
      try {
        for (const source of ruleExpressions(rule)) {
          if (!set.exprs.has(source) && !compiled.has(source)) compiled.set(source, jsonata(source));
        }
      } catch (err) {
        const e = err as { message?: string; position?: number };
        set.errors.push({
          file: file.name,
          index,
          type: rule.type,
          message: `Expression JSONata invalide : ${e.message ?? String(err)}`,
        });
        return;
      }
      for (const [k, v] of compiled) set.exprs.set(k, v);
      if (set.byType.has(rule.type) || set.wildcards.some((w) => w.type === rule.type)) {
        set.errors.push({ file: file.name, index, type: rule.type, message: 'Type déjà défini : remplacé' });
      }
      if (rule.type.endsWith('*')) {
        set.wildcards = set.wildcards.filter((w) => w.type !== rule.type);
        set.wildcards.push(rule);
      } else set.byType.set(rule.type, rule);
      types.push(rule.type);
    });
    set.files.push({ file: file.name, types });
  }
  set.wildcards.sort((a, b) => b.type.length - a.type.length);
  return set;
}

export function findRule(set: RuleSet, type: string): Rule | undefined {
  return set.byType.get(type) ?? set.wildcards.find((w) => type.startsWith(w.type.slice(0, -1)));
}

function flatten(value: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) for (const v of value) flatten(v, out);
  else if (value !== undefined && value !== null) out.push(value);
  return out;
}

/** Évalue les expressions des règles sur une ressource ; les erreurs deviennent des avertissements. */
export class Evaluator {
  private readonly bindings: Record<string, unknown>;

  constructor(
    snapshot: RawSnapshot,
    resources: Resource[],
    private readonly rules: RuleSet,
    private readonly warnings: Set<string>,
  ) {
    const byType = new Map<string, Resource[]>();
    const byId = new Map<string, Resource>();
    for (const r of resources) {
      byType.set(r.type, [...(byType.get(r.type) ?? []), r]);
      byId.set(r.id, r);
      if (r.arn) byId.set(r.arn, r);
    }
    this.bindings = {
      all: snapshot,
      ofType: (t: string) => byType.get(t) ?? [],
      byId: (id: string) => byId.get(id),
    };
  }

  async value(source: string | undefined, r: Resource): Promise<unknown> {
    if (source === undefined) return undefined;
    if (!isExpression(source)) return source;
    const compiled = this.rules.exprs.get(source) ?? jsonata(source);
    try {
      return await compiled.evaluate(r, { ...this.bindings, r });
    } catch (err) {
      this.warnings.add(`Règle ${r.type} : erreur d'évaluation « ${source} » : ${(err as Error).message}`);
      return undefined;
    }
  }

  async str(source: string | undefined, r: Resource): Promise<string | undefined> {
    const first = flatten(await this.value(source, r))[0];
    if (first === undefined) return undefined;
    return typeof first === 'string'
      ? first
      : typeof first === 'object'
        ? JSON.stringify(first)
        : String(first);
  }

  async strings(source: string | undefined, r: Resource): Promise<string[]> {
    const values = flatten(await this.value(source, r)).filter(
      (v): v is string => typeof v === 'string' && v !== '',
    );
    return [...new Set(values)];
  }

  async bool(source: string, r: Resource): Promise<boolean> {
    const v = await this.value(source, r);
    return Array.isArray(v) ? v.length > 0 && v.some(Boolean) : Boolean(v);
  }
}
