import { test, expect } from '@playwright/test';
import { openBook, selectWord } from './helpers';

// Opening the dev server from another device (http://192.168.x.x:5173) is not a "secure context":
// browsers then hide crypto.subtle, crypto.randomUUID and navigator.clipboard. Simulate that.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'subtle', { get: () => undefined, configurable: true });
    // @ts-expect-error simulate missing API
    delete Crypto.prototype.randomUUID;
    Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true });
  });
});

test('upload, read and highlight work over plain HTTP on a LAN address', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openBook(page);
  expect(await page.evaluate(() => typeof crypto.subtle)).toBe('undefined');
  await page.getByTestId('next-page').click();
  await expect(page.locator('.pdf-page[data-page="2"] .textLayer span').first()).toBeAttached();
  await selectWord(page, 'serendipity');
  await page.getByTestId('hl-yellow').click();
  await expect(page.locator('.hl-rect.hl-yellow')).toHaveCount(1);
  await selectWord(page, 'marginalia');
  await page.getByTestId('sel-copy').click();
  await expect(page.getByText('Copied to clipboard')).toBeVisible();
  expect(errors).toEqual([]);
});
