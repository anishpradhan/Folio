import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIX, openBook, selectWord, trackErrors } from './helpers';

/**
 * Saving answers to the reader's own notes (phase 6), against the hermetic AI backend: from the selection card
 * as a highlight with a note, a page note or a journal entry; from the chat as a page note or journal entry.
 * The results show in the notebook, My Insights and the Journal like hand-written notes.
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

async function explainInCard(page: Page) {
  await openBook(page, 'quiet-art.pdf');
  await page.getByTestId('next-page').click();
  await expect(page.locator('.pdf-page[data-page="2"] .textLayer span').first()).toBeAttached();
  await selectWord(page, LINE);
  await page.getByTestId('sel-ask-ai').click();
  const card = page.getByTestId('ai-card');
  const prepare = card.getByTestId('ai-prepare');
  const explain = card.getByTestId('ai-mode-explain');
  await expect(prepare.or(explain).or(card.getByTestId('ai-preparing'))).toBeVisible({ timeout: 20_000 });
  if (await prepare.isVisible()) await prepare.click();
  await expect(explain).toBeVisible({ timeout: 240_000 });
  await explain.click();
  await expect(card.getByTestId('ai-answer')).toHaveAttribute('data-status', 'complete', { timeout: 30_000 });
  return card;
}

async function openNotebookTab(page: Page, tab: string) {
  if (!(await page.getByTestId('right-sidebar').isVisible())) await page.getByTestId('toggle-notebook').click();
  await page.getByTestId(`tab-${tab}`).click();
}

test('an explanation saved from the card becomes a highlight note, a page note and a journal entry', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = trackErrors(page);
  const card = await explainInCard(page);

  // Highlight + note: the selection is highlighted, with the answer (page references in place of chips) as its note.
  await card.getByTestId('save-answer').click();
  await card.getByTestId('save-highlight').click();
  await expect(page.getByText('Saved as a highlight note')).toBeVisible();
  await expect(page.locator('.pdf-page[data-page="2"] .hl-rect.hl-yellow')).toHaveCount(1);
  await expect(card.getByTestId('save-answer')).toHaveText('Saved');

  // Page note, on the first cited page.
  await card.getByTestId('save-answer').click();
  await expect(card.getByTestId('save-highlight')).toBeDisabled(); // already saved that way
  await card.getByTestId('save-note').click();
  await expect(page.getByText(/Saved as a page note · Page \d+/)).toBeVisible();

  // Journal entry.
  await card.getByTestId('save-answer').click();
  await card.getByTestId('save-journal').click();
  await expect(page.getByText('Saved to your journal')).toBeVisible();
  await page.screenshot({ path: '.shots/ai-save-card.png' });
  await page.keyboard.press('Escape');

  await openNotebookTab(page, 'highlights');
  const hl = page.getByTestId('sidebar-highlight');
  await expect(hl).toHaveCount(1);
  await expect(hl).toContainText(LINE);
  await expect(hl).toContainText(/The document says: .*\(p\. \d+\)/);

  await page.getByTestId('tab-notes').click();
  const note = page.getByTestId('sidebar-note');
  await expect(note).toHaveCount(1);
  await expect(note.locator('textarea')).toHaveValue(new RegExp(`^Explanation: “${LINE.replace('.', '\\.')}”\\n\\n“${LINE.replace('.', '\\.')}”\\n\\nThe document says: .*\\(p\\. \\d+\\)`, 's'));

  // My Insights lists the highlight (with its note) and the page note, like hand-written ones.
  await page.goto('/#/insights');
  const items = page.getByTestId('insight-item');
  await expect(items).toHaveCount(2);
  await expect(items.filter({ hasText: LINE }).first()).toContainText('The document says');

  // The journal entry is linked to the book.
  await page.goto('/#/journal');
  const entry = page.getByTestId('journal-entry');
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText(`Explanation: “${LINE}”`);
  await expect(entry).toContainText('The Quiet Art of Reading');
  expect(errors).toEqual([]);
});

test('a chat answer saves as a page note or a journal entry, and Undo takes it back', async ({ page }) => {
  test.setTimeout(300_000);
  await explainInCard(page); // also makes sure the document is prepared
  await page.keyboard.press('Escape');
  await openNotebookTab(page, 'ask');
  await page.getByTestId('ask-conversation').selectOption('');
  await page.getByTestId('ask-input').fill('What does the author say about attention?');
  await page.getByTestId('ask-input').press('Enter');
  const answer = page.getByTestId('ask-answer').last();
  await expect(answer).toHaveAttribute('data-status', 'complete', { timeout: 30_000 });

  // No highlight option in the chat: there is no selection to highlight.
  await answer.getByTestId('save-answer').click();
  await expect(answer.getByTestId('save-highlight')).toHaveCount(0);
  await answer.getByTestId('save-journal').click();
  await expect(page.getByText('Saved to your journal')).toBeVisible();

  await answer.getByTestId('save-answer').click();
  await answer.getByTestId('save-note').click();
  await expect(page.getByText(/Saved as a page note · Page \d+/)).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).last().click();
  await expect(answer.getByTestId('save-answer')).toHaveText('Saved'); // the journal entry is still saved
  await page.getByTestId('tab-notes').click();
  await expect(page.getByTestId('sidebar-note')).toHaveCount(0);

  await page.goto('/#/journal');
  const entry = page.getByTestId('journal-entry');
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('What does the author say about attention?');
  await entry.click();
  await expect(page.getByTestId('journal-body')).toHaveValue(/The document says: .*\(p\. \d+\)/s);
});
