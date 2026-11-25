import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIX, currentPage, openBook, selectWord, trackErrors } from './helpers';

/**
 * The selection assistant (phase 5) against the hermetic AI backend (see playwright.config.ts): the toolbar's
 * Ask AI button, the five modes in the answer card, continue-in-chat, and the same flow by touch.
 */

const AI = 'http://127.0.0.1:8766/api/ai';
const HASH = createHash('sha256').update(readFileSync(resolve(FIX, 'quiet-art.pdf'))).digest('hex');
const LINE = 'Attention is the scarce resource of our age.';

test.beforeAll(async ({ request }) => {
  const ok = await request.get(`${AI}/health`).then((r) => r.ok(), () => false);
  test.skip(!ok, 'AI e2e backend not running (FOLIO_E2E_AI=0?)');
});

test.beforeEach(async ({ request }) => {
  const r = await request.get(`${AI}/documents/${HASH}/conversations`);
  if (r.ok()) for (const c of await r.json()) await request.delete(`${AI}/conversations/${c.id}`);
});

/** Open the book on page 2 with the document prepared (the first run of the suite parses it with Docling). */
async function openPrepared(page: Page) {
  await openBook(page, 'quiet-art.pdf');
  await page.getByTestId('next-page').click();
  await expect(page.locator('.pdf-page[data-page="2"] .textLayer span').first()).toBeAttached();
  await selectWord(page, LINE);
  await page.getByTestId('sel-ask-ai').click();
  const card = page.getByTestId('ai-card');
  await expect(card).toBeVisible();
  const prepare = card.getByTestId('ai-prepare');
  const menu = card.getByTestId('ai-mode-explain');
  await expect(prepare.or(menu).or(card.getByTestId('ai-preparing'))).toBeVisible({ timeout: 20_000 });
  if (await prepare.isVisible()) await prepare.click();
  await expect(menu).toBeVisible({ timeout: 240_000 }); // the menu appears in the card once it's ready
  return card;
}

test('explain a selection in the card, follow a citation, then continue in chat', async ({ page, request }) => {
  test.setTimeout(300_000);
  const errors = trackErrors(page);
  const card = await openPrepared(page);
  await expect(card.locator('blockquote')).toHaveText(LINE);

  const sent = page.waitForRequest((r) => r.url().includes('/messages') && r.method() === 'POST');
  await card.getByTestId('ai-mode-explain').click();
  const body = (await sent).postDataJSON();
  expect(body).toMatchObject({ mode: 'explain', selection: { text: LINE, page: 2 } });

  const answer = card.getByTestId('ai-answer');
  await expect(answer).toHaveAttribute('data-status', 'complete', { timeout: 30_000 });
  await expect(answer).toContainText('The document says');
  const chip = answer.getByTestId('citation-chip').first();
  await expect(chip).toBeVisible();
  await page.screenshot({ path: '.shots/ai-card-explain.png' });

  // A citation in the card navigates and flashes the passage; the card stays open.
  const target = Number(await chip.getAttribute('data-page'));
  await chip.click();
  await expect.poll(() => currentPage(page)).toBe(String(target));
  await expect(page.locator(`[data-testid="citation-flash"][data-page="${target}"] .cite-rect`).first()).toBeVisible();
  await expect(card).toBeVisible();

  // The card's answers live in a conversation of their own; the Ask tab opens it.
  await card.getByTestId('ai-continue').click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('ask-chat')).toBeVisible();
  await expect(page.getByTestId('ask-question')).toHaveCount(1);
  await expect(page.getByTestId('ask-question').first()).toContainText('Explain this passage');
  await expect(page.getByTestId('ask-question').first().locator('blockquote')).toHaveText(LINE);
  await expect(page.getByTestId('ask-conversation').locator('option:checked')).toHaveText(`Explain this passage: ${LINE}`);

  // A follow-up in the chat sees the explanation as the previous turn.
  await page.getByTestId('ask-input').fill('Why does that matter?');
  await page.getByTestId('ask-input').press('Enter');
  const followUp = page.getByTestId('ask-answer').last();
  await expect(followUp).toHaveAttribute('data-status', 'complete', { timeout: 30_000 });
  await expect(followUp).toContainText('Follow-up 2 in this conversation');

  const convs = await (await request.get(`${AI}/documents/${HASH}/conversations`)).json();
  expect(convs).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('ask a question about the selection, try another mode, and find related passages', async ({ page }) => {
  test.setTimeout(300_000);
  const card = await openPrepared(page);

  const sent = page.waitForRequest((r) => r.url().includes('/messages') && r.method() === 'POST');
  await card.getByTestId('ai-question').fill('What does the author mean by scarce?');
  await card.getByTestId('ai-question').press('Enter');
  expect((await sent).postDataJSON()).toMatchObject({ mode: 'ask', content: 'What does the author mean by scarce?', selection: { text: LINE } });
  await expect(card.getByTestId('ai-answer')).toHaveAttribute('data-status', 'complete', { timeout: 30_000 });
  await expect(card.getByTestId('ai-answer')).toContainText('What does the author mean by scarce?');

  // Back to the menu: Simplify goes into the same conversation.
  await card.getByTestId('ai-back').click();
  await card.getByTestId('ai-mode-simplify').click();
  await expect(card.getByTestId('ai-answer')).toHaveAttribute('data-status', 'complete', { timeout: 30_000 });
  await expect(card.getByTestId('ai-answer')).not.toContainText('What does the author mean by scarce?');

  // Find related: retrieval only, no model call; a hit navigates and flashes its paragraphs.
  await card.getByTestId('ai-back').click();
  let modelCalls = 0;
  page.on('request', (r) => {
    if (r.url().includes('/messages')) modelCalls++;
  });
  const res = page.waitForResponse((r) => r.url().includes('/related'));
  await card.getByTestId('ai-mode-related').click();
  const hits = card.getByTestId('ai-related-hit');
  await expect(hits.first()).toBeVisible({ timeout: 15_000 });
  const related = await (await res).json();
  await expect(hits).toHaveCount(related.hits.length);
  expect(related.hits.length).toBeGreaterThanOrEqual(2);
  // The selection was found in its passage on p. 2, and that passage is left out of the results.
  expect(related.selection).toMatchObject({ pageStart: 2 });
  expect(related.hits.map((h: { id: string }) => h.id)).not.toContain(related.selection.id);
  const target = Number(await hits.last().getAttribute('data-page'));
  await hits.last().click();
  await expect.poll(() => currentPage(page)).toBe(String(target));
  await expect(page.locator(`[data-testid="citation-flash"][data-page="${target}"] .cite-rect`).first()).toBeVisible();
  expect(modelCalls).toBe(0);
  await page.screenshot({ path: '.shots/ai-card-related.png' });
});

test('closing the card stops its answer, which is kept as interrupted', async ({ page, request }) => {
  test.setTimeout(300_000);
  const card = await openPrepared(page);
  await card.getByTestId('ai-question').fill('Tell me slowly what this means');
  await card.getByTestId('ai-question').press('Enter');
  await expect(card.getByTestId('ai-answer')).toContainText('part 2', { timeout: 20_000 });
  await expect(card.getByTestId('ai-stop')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  await expect
    .poll(async () => {
      const [c] = await (await request.get(`${AI}/documents/${HASH}/conversations`)).json();
      const conv = await (await request.get(`${AI}/conversations/${c.id}`)).json();
      return conv.messages.at(-1)?.status;
    }, { timeout: 10_000 })
    .toBe('interrupted');
});

test('no Ask AI button while the backend is offline; an unprepared document is offered for preparation', async ({ page }) => {
  await page.route('**/api/ai/health', (r) => r.abort());
  await openBook(page, 'quiet-art.pdf');
  await page.getByTestId('next-page').click();
  await expect(page.locator('.pdf-page[data-page="2"] .textLayer span').first()).toBeAttached();
  await selectWord(page, LINE);
  await expect(page.getByRole('toolbar', { name: 'Selection actions' })).toBeVisible();
  await expect(page.getByTestId('sel-copy')).toBeVisible();
  await expect(page.getByTestId('sel-ask-ai')).toHaveCount(0);

  // Backend up, document never uploaded: the card explains and offers to prepare it.
  await page.unroute('**/api/ai/health');
  await page.route(`**/api/ai/documents/${HASH}`, (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 404, json: { detail: 'Not found' } }) : r.continue()));
  await page.reload();
  await expect(page.getByTestId('reader')).toBeVisible();
  await expect(page.locator('.pdf-page[data-page="2"] .textLayer span').first()).toBeAttached({ timeout: 15_000 });
  await selectWord(page, LINE);
  await page.getByTestId('sel-ask-ai').click();
  await expect(page.getByTestId('ai-card').getByTestId('ai-prepare')).toBeVisible();
  await expect(page.getByTestId('ai-mode-explain')).toHaveCount(0);
});

test.describe('on a tablet', () => {
  test.use({ viewport: { width: 800, height: 1280 }, hasTouch: true, isMobile: true });

  test('long-press a line, tap Ask AI, and get an explanation in a card below the selection', async ({ page }) => {
    test.setTimeout(300_000);
    await openBook(page, 'quiet-art.pdf');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await page.getByTestId('next-page').tap();
    await expect(page.locator('.pdf-page[data-page="2"] .textLayer span').first()).toBeAttached();

    // Select the way a long-press does: the selection changes and no pointerup follows.
    const bottom = await page.evaluate((w) => {
      for (const s of Array.from(document.querySelectorAll<HTMLElement>('.textLayer span'))) {
        const node = s.firstChild as Text | null;
        const i = node?.nodeType === 3 ? (node as Text).data.indexOf(w) : -1;
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(node!, i);
        r.setEnd(node!, i + w.length);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(r);
        return r.getBoundingClientRect().bottom;
      }
      throw new Error('line not found');
    }, LINE);
    await page.getByTestId('sel-ask-ai').tap();
    const card = page.getByTestId('ai-card');
    await expect(card).toBeVisible();
    expect((await card.boundingBox())!.y).toBeGreaterThan(bottom); // below, clear of the OS selection menu

    const prepare = card.getByTestId('ai-prepare');
    const explain = card.getByTestId('ai-mode-explain');
    await expect(prepare.or(explain).or(card.getByTestId('ai-preparing'))).toBeVisible({ timeout: 20_000 });
    if (await prepare.isVisible()) await prepare.tap();
    await expect(explain).toBeVisible({ timeout: 240_000 });
    await explain.tap();
    await expect(card.getByTestId('ai-answer')).toHaveAttribute('data-status', 'complete', { timeout: 30_000 });
    const box = (await card.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(1280);
    expect(box.width).toBeLessThanOrEqual(800);
    await page.screenshot({ path: '.shots/ai-card-touch.png' });

    // Tapping the page outside the card closes it.
    await page.locator('.pdf-page[data-page="2"]').tap({ position: { x: 20, y: 20 } });
    await expect(card).toHaveCount(0);
  });
});
