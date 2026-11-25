import { defineConfig, devices } from '@playwright/test';

/**
 * The Ask (document Q&A) tests run against a hermetic AI backend: `node scripts/ai.mjs e2e` serves on
 * 127.0.0.1:8766 with its own database and data folder, real parsing and retrieval, and a scripted model
 * instead of Claude. It needs PostgreSQL (`npm run ai:db`). Set FOLIO_E2E_AI=0 to run without it; the Ask
 * tests then skip themselves.
 */
const withAi = process.env.FOLIO_E2E_AI !== '0';
const AI_URL = 'http://127.0.0.1:8766';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5179',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    // Auto-prepare is off in tests: otherwise every test that adds a PDF would start a Docling parse in the
    // e2e backend. tests/e2e/auto-prepare.spec.ts turns it back on.
    storageState: {
      cookies: [],
      origins: [{ origin: 'http://localhost:5179', localStorage: [{ name: 'folio:prefs', value: JSON.stringify({ state: { aiAutoPrepare: false }, version: 1 }) }] }],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: 'npx vite --port 5179 --strictPort',
      url: 'http://localhost:5179',
      // Lets the link-import tests reach their stand-in site on 127.0.0.1; /api/ai goes to the e2e backend.
      env: { FOLIO_LINK_ALLOW_PRIVATE: '1', FOLIO_AI_URL: AI_URL },
      reuseExistingServer: true,
      timeout: 60_000,
    },
    ...(withAi
      ? [
          {
            command: 'node scripts/ai.mjs e2e',
            url: `${AI_URL}/api/ai/health`,
            reuseExistingServer: true,
            timeout: 120_000,
          },
        ]
      : []),
  ],
});
