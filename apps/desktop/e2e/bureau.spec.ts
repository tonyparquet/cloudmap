import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
import { generate } from 'otplib';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const root = join(desktop, '..', '..');
const PASSWORD = 'Une-phrase-de-passe-solide-42';

test('application de bureau : serveur local TLS, compte + TOTP, démo, navigation verrouillée', async () => {
  const config = mkdtempSync(join(root, '.tmp', 'bureau-'));
  const app = await electron.launch({
    executablePath: join(desktop, 'node_modules', 'electron', 'dist', 'electron'),
    args: [join(desktop, 'dist', 'app')],
    env: { ...process.env, XDG_CONFIG_HOME: config, CLOUDMAP_DEMO: 'true' },
  });
  const win = await app.firstWindow();
  await expect(win).toHaveURL(/^https:\/\/127\.0\.0\.1:\d+\/login$/);

  // Premier lancement : administrateur local + TOTP obligatoire, comme la version serveur.
  await win.fill('input[name=username]', 'admin');
  await win.fill('input[name=password]', PASSWORD);
  await win.fill('input[name=confirm]', PASSWORD);
  await win.getByRole('button', { name: 'Créer' }).click();
  const secret = (await win.getByTestId('totp-secret').textContent())?.trim() ?? '';
  await win.fill('input[name=code]', await generate({ secret }));
  await win.getByRole('button', { name: 'Activer' }).click();
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
  await win.getByRole('button', { name: "Continuer vers l'application" }).click();
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
