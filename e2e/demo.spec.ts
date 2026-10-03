import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { generate } from 'otplib';

const ADMIN = { username: 'admin', password: 'Une-phrase-de-passe-solide-42' };
// Codes de secours du premier test : le second s'en sert pour se reconnecter (un code TOTP déjà
// utilisé est refusé pendant sa fenêtre, protection anti-rejeu).
let recoveryCodes: string[] = [];

test.describe.configure({ mode: 'serial' });

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
  recoveryCodes = await page.getByTestId('codes-secours').locator('span').allTextContents();
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

test('mise en route : nouveau profil, import du premier snapshot, diagramme', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=username]', ADMIN.username);
  await page.fill('input[name=password]', ADMIN.password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.fill('input[name=code]', recoveryCodes[0] ?? '');
  await page.getByRole('button', { name: 'Vérifier' }).click();

  // Aucun compte hors démo : carte d'accueil.
  await page.getByRole('link', { name: 'Ajouter un compte AWS' }).click();
  await page.getByLabel('Nom', { exact: true }).fill('Compte E2E');
  const account = page.getByLabel('ID du compte AWS');
  await account.fill('0000-0000-0000');
  await expect(account).toHaveValue('000000000000');
  await page.getByPlaceholder('Filtrer les régions…').fill('west-3');
  await page.getByLabel('eu-west-3', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Retirer eu-west-3' })).toBeVisible();
  await page.getByRole('radio', { name: /Imports uniquement/ }).check();
  await page.getByRole('button', { name: 'Créer et continuer' }).click();

  // Assistant : import du snapshot puis ouverture automatique du diagramme.
  await expect(page).toHaveURL(/\/profils\/[\w-]+\/demarrage$/);
  await expect(page.getByTestId('etapes').locator('li.current')).toHaveText(/Import du snapshot/);
  await page.getByLabel('Fichier snapshot (.json)').setInputFiles('fixtures/demo-snapshot.json');
  await expect(page).toHaveURL(/\/diagramme$/);
  await expect(page.locator('[data-testid=noeud][data-label="CloudFront"]')).toBeVisible();

  // La carte du profil résume le dernier scan.
  await page.getByRole('navigation', { name: "Fil d'Ariane" }).getByRole('link', { name: 'Profils' }).click();
  await expect(page.getByTestId('profil').filter({ hasText: 'Compte E2E' })).toContainText('Dernier scan');
});

test('vue Organisation : OU, comptes, panneau et export draw.io', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=username]', ADMIN.username);
  await page.fill('input[name=password]', ADMIN.password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.fill('input[name=code]', recoveryCodes[1] ?? '');
  await page.getByRole('button', { name: 'Vérifier' }).click();

  await page
    .getByTestId('profil')
    .filter({ hasText: 'Démo' })
    .getByRole('link', { name: 'Diagramme' })
    .click();
  const node = (label: string) => page.locator(`[data-testid=noeud][data-label="${label}"]`);
  await expect(node('CloudFront')).toBeVisible();
  await page.getByRole('button', { name: 'Organisation' }).click();

  await expect(page.locator('[data-testid=conteneur][data-kind=org]')).toHaveCount(1);
  await expect(page.locator('[data-testid=conteneur][data-kind=ou]')).toHaveCount(4);
  for (const label of [
    'gestion',
    'production',
    'production-eu',
    'Administrateurs',
    'RegionsEurope',
    'PerimetreDonnees',
  ])
    await expect(node(label)).toBeVisible();
  await expect(node('CloudFront')).toHaveCount(0);
  await expect(node('bac-a-sable')).toHaveAttribute('data-status', 'arrete');

  await node('production-eu').click();
  const panel = page.getByTestId('panneau');
  await expect(panel).toContainText('Politiques héritées');
  await expect(panel).toContainText('RegionsEurope (SCP)');
  await expect(panel).toContainText('PerimetreDonnees (RCP)');
  await panel.getByRole('button', { name: 'Fermer' }).click();

  await page.getByRole('button', { name: 'Exporter' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'draw.io', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^Démo-organisation-\d{4}-\d{2}-\d{2}\.drawio$/);
  const drawio = readFileSync(await download.path(), 'utf8');
  expect(drawio).toContain('<mxfile');
  for (const ou of ['Socle', 'Production', 'Europe', 'Bac à sable']) expect(drawio).toContain(ou);

  // Comptes de l'organisation : liste issue du snapshot ; la démo (imports uniquement) ne peut pas servir de hub.
  await page.getByRole('link', { name: 'Profils des comptes…' }).click();
  await expect(page.getByTestId('comptes-org').locator('label')).toHaveCount(5);
  await expect(page.getByText('Ce profil ne peut pas servir de hub')).toBeVisible();
  await expect(page.getByText('OrganizationalUnitIds=r-')).toBeVisible();
  await page.getByRole('link', { name: 'Diagramme' }).click();
  await page.getByRole('button', { name: 'Organisation' }).click();

  await page.getByRole('button', { name: 'Infrastructure' }).click();
  await expect(node('CloudFront')).toBeVisible();
});

test('vue multi-comptes : deux comptes fictifs, appairage, Transit Gateway partagé, export draw.io', async ({
  page,
}) => {
  await page.goto('/');
  await page.fill('input[name=username]', ADMIN.username);
  await page.fill('input[name=password]', ADMIN.password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.fill('input[name=code]', recoveryCodes[2] ?? '');
  await page.getByRole('button', { name: 'Vérifier' }).click();

  await page.getByRole('link', { name: 'Multi-comptes' }).click();
  const choix = page.getByTestId('choix-comptes');
  await choix.getByRole('checkbox', { name: /^Démo/ }).check();
  await choix.getByRole('checkbox', { name: /^Partenaire/ }).check();
  await page.getByRole('button', { name: 'Afficher le diagramme (2 profil(s))' }).click();

  await expect(page.locator('[data-testid=conteneur][data-kind=account]')).toHaveCount(2);
  await expect(page.locator('[data-testid=conteneur][data-kind=vpc]')).toHaveCount(2);
  const node = (label: string) => page.locator(`[data-testid=noeud][data-label="${label}"]`);
  await expect(node('service-partenaire')).toBeVisible();
  await expect(node('tgw-central')).toHaveCount(1);
  await expect(node('CloudFront')).toBeVisible();
  await expect(page.getByTestId('etiquette-arete').filter({ hasText: 'appairage' })).toBeVisible();

  await page.getByRole('button', { name: 'Exporter' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'draw.io', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^multi-comptes-.*\.drawio$/);
  const drawio = readFileSync(await download.path(), 'utf8');
  expect(drawio).toContain('Partenaire');
  expect(drawio).toContain('appairage');
});
