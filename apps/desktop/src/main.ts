import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu, safeStorage, session, shell } from 'electron';
import { loadConfig, StartupError } from '../../server/src/config.ts';
import { startServer } from '../../server/src/start.ts';
import { loadOrCreateMasterKey } from './keystore.ts';
import { ensureLocalCert, isAppUrl, isExternalHttps, isPinned, LOOPBACK, pickPort } from './security.ts';

/**
 * Application de bureau : le serveur Cartographe AWS tourne dans le processus principal, en HTTPS
 * TLS 1.3 sur 127.0.0.1 uniquement ; la fenêtre n'accepte que le certificat de cette installation.
 * Authentification locale + TOTP, CSP, CSRF, chiffrement des identifiants : identiques au serveur.
 */
const PREFERRED_PORT = 48_443;
const TITLE = 'Cartographe AWS';

let server: { close: () => Promise<void> } | undefined;
let origin = '';
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.enableSandbox();

function fail(message: string): void {
  dialog.showErrorBox(TITLE, message);
  app.exit(1);
}

/** Ressources (interface construite, règles, icônes, fixtures, docs/iam) : hors archive asar une fois empaquetée. */
const appRoot = () =>
  app.isPackaged ? join(process.resourcesPath, 'carto') : join(app.getAppPath(), 'carto');

async function start(): Promise<void> {
  const userData = app.getPath('userData');
  const dirs = {
    data: join(userData, 'donnees'),
    config: join(userData, 'configuration'),
    tls: join(userData, 'tls'),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });

  const { key } = loadOrCreateMasterKey(userData, {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    ...(process.platform === 'linux' ? { backend: safeStorage.getSelectedStorageBackend() } : {}),
    encryptString: (s) => safeStorage.encryptString(s),
    decryptString: (b) => safeStorage.decryptString(b),
  });
  const tls = await ensureLocalCert(dirs.tls);
  const port = await pickPort(PREFERRED_PORT);
  origin = `https://${LOOPBACK}:${port}`;

  // Environnement explicite : rien n'est hérité de celui de l'utilisateur (pas de HUB_CREDENTIALS…).
  const config = loadConfig(
    {
      TLS_CERT_FILE: tls.certFile,
      TLS_KEY_FILE: tls.keyFile,
      PUBLIC_ORIGIN: origin,
      PORT: String(port),
      HOST: LOOPBACK,
      CONFIG_DIR: dirs.config,
      DATA_DIR: dirs.data,
      APP_ROOT: appRoot(),
      AUTH_MODE: 'local',
      HUB_CREDENTIALS: 'none',
      LOG_LEVEL: 'info',
      DEMO_MODE: process.env.CARTO_DEMO === 'true' ? 'true' : 'false',
    },
    { masterKey: key },
  );
  server = await startServer(config);
  lockDown(tls.certPem);
  createWindow();
}

/** Session verrouillée : certificat épinglé, aucune permission, navigation limitée à l'application. */
function lockDown(certPem: string): void {
  const ses = session.defaultSession;
  ses.setCertificateVerifyProc((req, callback) => {
    // 0 : accepté ; -2 : refusé ; -3 : décision normale de Chromium (sites externes éventuels).
    if (req.hostname === LOOPBACK) callback(isPinned(req.certificate.data, certPem) ? 0 : -2);
    else callback(-3);
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url, origin)) return;
    event.preventDefault();
    if (isExternalHttps(url)) void shell.openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttps(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: TITLE,
    backgroundColor: '#16131f',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  win.once('ready-to-show', () => win.show());
  void win.loadURL(`${origin}/`);
}

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// macOS : l'application reste active sans fenêtre (convention), une fenêtre est recréée au clic du Dock.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (server && BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', (event) => {
  if (quitting || !server) return;
  event.preventDefault();
  quitting = true;
  void server.close().finally(() => app.quit());
});

void app.whenReady().then(() => {
  // macOS : menus standard (copier-coller, fenêtre) ; ailleurs, aucune barre de menus.
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
      : null,
  );
  return start().catch((err: unknown) =>
    fail(err instanceof StartupError ? err.message : `Démarrage impossible : ${(err as Error).message}`),
  );
});
