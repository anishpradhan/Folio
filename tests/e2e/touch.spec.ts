import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { FIX, openBook } from './helpers';

test.use({ viewport: { width: 800, height: 1280 }, hasTouch: true, isMobile: true });

/** Select a word the way a touch long-press does: the selection changes, no pointerup follows. */
async function longPressSelect(page: Page, word: string) {
  return page.evaluate((w) => {
    for (const s of Array.from(document.querySelectorAll<HTMLElement>('.textLayer span'))) {
      const node = s.firstChild as Text | null;
      if (!node || node.nodeType !== 3) continue;
      const i = node.data.indexOf(w);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + w.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
      return r.getBoundingClientRect().bottom;
    }
    throw new Error(`not found: ${w}`);
  }, word);
}

test('touch selection shows the reader toolbar below the text; Define and Highlight work by tap', async ({ page }) => {
  await page.route('https://api.dictionaryapi.dev/**', (route) =>
    route.fulfill({ json: [{ word: 'serendipity', phonetic: '/ˌsɛɹ.ənˈdɪp.ɪ.ti/', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A happy accident.' }], synonyms: [] }] }] }),
  );
  await openBook(page);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  await page.getByTestId('next-page').tap();
  await expect(page.locator('.pdf-page[data-page="2"] .textLayer span').first()).toBeAttached();

  const bottom = await longPressSelect(page, 'serendipity');
  const toolbar = page.getByRole('toolbar', { name: 'Selection actions' });
  await expect(toolbar).toBeVisible();
  const tb = (await toolbar.boundingBox())!;
  expect(tb.y).toBeGreaterThan(bottom); // below the selection, away from the OS menu
  await page.screenshot({ path: '.shots/touch-toolbar.png' });

  await page.getByTestId('sel-define').tap();
  await expect(page.getByTestId('dict-word')).toHaveText('serendipity');
  await expect(page.getByTestId('dictionary')).toContainText('A happy accident.');
  await page.screenshot({ path: '.shots/touch-dictionary.png' });

  // Tap away closes it; a new long-press selection reopens the toolbar.
  await page.locator('.pdf-page[data-page="2"]').tap({ position: { x: 20, y: 20 } });
  await expect(page.getByTestId('dictionary')).toHaveCount(0);
  await longPressSelect(page, 'marginalia');
  await expect(toolbar).toBeVisible();
  await page.getByTestId('hl-green').tap();
  await expect(page.locator('.hl-rect.hl-green')).toHaveCount(1);
  await expect(toolbar).toHaveCount(0);
});

/** Dispatch a touch swipe as pointer events (what Android Chrome sends for a horizontal pan under touch-action: pan-y). */
async function swipe(page: Page, fromX: number, toX: number, y = 600) {
  await page.getByTestId('epub-scroll').evaluate(
    (el, [x0, x1, yy]) => {
      const fire = (type: string, x: number) => el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', clientX: x, clientY: yy, bubbles: true, isPrimary: true }));
      fire('pointerdown', x0);
      fire('pointermove', (x0 + x1) / 2);
      fire('pointerup', x1);
    },
    [fromX, toX, y] as const,
  );
}

test('tablet: EPUB pages turn by swipe and edge tap; long-press still selects', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(resolve(FIX, 'lantern-keeper.epub'));
  await page.getByTestId('book-card').first().getByRole('button').first().tap();
  await expect(page.getByTestId('epub-section')).toBeVisible();
  await page.getByRole('button', { name: 'Page layout' }).tap();
  await page.getByRole('menuitem', { name: 'Single page' }).tap();
  await expect(page.getByTestId('epub-scroll')).toHaveAttribute('data-layout', 'single');
  const cur = () => page.getByTestId('page-input').inputValue();
  expect(await cur()).toBe('1');

  await swipe(page, 600, 200); // swipe left → next
  await expect.poll(cur).toBe('2');
  await swipe(page, 200, 600); // swipe right → back
  await expect.poll(cur).toBe('1');
  // Tap near the right edge turns forward too.
  await page.getByTestId('epub-scroll').evaluate((el) => {
    const b = el.getBoundingClientRect();
    const opts = { pointerType: 'touch', clientX: b.right - 20, clientY: b.top + b.height / 2, bubbles: true, isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
  });
  await expect.poll(cur).toBe('2');
  await page.screenshot({ path: '.shots/touch-epub-single.png' });

  // Long-press selection on a paginated page offers the reader's toolbar, not a page turn.
  await page.evaluate(() => {
    const p = document.querySelector('[data-testid="epub-section"] p')!;
    const r = document.createRange();
    r.selectNodeContents(p.firstChild!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(r);
  });
  await expect(page.getByRole('toolbar', { name: 'Selection actions' })).toBeVisible();
  expect(await cur()).toBe('2');
});
