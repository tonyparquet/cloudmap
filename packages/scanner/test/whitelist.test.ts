import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Liste blanche SDK (section 0.3 et 16) : toute commande AWS importée par le code doit être une lecture.
 * Autorisées : Describe*, List*, Get*, BatchGet* (lectures par lot), plus la liste STS / IAM / Logs /
 * Resource Explorer / Config ci-dessous. Interdites explicitement : lecture de valeurs de secrets,
 * de paramètres (déchiffrés ou non) et d'objets S3.
 */
const READ_PREFIX = /^(Describe|List|Get|BatchGet)[A-Z]/;
const EXTRA_ALLOWED = new Set([
  'AssumeRole',
  'GetCallerIdentity',
  'GetSessionToken',
  'SimulatePrincipalPolicy',
  'StartQuery',
  'GetQueryResults',
  'Search',
  'SelectResourceConfig',
]);
const FORBIDDEN = new Set([
  'GetSecretValue',
  'BatchGetSecretValue',
  'GetParameter',
  'GetParameters',
  'GetParametersByPath',
  'GetParameterHistory',
  'GetObject',
  'GetObjectAttributes',
  'GetObjectTorrent',
  'GetRandomPassword',
]);

export function sdkCommandsIn(source: string): string[] {
  const names: string[] = [];
  const imports = source.matchAll(
    /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@aws-sdk\/client-[\w-]+['"]/g,
  );
  for (const m of imports) {
    for (const part of (m[1] ?? '').split(',')) {
      const original =
        part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]
          ?.trim() ?? '';
      const cmd = /^(\w+)Command$/.exec(original)?.[1] ?? /^paginate(\w+)$/.exec(original)?.[1];
      if (cmd) names.push(cmd);
    }
  }
  for (const m of source.matchAll(/new\s+(\w+)Command\s*\(/g)) if (m[1]) names.push(m[1]);
  return names;
}

export function violations(commands: string[]): string[] {
  return [...new Set(commands)].filter(
    (c) => FORBIDDEN.has(c) || !(READ_PREFIX.test(c) || EXTRA_ALLOWED.has(c)),
  );
}

function tsFiles(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out = out.concat(tsFiles(path));
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}

const root = fileURLToPath(new URL('../../../', import.meta.url));

describe('liste blanche des appels SDK', () => {
  it('détecte une commande interdite ou en écriture (contrôle du détecteur)', () => {
    const src = `import { GetSecretValueCommand, ListSecretsCommand } from '@aws-sdk/client-secrets-manager';
      import { PutObjectCommand as Put, paginateListBuckets } from '@aws-sdk/client-s3';
      new DeleteVpcCommand({});`;
    expect(sdkCommandsIn(src).sort()).toEqual([
      'DeleteVpc',
      'GetSecretValue',
      'ListBuckets',
      'ListSecrets',
      'PutObject',
    ]);
    expect(violations(sdkCommandsIn(src)).sort()).toEqual(['DeleteVpc', 'GetSecretValue', 'PutObject']);
  });

  it('aucune commande hors liste blanche dans les collecteurs, le serveur et la CLI', () => {
    const files = [
      'packages/scanner/src',
      'packages/security/src',
      'apps/server/src',
      'apps/cli/src',
    ].flatMap((d) => tsFiles(join(root, d)));
    const found = files.flatMap((f) => sdkCommandsIn(readFileSync(f, 'utf8')).map((c) => ({ c, f })));
    expect(found.length).toBeGreaterThan(60);
    const bad = violations(found.map((x) => x.c)).map((c) => `${c} (${found.find((x) => x.c === c)?.f})`);
    expect(bad).toEqual([]);
  });
});
