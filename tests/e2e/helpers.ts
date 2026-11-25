import { expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';

export const FIX = resolve(process.cwd(), 'tests/fixtures');

export function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/dictionaryapi|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

/** Upload a fixture from the library and wait for it to appear on the shelf. */
export async function upload(page: Page, file: string) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(resolve(FIX, file));
  // Generous: on a cold dev server the first upload also waits for on-demand module transforms.
  await expect(page.getByTestId('book-card').first()).toBeVisible({ timeout: 30_000 });
}

/** Upload a fixture and open it in the reader; waits until page 1 has rendered. */
export async function openBook(page: Page, file = 'quiet-art.pdf') {
  await upload(page, file);
  await page.getByTestId('book-card').first().getByRole('button').first().click();
  await expect(page.getByTestId('reader')).toBeVisible();
  await expect(page.locator('.pdf-page[data-page="1"] canvas')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.pdf-page[data-page="1"] .textLayer span').first()).toBeAttached();
}

export async function currentPage(page: Page) {
  return page.getByTestId('page-input').inputValue();
}

/** Select a word inside the PDF text layer with a real mouse drag. */
export async function selectWord(page: Page, word: string) {
  const box = await page.evaluate((w) => {
    const spans = Array.from(document.querySelectorAll<HTMLElement>('.textLayer span'));
    for (const s of spans) {
      const node = s.firstChild as Text | null;
      if (!node || node.nodeType !== 3) continue;
      const i = node.data.indexOf(w);
      if (i < 0) continue;
      s.scrollIntoView({ block: 'center' });
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + w.length);
      const b = r.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height };
    }
    return null;
  }, word);
  if (!box) throw new Error(`word not found in text layer: ${word}`);
  await page.waitForTimeout(150);
  // Re-measure after scrolling.
  const b2 = await page.evaluate((w) => {
    const spans = Array.from(document.querySelectorAll<HTMLElement>('.textLayer span'));
    for (const s of spans) {
      const node = s.firstChild as Text | null;
      if (!node || node.nodeType !== 3) continue;
      const i = node.data.indexOf(w);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + w.length);
      const b = r.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height };
    }
    return null;
  }, word);
  const t = b2 ?? box;
  await page.mouse.move(t.x + 1, t.y + t.h / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.w / 2, t.y + t.h / 2, { steps: 4 });
  await page.mouse.move(t.x + t.w - 1, t.y + t.h / 2, { steps: 4 });
  await page.mouse.up();
}
