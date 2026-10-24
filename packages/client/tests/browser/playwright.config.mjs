import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const port = Number(process.env.ZHUMA_UI_TEST_PORT ?? 8796);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid UI test port');

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  globalSetup: fileURLToPath(new URL('./global-setup.mjs', import.meta.url)),
  outputDir: `${root}/test-results/workbench`,
  timeout: 45_000,
  expect: { timeout: 5000 },
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { outputFolder: `${root}/playwright-report`, open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: 'chromium',
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium-light', use: { browserName: 'chromium', colorScheme: 'light' } },
    { name: 'chromium-dark', use: { browserName: 'chromium', colorScheme: 'dark' } },
    {
      name: 'identity',
      testDir: fileURLToPath(new URL('../../../dsh-adapter/tests/browser/', import.meta.url)),
      testMatch: '*.spec.mjs',
    },
  ],
  webServer: {
    command: 'pnpm exec tsc -b --pretty false && node packages/client/tests/browser/server.mjs',
    cwd: root,
    url: `http://127.0.0.1:${port}/health`,
    env: { ZHUMA_UI_TEST_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
