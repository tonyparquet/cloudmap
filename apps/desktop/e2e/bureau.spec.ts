import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
import { generate } from 'otplib';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const root = join(desktop, '..', '..');
const PASSWORD = 'Une-phrase-de-passe-solide-42';

test('application de bureau : serveur local TLS, compte puis MFA, démo, navigation verrouillée', async () => {
  const config = mkdtempSync(join(root, '.tmp', 'bureau-'));
  const app = await electron.launch({
    executablePath: join(desktop, 'node_modules', 'electron', 'dist', 'electron'),
    args: [join(desktop, 'dist', 'app'), '--lang=fr-FR'],
    env: { ...process.env, XDG_CONFIG_HOME: config, CLOUDMAP_DEMO: 'true' },
  });
  const win = await app.firstWindow();
  await expect(win).toHaveURL(/^https:\/\/127\.0\.0\.1:\d+\/login$/);

  // Premier lancement : création du compte administrateur (MFA facultatif), puis activation du MFA.
  await expect(win.getByRole('button', { name: 'Continuer sans compte' })).toBeVisible();
  await win.fill('input[name=username]', 'admin');
  await win.fill('input[name=password]', PASSWORD);
  await win.fill('input[name=confirm]', PASSWORD);
  await win.getByRole('button', { name: 'Créer un compte' }).click();
  await expect(win).toHaveURL(/\/profils$/);
  await win.getByRole('link', { name: 'Mon compte' }).click();
  await win.getByRole('button', { name: 'Activer la double authentification' }).click();
  // Ré-authentification par mot de passe (pas encore de MFA).
  await win.getByRole('dialog').locator('input[type=password]').fill(PASSWORD);
  await win.getByRole('dialog').getByRole('button', { name: 'Confirmer' }).click();
  const secret = (await win.getByTestId('totp-secret').textContent())?.trim() ?? '';
  await win.fill('input[name=code]', await generate({ secret }));
  await win.getByRole('button', { name: 'Activer', exact: true }).click();
  // Bouton « Copier » des codes de secours : le presse-papiers reçoit bien les codes.
  const codes = await win.getByTestId('codes-secours').locator('span').allTextContents();
  await win.getByRole('button', { name: 'Copier', exact: true }).click();
  await expect(win.getByRole('button', { name: 'Copié' })).toBeVisible();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(codes.join('\n'));
  // Lecture du presse-papiers par script : toujours refusée.
  expect(
    await win.evaluate(() =>
      navigator.clipboard.readText().then(
        () => 'lu',
        () => 'refusé',
      ),
    ),
  ).toBe('refusé');
  await win.getByRole('button', { name: 'Terminé' }).click();
  await win.getByRole('link', { name: 'Profils' }).first().click();
  await win
    .getByTestId('profil')
    .filter({ hasText: 'Démo' })
    .getByRole('link', { name: 'Diagramme' })
    .click();
  await expect(win.locator('[data-testid=noeud][data-label="CloudFront"]')).toBeVisible();

  // Navigation verrouillée : aucune autre origine dans la fenêtre, aucune nouvelle fenêtre.
  const origin = new URL(win.url()).origin;
  await win.evaluate(() => {
    window.location.href = 'http://exemple.invalid/';
  });
  await win.waitForTimeout(500);
  expect(new URL(win.url()).origin).toBe(origin);
  await win.evaluate(() => window.open('http://exemple.invalid/'));
  await win.waitForTimeout(500);
  expect(app.windows()).toHaveLength(1);

  // Fenêtre isolée : aucun accès à Node depuis l'interface.
  expect(await win.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe('undefined');
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return w?.webContents.getLastWebPreferences();
  });
  expect(prefs).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false });
  await app.close();
});
