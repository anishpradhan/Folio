import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { FIX, currentPage, openBook, selectWord, trackErrors, upload } from './helpers';

// A real response shape from https://api.dictionaryapi.dev (trimmed) — the app performs a real
// fetch; the test intercepts it so it is deterministic and works offline.
const SERENDIPITY = [
  {
    word: 'serendipity',
    phonetic: '/ˌsɛɹ.ənˈdɪp.ɪ.ti/',
    phonetics: [{ text: '/ˌsɛɹ.ənˈdɪp.ɪ.ti/', audio: '' }],
    meanings: [
      {
        partOfSpeech: 'noun',
        definitions: [{ definition: 'A combination of events which have come together by chance to make a surprisingly good or wonderful outcome.', example: 'It was pure serendipity that we met.', synonyms: [] }],
        synonyms: ['chance', 'fluke'],
      },
    ],
    sourceUrls: ['https://en.wiktionary.org/wiki/serendipity'],
  },
];

test('dictionary lookup → save word → vocabulary notebook → back to source', async ({ page }) => {
  let calls = 0;
  await page.route('https://api.dictionaryapi.dev/**', (route) => {
    calls++;
    const word = decodeURIComponent(route.request().url().split('/').pop()!);
    if (word === 'serendipity') return route.fulfill({ json: SERENDIPITY });
    return route.fulfill({ status: 404, json: { title: 'No Definitions Found' } });
  });
  await openBook(page);
  await page.getByTestId('next-page').click();
  await expect(page.locator('.pdf-page[data-page="2"] .textLayer span').first()).toBeAttached();
  await selectWord(page, 'serendipity');
  await page.getByTestId('sel-define').click();
  const dict = page.getByTestId('dictionary');
  await expect(page.getByTestId('dict-word')).toHaveText('serendipity');
  await expect(dict).toContainText('noun');
  await expect(dict).toContainText('surprisingly good');
  await expect(dict).toContainText('It was pure serendipity');
  await expect(dict).toContainText('chance');
  await page.screenshot({ path: '.shots/dictionary.png' });
  await page.getByTestId('dict-save').click();
  await expect(page.getByTestId('dict-save')).toHaveText(/In vocabulary/);
  expect(calls).toBeGreaterThan(0);

  await page.goto('/#/vocabulary');
  await expect(page.getByTestId('vocab-item')).toHaveCount(1);
  await expect(page.getByTestId('vocab-item')).toContainText('serendipity');
  await expect(page.getByTestId('vocab-item')).toContainText('particular serendipity'); // context sentence
  await page.getByRole('checkbox', { name: /Mark serendipity as learned/ }).click();
  await expect(page.getByRole('checkbox', { name: /still learning/ })).toBeVisible();
  await page.screenshot({ path: '.shots/vocabulary.png' });
  await page.getByTestId('vocab-source').click();
  await expect(page.getByTestId('reader')).toBeVisible();
  await expect.poll(() => currentPage(page)).toBe('2');
});

test('unknown words show a graceful not-found state', async ({ page }) => {
  await page.route('https://api.dictionaryapi.dev/**', (route) => route.fulfill({ status: 404, json: { title: 'No Definitions Found' } }));
  await openBook(page);
  await page.getByTestId('next-page').click();
  await expect(page.locator('.pdf-page[data-page="2"] .textLayer span').first()).toBeAttached();
  await selectWord(page, 'serendipity');
  await page.getByTestId('sel-define').click();
  await expect(page.getByTestId('dictionary')).toContainText('No entry for');
});

test('My Insights gathers saved items and jumps to the source', async ({ page }) => {
  await openBook(page);
  await page.getByTestId('next-page').click();
  await expect(page.locator('.pdf-page[data-page="2"] .textLayer span').first()).toBeAttached();
  await selectWord(page, 'marginalia');
  await page.getByTestId('hl-blue').click();
  await expect(page.locator('.hl-rect.hl-blue')).toHaveCount(1);
  await page.locator('body').press('b');

  await page.goto('/#/insights');
  await expect(page.getByTestId('insight-item')).toHaveCount(2);
  await page.getByRole('radio', { name: 'Highlights' }).click();
  await expect(page.getByTestId('insight-item')).toHaveCount(1);
  await expect(page.getByTestId('insight-item')).toContainText('marginalia');
  await page.getByTestId('insights-search').fill('nothing-like-this');
  await expect(page.getByTestId('insight-item')).toHaveCount(0);
  await page.getByTestId('insights-search').fill('margin');
  await page.screenshot({ path: '.shots/insights.png' });
  await page.getByTestId('insight-jump').click();
  await expect(page.getByTestId('reader')).toBeVisible();
  await expect.poll(() => currentPage(page)).toBe('2');
  await expect(page.locator('.hl-rect.hl-blue')).toHaveCount(1);
});

test('reading preferences apply and persist', async ({ page }) => {
  await openBook(page);
  await page.getByTestId('open-preferences').click();
  await page.getByTestId('preset-sepia').click();
  await expect(page.getByTestId('preset-sepia')).toHaveAttribute('aria-pressed', 'true');
  const filter = await page.locator('main.reader-stage').evaluate((e) => getComputedStyle(e).getPropertyValue('--page-filter'));
  expect(filter).toContain('sepia');
  await page.screenshot({ path: '.shots/preferences.png' });
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByTestId('reader')).toBeVisible();
  await page.getByTestId('open-preferences').click();
  await expect(page.getByTestId('preset-sepia')).toHaveAttribute('aria-pressed', 'true');

  // Dark pages toggle via keyboard shortcut
  await page.keyboard.press('Escape');
  await page.locator('body').press('d');
  await expect(page.getByTestId('reader')).toHaveClass(/inverted/);
});

test('library: unsupported files, search, favorites, collections and removal', async ({ page }) => {
  const errors = trackErrors(page);
  await upload(page, 'quiet-art.pdf');
  await page.getByTestId('file-input').setInputFiles(resolve(FIX, 'plain-notes.pdf'));
  await expect(page.getByTestId('book-card')).toHaveCount(2);

  // Unsupported file → clear error state
  await page.getByTestId('file-input').setInputFiles(resolve(FIX, 'not-a-pdf.docx'));
  await expect(page.getByTestId('upload-status')).toContainText(/\.docx files aren't supported/);

  // Duplicate detection
  await page.getByTestId('file-input').setInputFiles(resolve(FIX, 'quiet-art.pdf'));
  await expect(page.getByText(/already on your shelf/)).toBeVisible();
  await expect(page.getByTestId('book-card')).toHaveCount(2);

  // Search by author metadata
  await page.getByLabel('Search library').fill('vance');
  await expect(page.getByTestId('book-card')).toHaveCount(1);
  await page.getByLabel('Search library').fill('');

  // Favorite
  await page.getByTestId('book-card').filter({ hasText: 'Quiet Art' }).hover();
  await page.getByTestId('book-card').filter({ hasText: 'Quiet Art' }).getByRole('button', { name: 'Add to favorites' }).click();
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(page.getByTestId('book-card')).toHaveCount(1);

  // Collection
  await page.getByRole('button', { name: 'New collection' }).click();
  await page.getByLabel('New collection name').fill('Essays');
  await page.getByLabel('New collection name').press('Enter');
  await expect(page.getByRole('heading', { name: 'Essays' })).toBeVisible();
  await expect(page.getByText('This collection is empty')).toBeVisible();
  await page.goto('/#/');
  await page.getByRole('button', { name: /More options for The Quiet Art/ }).click();
  await page.getByRole('menuitem', { name: /Details & collections/ }).click();
  await page.getByRole('button', { name: 'Essays' }).last().click();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('aside').getByRole('button', { name: 'Essays', exact: true }).click();
  await expect(page.getByTestId('book-card')).toHaveCount(1);

  // Remove with undo
  await page.goto('/#/');
  await page.getByRole('button', { name: /More options for Plain notes/ }).click();
  await page.getByRole('menuitem', { name: 'Remove from library' }).click();
  await expect(page.getByTestId('book-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('book-card')).toHaveCount(2);
  await page.screenshot({ path: '.shots/library-full.png' });
  expect(errors).toEqual([]);
});

test('documents without an outline show real metadata and pages, not invented chapters', async ({ page }) => {
  await openBook(page, 'plain-notes.pdf');
  await expect(page.getByTestId('left-sidebar')).toContainText("doesn’t include a table of contents");
  await expect(page.getByTestId('left-sidebar')).toContainText('Pages');
  await expect(page.getByTestId('left-sidebar')).toContainText('Meeting notes, part 2');
  await page.getByRole('tab', { name: 'Pages' }).click();
  await expect(page.getByTestId('thumb')).toHaveCount(3);
  await page.getByTestId('thumb').nth(2).click();
  await expect.poll(() => currentPage(page)).toBe('3');
});

test('journal entries and reading goals', async ({ page }) => {
  await upload(page, 'quiet-art.pdf');
  await page.goto('/#/journal');
  await page.getByTestId('journal-new').click();
  await page.getByTestId('journal-title').fill('On slow reading');
  await page.getByTestId('journal-body').fill('Reading slowly lets the sentence open.');
  await page.getByRole('radio', { name: 'Takeaways' }).click();
  await page.getByTestId('journal-editor').getByLabel('Book').selectOption({ label: 'The Quiet Art of Reading' });
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 5000 });
  await page.reload();
  await expect(page.getByTestId('journal-entry')).toContainText('On slow reading');
  await page.getByTestId('journal-entry').click();
  await expect(page.getByTestId('journal-body')).toHaveValue('Reading slowly lets the sentence open.');

  await page.goto('/#/stats');
  await page.getByTestId('goal-new').click();
  await page.getByRole('radio', { name: /Minutes each day/ }).click();
  await page.getByLabel('Minutes per day').fill('30');
  await page.getByRole('button', { name: 'Set goal' }).click();
  await expect(page.getByTestId('goal')).toContainText('Read for 30 minutes a day');
  await page.screenshot({ path: '.shots/stats.png', fullPage: true });
});

test('reading position is restored when reopening a document', async ({ page }) => {
  await openBook(page);
  await page.getByTestId('page-input').click();
  await page.getByTestId('page-input').fill('6');
  await page.getByTestId('page-input').press('Enter');
  await expect.poll(() => currentPage(page)).toBe('6');
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: 'Back to library' }).click();
  await expect(page.getByText('Continue reading')).toBeVisible();
  await expect(page.getByText(/Page 6 of 10/)).toBeVisible();
  await page.getByText(/Page 6 of 10/).click();
  await expect.poll(() => currentPage(page)).toBe('6');
  await expect(page.getByTestId('zoom-level')).toContainText('%');
});
