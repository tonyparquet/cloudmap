import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { generate } from 'otplib';

const ADMIN = { username: 'admin', password: 'Une-phrase-de-passe-solide-42' };

test('parcours démo : connexion admin + TOTP, diagramme, panneau, filtre, export SVG', async ({ page }) => {
  const cspErrors: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) cspErrors.push(m.text());
  });

  // Premier démarrage : création de l'administrateur puis enrôlement TOTP obligatoire.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.fill('input[name=username]', ADMIN.username);
  await page.fill('input[name=password]', ADMIN.password);
  await page.fill('input[name=confirm]', ADMIN.password);
  await page.getByRole('button', { name: 'Créer' }).click();
  const secret = (await page.getByTestId('totp-secret').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await page.fill('input[name=code]', await generate({ secret }));
  await page.getByRole('button', { name: 'Activer' }).click();
  await expect(page.getByTestId('codes-secours').locator('span')).toHaveCount(10);
  await page.getByRole('button', { name: "Continuer vers l'application" }).click();

  // Profil Démo et diagramme de la section 9.5.
  const profil = page.getByTestId('profil').filter({ hasText: 'Démo' });
  await expect(profil).toBeVisible();
  await profil.getByRole('link', { name: 'Diagramme' }).click();
  await expect(page.getByTestId('diagramme')).toBeVisible();
  const node = (label: string) => page.locator(`[data-testid=noeud][data-label="${label}"]`);
  for (const label of [
    'GitLab',
    'Navigateur',
    'CloudFront',
    'API Gateway',
    'S3 front',
    'Cloud Map',
    'CodeBuild',
    'ECR',
    'Secrets',
    'Endpoint S3',
    'RDS',
    'Migration',
    'Tâche ECS',
    'IGW',
  ]) {
    await expect(node(label)).toBeVisible();
  }
  await expect(node('Lien VPC')).toHaveCount(2);
  await expect(page.locator('[data-testid=conteneur][data-kind=vpc]')).toHaveCount(1);
  await expect(page.locator('[data-testid=conteneur][data-kind=subnet-public]')).toHaveCount(2);
  await expect(page.locator('[data-testid=conteneur][data-kind=subnet-private]')).toHaveCount(2);
  await expect(page.getByTestId('etiquette-arete').filter({ hasText: 'TCP 5432' }).first()).toBeVisible();
  await expect(node('CloudFront')).toHaveAttribute('data-status', 'actif');
  await expect(page.locator('.react-flow__edge-path.edge-cicd').first()).toBeAttached();

  // Clic sur un nœud : panneau latéral.
  await node('RDS').click();
  const panel = page.getByTestId('panneau');
  await expect(panel).toContainText('Base RDS');
  await expect(panel).toContainText('arrêté');
  await expect(panel).toContainText('sg-0de00000000000db5');
  await panel.getByRole('button', { name: 'Fermer' }).click();

  // Filtre : masquer les nœuds arrêtés.
  await page.getByRole('button', { name: 'Filtres' }).click();
  await page.getByTestId('filtres').getByLabel('arrêté').uncheck();
  await expect(node('RDS')).toHaveCount(0);
  await expect(node('CloudFront')).toBeVisible();
  await page.getByTestId('filtres').getByLabel('arrêté').check();
  await expect(node('RDS')).toBeVisible();
  await page.getByRole('button', { name: 'Filtres' }).click();

  // Export SVG.
  await page.getByRole('button', { name: 'Exporter' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'SVG' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^Démo-\d{4}-\d{2}-\d{2}\.svg$/);
  const svg = readFileSync(await download.path(), 'utf8');
  expect(svg).toContain('<svg');
  expect(svg).toContain('Tâche ECS');

  // Autres exports : PNG (2×), PDF, draw.io, JSON du graphe.
  const exportAs = async (label: string) => {
    await page.getByRole('button', { name: 'Exporter' }).click();
    const [d] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: label, exact: true }).click(),
    ]);
    return readFileSync(await d.path());
  };
  expect((await exportAs('PNG (2×)')).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect((await exportAs('PDF')).subarray(0, 5).toString()).toBe('%PDF-');
  const drawio = (await exportAs('draw.io')).toString();
  expect(drawio).toContain('<mxfile');
  expect(drawio).toContain('TCP 5432');
  const json = JSON.parse((await exportAs('JSON du graphe')).toString()) as {
    nodes: unknown[];
    containers: unknown[];
  };
  expect(json.nodes.length).toBeGreaterThanOrEqual(16);
  expect(json.containers.length).toBe(9);

  expect(cspErrors).toEqual([]);
});
