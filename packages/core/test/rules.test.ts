import { describe, expect, it } from 'vitest';
import { Evaluator, findRule, isExpression, parseRules, type RawSnapshot } from '../src/index.ts';

function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`${what} introuvable`);
  return v;
}

const snapshot: RawSnapshot = {
  schemaVersion: 1,
  meta: {
    profileId: 'p',
    accountId: '000000000000',
    regions: ['xx-test-1'],
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:01:00Z',
    scannerVersion: 'test',
  },
  resources: [
    {
      id: 'svc-1',
      type: 'Test::Svc',
      region: 'xx-test-1',
      raw: { name: 'api', running: 2, desired: 3, list: ['a', 'b'] },
    },
  ],
  errors: [],
};

describe('moteur de règles', () => {
  it('distingue expressions et libellés littéraux', () => {
    expect(isExpression('Tâche ECS')).toBe(false);
    expect(isExpression('$r.raw.serviceName')).toBe(true);
    expect(isExpression("$string($r.raw.x) & ' tâche'")).toBe(true);
    expect(isExpression('$all.resources[0].id')).toBe(true);
  });

  it('charge plusieurs documents et listes, ignore une règle invalide sans planter', () => {
    const set = parseRules([
      {
        name: 'a.yaml',
        content: `
- type: Test::Svc
  label: "$r.raw.name"
  icon: ecs
  category: compute
- type: Test::Bad
  label: x
  icon: ecs
  category: compute
  inconnu: true
---
type: Test::Other
label: Autre
icon: generic
category: generic
`,
      },
      { name: 'b.yaml', content: 'type: Test::Expr\nlabel: "$r.raw.("\nicon: x\ncategory: y\n' },
      { name: 'c.yaml', content: 'type: [cassé' },
      {
        name: 'd.yaml',
        content:
          'rules:\n  - type: "AWS::DMS::*"\n    label: DMS\n    icon: database\n    category: database\n',
      },
    ]);
    expect([...set.byType.keys()].sort()).toEqual(['Test::Other', 'Test::Svc']);
    expect(set.errors.map((e) => e.file).sort()).toEqual(['a.yaml', 'b.yaml', 'c.yaml']);
    expect(set.errors.find((e) => e.file === 'b.yaml')?.message).toMatch(/JSONata/);
    expect(findRule(set, 'AWS::DMS::ReplicationInstance')?.label).toBe('DMS');
    expect(findRule(set, 'AWS::Nope')).toBeUndefined();
  });

  it('évalue les expressions avec $r, $all et $ofType', async () => {
    const set = parseRules([
      {
        name: 'svc.yaml',
        content: `
type: Test::Svc
label: "$r.raw.name"
sublabel: "$string($r.raw.running) & '/' & $string($r.raw.desired) & ' tâche'"
icon: ecs
category: compute
details:
  total: "$count($all.resources)"
  memes: "$count($ofType('Test::Svc'))"
`,
      },
    ]);
    const warnings = new Set<string>();
    const ev = new Evaluator(snapshot, snapshot.resources, set, warnings);
    const r = must(snapshot.resources[0], 'ressource');
    const rule = must(findRule(set, 'Test::Svc'), 'règle');
    expect(await ev.str(rule.label, r)).toBe('api');
    expect(await ev.str(rule.sublabel, r)).toBe('2/3 tâche');
    expect(await ev.value(rule.details?.total, r)).toBe(1);
    expect(await ev.value(rule.details?.memes, r)).toBe(1);
    expect(await ev.strings('$r.raw.list', r)).toEqual(['a', 'b']);
    expect(await ev.str('Libellé fixe', r)).toBe('Libellé fixe');
    expect(warnings.size).toBe(0);
  });

  it('transforme une erreur d’évaluation en avertissement', async () => {
    const set = parseRules([]);
    const warnings = new Set<string>();
    const ev = new Evaluator(snapshot, snapshot.resources, set, warnings);
    expect(
      await ev.value('$number("pas un nombre")', must(snapshot.resources[0], 'ressource')),
    ).toBeUndefined();
    expect([...warnings][0]).toMatch(/erreur d'évaluation/);
  });
});
