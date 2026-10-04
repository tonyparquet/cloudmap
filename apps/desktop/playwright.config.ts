import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// Application de bureau lancée par Playwright (Electron), après `node scripts/desktop.mjs stage`.
const root = fileURLToPath(new URL('../..', import.meta.url));
const libs = join(root, '.tmp', 'syslibs', 'usr', 'lib', 'x86_64-linux-gnu');
if (existsSync(libs))
  process.env.LD_LIBRARY_PATH = [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  outputDir: join(root, '.tmp', 'test-results-bureau'),
  use: { screenshot: 'only-on-failure' },
});
