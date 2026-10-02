import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('.', import.meta.url));
// Navigateurs et bibliothèques éventuellement extraites localement : tout reste dans le projet.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(root, '.tmp', 'ms-playwright');
const libs = join(root, '.tmp', 'syslibs', 'usr', 'lib', 'x86_64-linux-gnu');
if (existsSync(libs))
  process.env.LD_LIBRARY_PATH = [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');

const PORT = 8444;

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: '.tmp/test-results',
  use: {
    baseURL: `https://localhost:${PORT}`,
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `node scripts/e2e-server.mjs ${PORT}`,
    url: `https://localhost:${PORT}/healthz`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
