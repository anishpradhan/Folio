import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIX, currentPage, openBook, trackErrors, upload } from './helpers';

/**
 * Document chat (phase 4) against the hermetic AI backend (see playwright.config.ts): real Docling parsing,
 * chunking, local embeddings and retrieval, with a scripted model that quotes and cites its sources.
 */

const AI = 'http://127.0.0.1:8766/api/ai';
const HASH = createHash('sha256').update(readFileSync(resolve(FIX, 'quiet-art.pdf'))).digest('hex');

test.beforeAll(async ({ request }) => {
  const ok = await request.get(`${AI}/health`).then((r) => r.ok(), () => false);
  test.skip(!ok, 'AI e2e backend not running (FOLIO_E2E_AI=0?)');
});

test.beforeEach(async ({ request }) => {
  // Conversations persist in the e2e backend between tests; start each test without any.
  const r = await request.get(`${AI}/documents/${HASH}/conversations`);
  if (r.ok()) for (const c of await r.json()) await request.delete(`${AI}/conversations/${c.id}`);
});

async function openAsk(page: Page) {
  await openBook(page, 'quiet-art.pdf');
  if (!(await page.getByTestId('right-sidebar').isVisible())) await page.getByTestId('toggle-notebook').click();
  await page.getByTestId('tab-ask').click();
}

/** Prepare the document if the backend doesn't have it yet (the first run parses it with Docling). */
async function ensureReady(page: Page) {
  const prepare = page.getByTestId('ask-prepare');
  const chat = page.getByTestId('ask-chat');
  await expect(prepare.or(chat).or(page.getByTestId('ask-preparing'))).toBeVisible({ timeout: 20_000 });
  if (await prepare.isVisible()) await prepare.click();
  await expect(chat).toBeVisible({ timeout: 240_000 });
}

async function askAndWait(page: Page, question: string) {
  await page.getByTestId('ask-input').fill(question);
  await page.getByTestId('ask-input').press('Enter');
  const answer = page.getByTestId('ask-answer').last();
  await expect(answer).toHaveAttribute('data-status', /complete|error|refused|interrupted/, { timeout: 30_000 });
  return answer;
}

test('prepare a document, ask a suggested question, and follow a citation to the page', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = trackErrors(page);
  await openAsk(page);
  const prepare = page.getByTestId('ask-prepare');
  const chat = page.getByTestId('ask-chat');
  // Wait for the panel to settle: a fresh e2e backend hasn't seen the document; a reused one may have.
  await expect(prepare.or(chat)).toBeVisible({ timeout: 20_000 });
  if (await prepare.isVisible()) {
    await prepare.click();
    // Live progress while the quick pass reads the text layer and indexes the passages (it can be quick).
    const preparing = page.getByTestId('ask-preparing');
    await expect(preparing.or(chat)).toBeVisible();
    if (await preparing.isVisible()) await expect(preparing).toContainText(/Reading the document|Waiting to start|Splitting|Indexing|Saving|Ready/);
    // Questions work from the quick pass, long before Docling has read the layout…
    await expect(chat).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('ask-refining')).toBeVisible();
    // …and the note goes away when the full pass has replaced the quick passages.
    await expect(page.getByTestId('ask-refining')).toHaveCount(0, { timeout: 240_000 });
  }
  await expect(chat).toBeVisible({ timeout: 240_000 });

  // Suggested questions on an empty conversation.
  await expect(page.getByTestId('ask-empty')).toBeVisible();
  const suggestion = page.getByTestId('ask-suggestion').first();
  await expect(page.getByTestId('ask-suggestion')).toHaveCount(4);
  const asked = (await suggestion.textContent())!;
  await suggestion.click();

  await expect(page.getByTestId('ask-question').last()).toHaveText(asked);
  const answer = page.getByTestId('ask-answer').last();
  await expect(answer).toHaveAttribute('data-status', 'complete', { timeout: 30_000 });
  await expect(answer).toContainText('The document says');
  const chips = answer.getByTestId('citation-chip');
  await expect(chips.first()).toBeVisible();
  expect(await chips.count()).toBeGreaterThanOrEqual(1);
  await expect(answer.getByTestId('ask-source').first()).toBeVisible();

  // Following a citation: go to its page and flash the quoted passage there.
  const chip = chips.last();
  const target = Number(await chip.getAttribute('data-page'));
  await page.getByTestId('page-input').fill('1');
  await page.getByTestId('page-input').press('Enter');
  await chip.click();
  await expect.poll(() => currentPage(page)).toBe(String(target));
  const flashed = page.locator(`[data-testid="citation-flash"][data-page="${target}"] .cite-rect`);
  await expect(flashed.first()).toBeVisible();
  // The quote was matched in the text layer: line-sized boxes, not one paragraph box.
  const box = await flashed.first().boundingBox();
  expect(box!.height).toBeLessThan(40);
  await expect(flashed).toHaveCount(0, { timeout: 8_000 }); // and it fades away

  expect(errors).toEqual([]);
});

test('follow-ups stay in the conversation, which is restored after a reload', async ({ page }) => {
  await openAsk(page);
  await ensureReady(page);
  await askAndWait(page, 'What does the author say about attention?');
  const second = await askAndWait(page, 'And why does that matter?');
  await expect(second).toContainText('Follow-up 2 in this conversation');

  await page.reload();
  await expect(page.getByTestId('reader')).toBeVisible();
  if (!(await page.getByTestId('right-sidebar').isVisible())) await page.getByTestId('toggle-notebook').click();
  await page.getByTestId('tab-ask').click();
  await expect(page.getByTestId('ask-question')).toHaveCount(2);
  await expect(page.getByTestId('ask-answer')).toHaveCount(2);
  await expect(page.getByTestId('ask-answer').last().getByTestId('citation-chip').first()).toBeVisible();
  await expect(page.getByTestId('ask-conversation').locator('option:checked')).toHaveText('What does the author say about attention?');

  // A new conversation starts empty; the old one is still listed.
  await page.getByTestId('ask-conversation').selectOption('');
  await expect(page.getByTestId('ask-empty')).toBeVisible();
  await expect(page.getByTestId('ask-conversation').locator('option')).toHaveCount(2);
});

test('stopping an answer keeps what was written', async ({ page }) => {
  await openAsk(page);
  await ensureReady(page);
  await page.getByTestId('ask-input').fill('Tell me slowly about attention');
  await page.getByTestId('ask-input').press('Enter');
  const answer = page.getByTestId('ask-answer').last();
  await expect(answer).toContainText('part 2', { timeout: 20_000 });
  await page.getByTestId('ask-stop').click();
  await expect(answer).toHaveAttribute('data-status', 'interrupted');
  await expect(answer).toContainText('Stopped.');
  const partial = await answer.locator('.answer').textContent();
  await expect(page.getByTestId('ask-send')).toBeVisible();

  // The backend stored the partial answer as interrupted.
  await page.reload();
  await expect(page.getByTestId('reader')).toBeVisible();
  await page.getByTestId('tab-ask').click();
  const stored = page.getByTestId('ask-answer').last();
  await expect(stored).toHaveAttribute('data-status', 'interrupted');
  expect((await stored.locator('.answer').textContent())!.length).toBeGreaterThan(20);
  expect(partial!.length).toBeGreaterThan(20);
});

test('a declined answer is shown as such', async ({ page }) => {
  await openAsk(page);
  await ensureReady(page);
  const answer = await askAndWait(page, 'Please decline this one');
  await expect(answer).toHaveAttribute('data-status', 'refused');
  await expect(answer).toContainText('The assistant declined to answer this request.');
});

test('"Only this section" limits the search to the section around the current page', async ({ page }) => {
  await openAsk(page);
  await ensureReady(page);
  await page.getByTestId('page-input').fill('5');
  await page.getByTestId('page-input').press('Enter');
  await page.getByTestId('ask-scope').check();
  const sent = page.waitForRequest((r) => r.url().includes('/messages') && r.method() === 'POST');
  await page.getByTestId('ask-input').fill('What is this section about?');
  await page.getByTestId('ask-input').press('Enter');
  const body = (await sent).postDataJSON();
  expect(body.page_start).toBeLessThanOrEqual(5);
  expect(body.page_end).toBeGreaterThanOrEqual(5);
  expect(body.page_end - body.page_start).toBeLessThan(14);
  await expect(page.getByTestId('ask-answer').last()).toHaveAttribute('data-status', 'complete', { timeout: 30_000 });
  for (const chip of await page.getByTestId('ask-answer').last().getByTestId('citation-chip').all()) {
    const p = Number(await chip.getAttribute('data-page'));
    expect(p).toBeGreaterThanOrEqual(body.page_start);
    expect(p).toBeLessThanOrEqual(body.page_end);
  }
});

test('offline backend, missing key and failed preparation are explained', async ({ page }) => {
  // Offline: the health check fails; "Try again" recovers once the backend answers.
  await page.route('**/api/ai/health', (r) => r.abort());
  await openAsk(page);
  await expect(page.getByTestId('ask-offline')).toBeVisible();
  await page.unroute('**/api/ai/health');

  // No API key: the chat shows how to configure it instead of a question box.
  await page.route('**/api/ai/health', async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    await r.fulfill({ response: res, json: { ...body, llm: { ...body.llm, configured: false } } });
  });
  await page.getByTestId('ask-reconnect').click();
  await ensureReady(page);
  await expect(page.getByTestId('ask-not-configured')).toBeVisible();
  await expect(page.getByTestId('ask-input')).toHaveCount(0);
});

test('a failed preparation shows the reason and can be retried', async ({ page }) => {
  await page.route(`**/api/ai/documents/${HASH}`, (r) =>
    r.request().method() === 'GET'
      ? r.fulfill({ json: { id: HASH, title: 'x', pageCount: 14, status: 'failed', progress: 0, detail: null, error: 'No text was found in this PDF.', chunkCount: 0 } })
      : r.continue(),
  );
  await openAsk(page);
  await expect(page.getByTestId('ask-prepare-error')).toHaveText('No text was found in this PDF.');
  await expect(page.getByTestId('ask-retry-prepare')).toBeVisible();
});

test('EPUB books say the assistant is not available yet', async ({ page }) => {
  await upload(page, 'lantern-keeper.epub');
  await page.getByTestId('book-card').first().getByRole('button').first().click();
  await expect(page.getByTestId('reader')).toBeVisible();
  if (!(await page.getByTestId('right-sidebar').isVisible())) await page.getByTestId('toggle-notebook').click();
  await page.getByTestId('tab-ask').click();
  await expect(page.getByText('Not available for EPUB yet')).toBeVisible();
});
