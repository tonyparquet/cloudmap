import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureConfigDir } from '../src/config.ts';
import { ROOT } from './helpers.ts';

/**
 * Montée de version : une installation existante (CONFIG_DIR déjà peuplé) doit recevoir les
 * nouveaux fichiers de règles par défaut, sans que les fichiers modifiés par l'utilisateur soient
 * écrasés. Régression : avant, la copie était sautée dès que app.yaml existait → règles Azure
 * jamais ajoutées, ressources rendues en nœuds génériques.
 */
describe('ensureConfigDir (montée de version)', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('ajoute les règles manquantes et préserve les fichiers modifiés', () => {
    const configDir = mkdtempSync(join(ROOT, '.tmp', 'tests', 'cfg-'));
    dirs.push(configDir);
    // Installation d'une ancienne version : app.yaml présent, règles Azure absentes.
    mkdirSync(join(configDir, 'rules'), { recursive: true });
    writeFileSync(join(configDir, 'app.yaml'), '# réglages personnalisés\n');
    writeFileSync(join(configDir, 'rules', 'ec2.yaml'), 'type: Modifié::Par::Utilisateur\n');

    ensureConfigDir(configDir, ROOT);

    // Règle par défaut manquante ajoutée.
    expect(readFileSync(join(configDir, 'rules', 'azure-network.yaml'), 'utf8')).toContain('virtualnetworks');
    // app.yaml et règle modifiés par l'utilisateur intacts.
    expect(readFileSync(join(configDir, 'app.yaml'), 'utf8')).toBe('# réglages personnalisés\n');
    expect(readFileSync(join(configDir, 'rules', 'ec2.yaml'), 'utf8')).toBe(
      'type: Modifié::Par::Utilisateur\n',
    );
  });
});
