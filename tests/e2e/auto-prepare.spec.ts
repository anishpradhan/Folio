import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIX, upload } from './helpers';

/**
 * New PDFs are sent to the assistant for preparation as soon as they're added, unless that's turned off.
 * (playwright.config.ts turns it off for the other tests; these set it explicitly.)
 */

const AI = 'http://127.0.0.1:8766/api/ai';
const HASH = createHash('sha256').update(readFileSync(resolve(FIX, 'quiet-art.pdf'))).digest('hex');

test.beforeAll(async ({ request }) => {
  const ok = await request.get(`${AI}/health`).then((r) => r.ok(), () => false);
  test.skip(!ok, 'AI e2e backend not running (FOLIO_E2E_AI=0?)');
});

// Pretend the backend has never seen the file, so adding it must upload it (the backend de-duplicates by hash).
const unseen = (page: Page) =>
  page.route(`**/api/ai/documents/${HASH}`, (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 404, json: { detail: 'Not found' } }) : r.continue()));

const isUpload = (r: { url(): string; method(): string }) => r.url().endsWith('/api/ai/documents') && r.method() === 'POST';

test.describe('with the default preference (on)', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('adding a PDF to the library prepares it for questions without being asked', async ({ page }) => {
    await unseen(page);
    const sent = page.waitForRequest(isUpload, { timeout: 30_000 });
    await upload(page, 'quiet-art.pdf');
    const req = await sent;
    expect(req.postData()).toContain(HASH); // the form carries the file's hash
    expect((await req.response())?.status()).toBeLessThan(300);
  });

  test('opening a PDF the assistant has never seen prepares it too', async ({ page }) => {
    // Added while the backend was down: nothing is sent then…
    await page.route('**/api/ai/health', (r) => r.abort());
    await upload(page, 'quiet-art.pdf');
    await page.unroute('**/api/ai/health');
    // …but opening it later, with the backend up, starts preparation.
    await page.reload();
    await unseen(page);
    const sent = page.waitForRequest(isUpload, { timeout: 30_000 });
    await page.getByTestId('book-card').first().getByRole('button').first().click();
    expect((await sent).postData()).toContain(HASH);
  });
});

test('with the preference off, nothing is sent', async ({ page }) => {
  await unseen(page);
  let posted = 0;
  page.on('request', (r) => {
    if (isUpload(r)) posted++;
  });
  await upload(page, 'quiet-art.pdf');
  await page.getByTestId('book-card').first().getByRole('button').first().click();
  await expect(page.locator('.pdf-page[data-page="1"] canvas')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  expect(posted).toBe(0);
});
