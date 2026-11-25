import { test, expect } from '@playwright/test';
import { currentPage, openBook, upload } from './helpers';

test('large PDF: fast open, virtualised pages, jump and search across 400 pages', async ({ page }) => {
  test.setTimeout(120_000);
  const t0 = Date.now();
  await upload(page, 'large.pdf');
  const ingestMs = Date.now() - t0;
  await page.getByTestId('book-card').first().getByRole('button').first().click();
  await expect(page.locator('.pdf-page[data-page="1"] canvas')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('page-total')).toHaveText('of 400');

  // Only a handful of pages exist in the DOM.
  expect(await page.locator('.pdf-page').count()).toBeLessThan(8);

  await page.getByTestId('page-input').click();
  await page.getByTestId('page-input').fill('333');
  await page.getByTestId('page-input').press('Enter');
  await expect.poll(() => currentPage(page)).toBe('333');
  await expect(page.locator('.pdf-page[data-page="333"] canvas')).toBeVisible();
  expect(await page.locator('.pdf-page').count()).toBeLessThan(8);

  await page.locator('body').press('Control+f');
  await page.getByTestId('search-input').fill('needle-in-haystack');
  await expect(page.getByTestId('search-count')).toContainText('1 match', { timeout: 60_000 });
  await page.getByTestId('search-result').first().click();
  await expect(page.locator('.pdf-page[data-page="333"] .search-rect.is-current')).toBeVisible();

  // Rapid scrolling never mounts the whole document.
  const scroller = page.getByTestId('viewer-scroll');
  for (let i = 0; i < 20; i++) await scroller.evaluate((el) => (el.scrollTop -= 3000));
  expect(await page.locator('.pdf-page').count()).toBeLessThan(10);
  console.log(`[perf] ingest of 400-page PDF: ${ingestMs} ms`);
});

test('themes and dark reading', async ({ page }) => {
  await openBook(page);
  await page.getByRole('button', { name: 'Back to library' }).click();
  await page.getByRole('radio', { name: 'Midnight Library' }).first().click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '.shots/theme-midnight-library.png' });
  await page.getByText(/Page 1 of 10/).click();
  await expect(page.locator('.pdf-page[data-page="1"] canvas')).toBeVisible();
  await page.locator('body').press('d');
  await expect(page.getByTestId('reader')).toHaveClass(/inverted/);
  await page.getByTestId('next-page').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: '.shots/theme-midnight-reader.png' });

  await page.getByRole('button', { name: 'Back to library' }).click();
  await page.getByRole('radio', { name: 'Vintage Paper' }).first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: '.shots/theme-vintage-library.png' });
  await page.getByRole('radio', { name: 'Nordic Minimal' }).first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: '.shots/theme-nordic-library.png' });
});

test.describe('small screens', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('phone layout for library and reader', async ({ page }) => {
    await openBook(page);
    await page.waitForTimeout(500);
    await page.screenshot({ path: '.shots/phone-reader.png' });
    await page.getByRole('button', { name: 'Notebook' }).click();
    await expect(page.getByTestId('right-sidebar')).toBeVisible();
    await expect(page.getByTestId('left-sidebar')).toHaveCount(0); // only one panel at a time
    await page.screenshot({ path: '.shots/phone-notebook.png' });
    await page.goto('/#/');
    await page.waitForTimeout(400);
    await page.screenshot({ path: '.shots/phone-library.png' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('tablet', () => {
  test.use({ viewport: { width: 820, height: 1180 } });
  test('tablet reader', async ({ page }) => {
    await openBook(page);
    await page.waitForTimeout(500);
    await page.screenshot({ path: '.shots/tablet-reader.png' });
  });
});
