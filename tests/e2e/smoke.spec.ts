import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

const FIX = resolve(process.cwd(), 'tests/fixtures');

test('library smoke: upload shows a book', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/');
  await expect(page.getByText('Bring something worth reading.')).toBeVisible();
  await page.screenshot({ path: '.shots/library-empty.png' });
  await page.getByTestId('file-input').setInputFiles(resolve(FIX, 'quiet-art.pdf'));
  await expect(page.getByTestId('book-card')).toHaveCount(1);
  await expect(page.getByText('The Quiet Art of Reading').first()).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: '.shots/library-one.png' });
  expect(errors).toEqual([]);
});
