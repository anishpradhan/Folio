import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { FIX, currentPage, trackErrors, upload } from './helpers';

async function openEpub(page: Page, file = 'lantern-keeper.epub') {
  await upload(page, file);
  await page.getByTestId('book-card').first().getByRole('button').first().click();
  await expect(page.getByTestId('epub-section')).toBeVisible();
}

const section = (page: Page) => page.getByTestId('epub-section');

/** Drag-select `word` inside the paragraph that contains `inParagraph`. */
async function selectIn(page: Page, inParagraph: string, word: string) {
  await page.waitForTimeout(400); // let the section's entrance animation settle
  const box = await page.evaluate(
    ([para, w]) => {
      const p = Array.from(document.querySelectorAll('[data-testid="epub-section"] p')).find((x) => x.textContent!.includes(para))!;
      p.scrollIntoView({ block: 'center' });
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        const i = n.data.indexOf(w);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + w.length);
        const b = r.getBoundingClientRect();
        return { x: b.left, y: b.top, w: b.width, h: b.height };
      }
      throw new Error('word not found');
    },
    [inParagraph, word] as const,
  );
  await page.mouse.move(box.x + 1, box.y + box.h / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w - 1, box.y + box.h / 2, { steps: 6 });
  await page.mouse.up();
}

test('EPUB: upload shows real metadata and cover', async ({ page }) => {
  const errors = trackErrors(page);
  await upload(page, 'lantern-keeper.epub');
  const card = page.getByTestId('book-card').first();
  await expect(card).toContainText('The Lantern Keeper');
  await expect(card).toContainText('Mara Ellison');
  await expect(card.locator('img')).toHaveAttribute('src', /^data:image\/jpeg/);
  await page.screenshot({ path: '.shots/epub-library.png' });
  expect(errors).toEqual([]);
});

test('EPUB: reading, contents, links, images and safety', async ({ page }) => {
  const errors = trackErrors(page);
  await openEpub(page);
  await expect(page.getByTestId('page-total')).toHaveText('of 5');
  // Section 1 is the SVG cover page, rendered as an image.
  await expect(section(page).locator('img')).toHaveCount(1);

  const toc = page.getByRole('navigation', { name: 'Table of contents' });
  await expect(toc).toContainText('Chapter Two: Weather');
  await toc.getByRole('button', { name: 'After the Storm' }).click();
  await expect.poll(() => currentPage(page)).toBe('3');
  await expect(page.locator('#ep-s2b')).toBeInViewport();
  await expect(page.getByTestId('current-section')).toHaveText(/Chapter Two: Weather|After the Storm/);

  await page.locator('body').press('ArrowRight');
  await expect.poll(() => currentPage(page)).toBe('4');
  await expect(section(page).locator('h1')).toHaveText('Chapter Three: Letters');
  // The figure image comes from inside the zip.
  await expect.poll(() => section(page).locator('figure img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  // Nothing from the book can run: no scripts, frames, handlers or javascript: links.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
  expect(await section(page).locator('script, iframe, [onclick], a[href^="javascript"]').count()).toBe(0);
  await section(page).getByText('Click for a surprise').click();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
  await page.screenshot({ path: '.shots/epub-reader.png' });

  // Internal link → other section + anchor.
  await section(page).getByRole('link', { name: 'the beginning of her ledger' }).click();
  await expect.poll(() => currentPage(page)).toBe('2');
  await expect(section(page).locator('h1')).toHaveText('Chapter One: The Harbour');
  // External link opens in a new tab, safely.
  await page.getByTestId('next-page').click();
  await page.getByTestId('next-page').click();
  await expect(section(page).getByRole('link', { name: 'tide table' })).toHaveAttribute('target', '_blank');
  expect(errors).toEqual([]);
});

test('EPUB: search finds and scrolls to matches', async ({ page }) => {
  await openEpub(page);
  await page.locator('body').press('Control+f');
  await page.getByTestId('search-input').fill('lantern');
  await expect(page.getByTestId('search-count')).toContainText('2 matches');
  await expect(page.getByTestId('search-results')).toContainText('Chapter Two: Weather');
  await page.getByTestId('search-result').nth(1).click();
  await expect.poll(() => currentPage(page)).toBe('3');
  const current = section(page).locator('mark.search-hit.is-current');
  await expect(current).toHaveText('lantern');
  await expect(current).toBeInViewport();
});

test('EPUB: highlights keep their exact place, persist and appear in Insights', async ({ page }) => {
  const errors = trackErrors(page);
  await openEpub(page);
  await page.getByRole('navigation', { name: 'Table of contents' }).getByRole('button', { name: 'Chapter Two: Weather' }).click();
  await expect.poll(() => currentPage(page)).toBe('3');
  // "lantern" appears twice in this section — highlight the second one.
  await selectIn(page, 'polished the lantern', 'lantern');
  await page.getByTestId('hl-purple').click();
  const mark = section(page).locator('mark.hl-purple');
  await expect(mark).toHaveText('lantern');
  await expect(mark.locator('xpath=ancestor::p')).toContainText('polished the');

  await page.reload();
  await expect(section(page)).toBeVisible();
  await expect.poll(() => currentPage(page)).toBe('3');
  await expect(mark).toHaveText('lantern');
  await expect(mark.locator('xpath=ancestor::p')).toContainText('polished the');

  // Click → card → note.
  await mark.click();
  const card = page.getByRole('dialog', { name: 'Highlight' });
  await expect(card).toContainText('Chapter Two: Weather');
  await card.getByLabel('Note').fill('Care as ritual.');
  await page.waitForTimeout(900);
  await page.keyboard.press('Escape');

  await page.goto('/#/insights');
  const item = page.getByTestId('insight-item').first();
  await expect(item).toContainText('lantern');
  await expect(item).toContainText('Care as ritual.');
  await expect(item).toContainText('Chapter Two: Weather');
  await page.getByTestId('insight-jump').first().click();
  await expect(section(page)).toBeVisible();
  await expect.poll(() => currentPage(page)).toBe('3');
  await expect(section(page).locator('mark.hl-purple')).toBeInViewport();
  expect(errors).toEqual([]);
});

test('EPUB: bookmarks, text size and resume', async ({ page }) => {
  await openEpub(page);
  await page.getByTestId('next-page').click();
  await page.getByTestId('next-page').click();
  await expect.poll(() => currentPage(page)).toBe('3');
  await page.locator('body').press('b');
  await expect(section(page).locator('xpath=..').locator('.bookmark-ribbon')).toBeVisible();
  await page.getByTestId('toggle-notebook').click();
  await page.getByRole('tab', { name: /Bookmarks/ }).click();
  await expect(page.getByTestId('sidebar-bookmark')).toContainText('Chapter Two: Weather');

  const size = Number(await page.getByTestId('text-size').innerText());
  await page.locator('body').press('=');
  await expect(page.getByTestId('text-size')).toHaveText(String(size + 1));
  const fontSize = await section(page).evaluate((el) => getComputedStyle(el).fontSize);
  expect(fontSize).toBe(`${size + 1}px`);

  // Make the section scroll, read partway, reload → same section and place.
  await page.locator('body').press('=');
  await page.locator('body').press('=');
  await page.setViewportSize({ width: 1000, height: 520 });
  const scroller = page.getByTestId('epub-scroll');
  // Read partway into section 3 (continuous scroll stacks the whole book).
  await scroller.evaluate((el) => {
    const s = el.querySelector<HTMLElement>('[data-section="3"]')!;
    el.scrollTop = s.offsetTop + s.offsetHeight * 0.5;
  });
  await page.waitForTimeout(1000);
  // Position within the section (sections above may render lazily, so raw scrollTop differs).
  const into = () => scroller.evaluate((el) => el.scrollTop - el.querySelector<HTMLElement>('[data-section="3"]')!.offsetTop);
  const before = await into();
  await page.reload();
  await expect(section(page)).toBeVisible();
  await expect.poll(() => currentPage(page)).toBe('3');
  await expect.poll(into).toBeGreaterThan(before * 0.85);
  expect(await into()).toBeLessThan(before * 1.15);
});

test('EPUB 2 books with only an NCX and sloppy HTML still open', async ({ page }) => {
  await openEpub(page, 'old-almanac.epub');
  await expect(section(page)).toContainText('Plant the peas');
  await expect(page.getByRole('navigation', { name: 'Table of contents' })).toContainText('Summer');
  await page.locator('body').press('ArrowRight');
  await expect(section(page)).toContainText('Harvest the almanac herbs');
});

test('EPUB uploads alongside PDFs and duplicates are detected', async ({ page }) => {
  await upload(page, 'lantern-keeper.epub');
  await page.getByTestId('file-input').setInputFiles(resolve(FIX, 'quiet-art.pdf'));
  await expect(page.getByTestId('book-card')).toHaveCount(2);
  await page.getByTestId('file-input').setInputFiles(resolve(FIX, 'lantern-keeper.epub'));
  await expect(page.getByText(/already on your shelf/)).toBeVisible();
  await expect(page.getByTestId('book-card')).toHaveCount(2);
});

/* ------------------------------ layouts ------------------------------ */

async function chooseLayout(page: Page, name: 'Continuous scroll' | 'Single page' | 'Two-page spread') {
  await page.getByRole('button', { name: 'Page layout' }).click();
  await page.getByRole('menuitem', { name }).click();
}
const progress = (page: Page) => page.getByTestId('progress-label');

test('EPUB: continuous scroll stacks the whole book and follows the reader', async ({ page }) => {
  const errors = trackErrors(page);
  await openEpub(page);
  const scroller = page.getByTestId('epub-scroll');
  await expect(scroller.locator('[data-section]')).toHaveCount(5);
  // Scrolling by hand into section 4 makes it current, and the chapter label follows.
  await scroller.evaluate((el) => {
    el.dispatchEvent(new WheelEvent('wheel'));
    el.scrollTop = el.querySelector<HTMLElement>('[data-section="4"]')!.offsetTop;
  });
  await expect.poll(() => currentPage(page)).toBe('4');
  await expect(page.getByTestId('current-section')).toHaveText('Chapter Three: Letters');
  // Next/previous jump between sections.
  await page.getByTestId('next-page').click();
  await expect.poll(() => currentPage(page)).toBe('5');
  await expect(scroller.locator('[data-section="5"] h1')).toBeInViewport();
  expect(errors).toEqual([]);
});

test('EPUB: two-page spread turns pages within and across sections, and resumes', async ({ page }) => {
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 1280, height: 560 });
  await openEpub(page);
  for (let k = 0; k < 6; k++) await page.locator('body').press('=');
  await chooseLayout(page, 'Two-page spread');
  const host = page.getByTestId('epub-scroll');
  await expect(host).toHaveAttribute('data-layout', 'spread');

  await page.getByRole('navigation', { name: 'Table of contents' }).getByRole('button', { name: 'Chapter Two: Weather' }).click();
  await expect.poll(() => currentPage(page)).toBe('3');
  await expect(progress(page)).toContainText(/Page 1–2 of \d+ in chapter/);
  const total = Number((await progress(page).innerText()).match(/of (\d+)/)![1]);
  expect(total).toBeGreaterThan(2);

  // Arrow keys turn a spread at a time, staying in the section…
  await page.locator('body').press('ArrowRight');
  await expect(progress(page)).toContainText(/Page 3(–4)? of/);
  expect(await currentPage(page)).toBe('3');
  await page.waitForTimeout(500); // let the page turn finish
  await page.screenshot({ path: '.shots/epub-spread.png' });
  // …then move on to the next section…
  for (let k = 0; k < 10 && (await currentPage(page)) === '3'; k++) await page.locator('body').press('ArrowRight');
  expect(await currentPage(page)).toBe('4');
  await expect(progress(page)).toContainText('Page 1');
  // …and back again lands on the previous section's last spread.
  await page.getByTestId('prev-page').click();
  await expect.poll(() => currentPage(page)).toBe('3');
  await expect(progress(page)).toContainText(new RegExp(`(–${total}|Page ${total}) of ${total}`));

  // A contents entry inside the section opens the spread that holds it.
  await page.getByRole('navigation', { name: 'Table of contents' }).getByRole('button', { name: 'After the Storm' }).click();
  await expect(page.locator('#ep-s2b')).toBeInViewport();
  const label = await progress(page).innerText();
  await page.reload();
  await expect(host).toHaveAttribute('data-layout', 'spread');
  await expect.poll(() => currentPage(page)).toBe('3');
  await expect(progress(page)).toHaveText(label.replace(/ · .*/, '') + label.slice(label.indexOf(' · ')));
  expect(errors).toEqual([]);
});

test('EPUB: single page — search, highlight and text size keep their place', async ({ page }) => {
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 1280, height: 600 });
  await openEpub(page);
  await chooseLayout(page, 'Single page');
  await expect(page.getByTestId('epub-scroll')).toHaveAttribute('data-layout', 'single');
  for (let k = 0; k < 6; k++) await page.locator('body').press('=');

  // Search jumps straight to the page holding the match.
  await page.locator('body').press('Control+f');
  await page.getByTestId('search-input').fill('polished');
  await expect(page.getByTestId('search-count')).toContainText('1 match');
  await page.getByTestId('search-result').first().click();
  await expect.poll(() => currentPage(page)).toBe('3');
  const hit = section(page).locator('mark.search-hit.is-current');
  await expect(hit).toBeInViewport();
  await expect(progress(page)).not.toContainText('Page 1 of');

  // Highlight on a paginated page, then it survives a reload on the same page.
  await page.getByTestId('search-input').fill('');
  await selectIn(page, 'polished the lantern', 'lantern');
  await page.getByTestId('hl-green').click();
  const mark = section(page).locator('mark.hl-green');
  await expect(mark).toHaveText('lantern');
  await page.reload();
  await expect.poll(() => currentPage(page)).toBe('3');
  await expect(mark).toBeInViewport();

  // Text size changes the page count, yet the same passage stays on screen.
  const pages = async () => Number((await progress(page).innerText()).match(/of (\d+)/)![1]);
  const before = await pages();
  for (let k = 0; k < 6; k++) await page.locator('body').press('-');
  await expect.poll(pages).toBeLessThan(before);
  expect(await currentPage(page)).toBe('3');
  await expect(mark).toBeInViewport();
  for (let k = 0; k < 6; k++) await page.locator('body').press('=');
  await expect.poll(pages).toBe(before);
  await expect(mark).toBeInViewport();
  await page.screenshot({ path: '.shots/epub-single.png' });
  expect(errors).toEqual([]);
});
