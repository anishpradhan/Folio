import { test, expect } from '@playwright/test';
import { currentPage, openBook, selectWord, trackErrors } from './helpers';

test.describe('reader core', () => {
  test('renders the PDF and navigates pages', async ({ page }) => {
    const errors = trackErrors(page);
    await openBook(page);
    await expect(page.getByTestId('page-total')).toHaveText('of 10');
    await expect.poll(() => currentPage(page)).toBe('1');

    await page.getByTestId('next-page').click();
    await expect.poll(() => currentPage(page)).toBe('2');

    await page.getByTestId('page-input').click();
    await page.getByTestId('page-input').fill('7');
    await page.getByTestId('page-input').press('Enter');
    await expect.poll(() => currentPage(page)).toBe('7');
    await expect(page.locator('.pdf-page[data-page="7"] canvas')).toBeVisible();

    await page.locator('body').press('End');
    await expect.poll(() => currentPage(page)).toBe('10');
    await page.locator('body').press('Home');
    await expect.poll(() => currentPage(page)).toBe('1');

    // Virtualisation: not every page is mounted.
    const mounted = await page.locator('.pdf-page').count();
    expect(mounted).toBeLessThan(10);

    await page.screenshot({ path: '.shots/reader.png' });
    expect(errors).toEqual([]);
  });

  test('zoom, layouts and text view', async ({ page }) => {
    await openBook(page);
    const w0 = await page.locator('.pdf-page[data-page="1"]').evaluate((e) => e.getBoundingClientRect().width);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(() => page.locator('.pdf-page[data-page="1"]').evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThan(w0);
    await expect(page.getByTestId('zoom-level')).toContainText('%');

    await page.getByTestId('zoom-level').click();
    await page.getByRole('menuitem', { name: 'Fit to page' }).click();
    await expect(page.getByTestId('zoom-level')).toContainText('Page');

    await page.getByRole('button', { name: 'Page layout' }).click();
    await page.getByRole('menuitem', { name: 'Two-page spread' }).click();
    await page.getByTestId('next-page').click();
    await expect(page.locator('.pdf-page[data-page="2"]')).toBeVisible();
    await expect(page.locator('.pdf-page[data-page="3"]')).toBeVisible();
    await page.screenshot({ path: '.shots/spread.png' });

    await page.getByRole('button', { name: 'Page layout' }).click();
    await page.getByRole('menuitem', { name: 'Single page' }).click();
    await expect(page.locator('.pdf-page')).toHaveCount(1);

    await page.locator('body').press('t');
    await expect(page.locator('article.reflow')).toBeVisible();
    await expect(page.locator('article.reflow')).toContainText(/\w+/);
    await page.screenshot({ path: '.shots/reflow.png' });
  });

  test('table of contents navigates and tracks the current section', async ({ page }) => {
    await openBook(page);
    const toc = page.getByRole('navigation', { name: 'Table of contents' });
    await expect(toc).toContainText('Chapter Two: Attention');
    await toc.getByRole('button', { name: /Chapter Three: Marginalia/ }).click();
    await expect(page.getByTestId('current-section')).toHaveText(/Chapter Three: Marginalia|Notes to a Future Self/);
    const p = Number(await currentPage(page));
    expect(p).toBeGreaterThan(3);
  });

  test('search finds real matches and jumps to them', async ({ page }) => {
    await openBook(page);
    await page.locator('body').press('Control+f');
    await expect(page.getByTestId('search-input')).toBeFocused();
    await page.getByTestId('search-input').fill('bookmark');
    await expect(page.getByTestId('search-count')).toContainText(/\d+ match/);
    const results = page.getByTestId('search-result');
    expect(await results.count()).toBeGreaterThan(0);
    await results.last().click();
    await expect(page.locator('.search-rect.is-current')).toBeVisible();
    await page.screenshot({ path: '.shots/search.png' });

    await page.getByTestId('search-input').fill('zzqqxx');
    await expect(page.getByTestId('search-count')).toHaveText('No matches');
  });

  test('highlights are created, edited, persisted and deleted', async ({ page }) => {
    const errors = trackErrors(page);
    await openBook(page);
    await page.getByTestId('next-page').click();
    await expect(page.locator('.pdf-page[data-page="2"] .textLayer span').first()).toBeAttached();
    await selectWord(page, 'serendipity');
    await expect(page.getByRole('toolbar', { name: 'Selection actions' })).toBeVisible();
    await page.getByTestId('hl-green').click();
    await expect(page.locator('.hl-rect.hl-green')).toHaveCount(1);

    await page.reload();
    await expect(page.locator('.hl-rect.hl-green')).toHaveCount(1, { timeout: 15_000 });

    // Click the highlight to reveal its card, add a note and recolour it.
    const rect = page.locator('.hl-rect.hl-green').first();
    const b = (await rect.boundingBox())!;
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    const card = page.getByRole('dialog', { name: 'Highlight' });
    await expect(card).toContainText('serendipity');
    await card.getByLabel('Note').fill('Happy accidents of reading.');
    await card.getByRole('radio', { name: 'Purple' }).click();
    await expect(page.locator('.hl-rect.hl-purple')).toHaveCount(1);
    await page.waitForTimeout(900); // note autosave
    await page.keyboard.press('Escape');

    await page.reload();
    await expect(page.locator('.hl-rect.hl-purple')).toHaveCount(1, { timeout: 15_000 });
    await page.getByTestId('toggle-notebook').click();
    await expect(page.getByTestId('sidebar-highlight')).toContainText('Happy accidents of reading.');

    const r2 = (await page.locator('.hl-rect.hl-purple').first().boundingBox())!;
    await page.mouse.click(r2.x + r2.width / 2, r2.y + r2.height / 2);
    await page.getByTestId('hl-delete').click();
    await expect(page.locator('.hl-rect')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('bookmarks and page notes persist', async ({ page }) => {
    await openBook(page);
    await page.getByTestId('next-page').click();
    await page.getByTestId('next-page').click();
    await expect.poll(() => currentPage(page)).toBe('3');
    await page.locator('body').press('b');
    await expect(page.locator('.pdf-page[data-page="3"] .bookmark-ribbon')).toBeVisible();

    await page.getByTestId('toggle-notebook').click();
    await page.getByRole('tab', { name: /Bookmarks/ }).click();
    await expect(page.getByTestId('sidebar-bookmark')).toHaveCount(1);
    await page.getByLabel('Bookmark title').fill('Where attention begins');
    await page.getByLabel('Bookmark title').press('Enter');

    await page.getByRole('tab', { name: /Notes/ }).click();
    await page.getByTestId('page-note-input').fill('Compare with Weil on attention.');
    await page.getByTestId('page-note-save').click();
    await expect(page.getByTestId('sidebar-note')).toHaveCount(1);

    await page.reload();
    await expect(page.getByTestId('reader')).toBeVisible();
    await expect.poll(() => currentPage(page)).toBe('3'); // resume
    await page.getByRole('tab', { name: /Bookmarks/ }).click();
    await expect(page.getByLabel('Bookmark title')).toHaveValue('Where attention begins');
    await page.getByRole('tab', { name: /Notes/ }).click();
    await expect(page.getByTestId('sidebar-note')).toContainText('Compare with Weil');
  });
});

test('highlights made in text view resolve onto the original page', async ({ page }) => {
  await openBook(page);
  await page.getByTestId('next-page').click();
  await page.locator('body').press('t');
  const article = page.locator('article.reflow');
  await expect(article).toContainText('serendipity');
  await page.waitForTimeout(500); // let the page-turn animation settle before measuring
  const box = await page.evaluate(() => {
    const p = Array.from(document.querySelectorAll('article.reflow p')).find((x) => x.textContent!.includes('serendipity'))!;
    const node = p.firstChild as Text;
    const i = node.data.indexOf('serendipity');
    const r = document.createRange();
    r.setStart(node, i);
    r.setEnd(node, i + 'serendipity'.length);
    const b = r.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
  await page.mouse.move(box.x + 1, box.y + box.h / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w - 1, box.y + box.h / 2, { steps: 6 });
  await page.mouse.up();
  await page.getByTestId('hl-pink').click();
  await expect(article.locator('mark.hl-pink')).toHaveText('serendipity');

  await page.locator('body').press('t'); // back to the original layout
  await expect(page.locator('.pdf-page[data-page="2"] .hl-rect.hl-pink')).toHaveCount(1, { timeout: 15_000 });
});

test('distraction-free mode hides chrome and Escape restores it', async ({ page }) => {
  await openBook(page);
  await page.locator('body').press('f');
  await expect(page.locator('header').first()).toHaveCSS('opacity', '0');
  await expect(page.getByTestId('left-sidebar')).toHaveCount(0);
  await page.screenshot({ path: '.shots/focus-mode.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('header').first()).toHaveCSS('opacity', '1');
  await expect(page.getByTestId('left-sidebar')).toBeVisible();
});
