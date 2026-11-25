import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { FIX, trackErrors } from './helpers';

/**
 * Add-from-link, end to end through Folio's real download proxy. A tiny local "journal site"
 * stands in for the web (the dev server runs with FOLIO_LINK_ALLOW_PRIVATE=1 so it may reach it).
 */
let site: Server;
let origin = '';

test.beforeAll(async () => {
  const pdf = readFileSync(resolve(FIX, 'plain-notes.pdf'));
  const epub = readFileSync(resolve(FIX, 'lantern-keeper.epub'));
  site = createServer((req, res) => {
    const path = req.url ?? '/';
    if (path === '/article/7') {
      // A landing page: the PDF hides behind citation_pdf_url, as on most publisher sites.
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><html><head><title>Article</title>
        <meta name="citation_title" content="Notes on Plain Reading">
        <meta name="citation_author" content="Reed, Ada"><meta name="citation_author" content="Page, Ben">
        <meta name="citation_pdf_url" content="/download?id=7"></head><body>Abstract…</body></html>`);
    }
    if (path === '/download?id=7') {
      res.writeHead(302, { Location: '/files/notes-7.pdf' });
      return res.end();
    }
    if (path === '/files/notes-7.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length });
      return res.end(pdf);
    }
    if (path === '/books/lantern') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="lantern-keeper.epub"' });
      return res.end(epub);
    }
    if (path === '/blog') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><body><p>Just a blog post.</p></body></html>');
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
test.afterAll(() => new Promise<void>((r) => site.close(() => r())));

async function addLink(page: import('@playwright/test').Page, link: string) {
  await page.getByTestId('add-link').click();
  await page.getByTestId('link-input').fill(link);
  await page.getByTestId('link-input').press('Enter');
}

test('add a paper from its landing page; title, authors and source come from the page', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await addLink(page, `${origin}/article/7`);
  await expect(page.getByTestId('book-card')).toHaveCount(1, { timeout: 30_000 });
  const card = page.getByTestId('book-card').first();
  await expect(card).toContainText('Notes on Plain Reading');
  await expect(card).toContainText('Ada Reed, Ben Page');

  // Details record where it came from.
  await card.hover();
  await card.getByRole('button', { name: /more/i }).click();
  await page.getByRole('menuitem', { name: /details/i }).click();
  await expect(page.getByTestId('doc-source')).toHaveAttribute('href', `${origin}/article/7`);
  await expect(page.getByRole('dialog')).toContainText('notes-7.pdf');
  await page.keyboard.press('Escape');

  // It opens like any other book.
  await card.getByRole('button').first().click();
  await expect(page.locator('.pdf-page[data-page="1"] canvas')).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('an EPUB behind a download link, a paste, and helpful failures', async ({ page }) => {
  await page.goto('/');
  // Pasting a link onto the library opens the dialog, filled in.
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, `${origin}/books/lantern`);
  await expect(page.getByTestId('link-input')).toHaveValue(`${origin}/books/lantern`);
  await page.getByTestId('link-submit').click();
  await expect(page.getByTestId('book-card')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('book-card').first()).toContainText('The Lantern Keeper');

  // A page with no document on it.
  await addLink(page, `${origin}/blog`);
  const status = page.getByTestId('upload-status');
  await expect(status).toContainText('doesn’t link to a PDF');
  // A missing file; retrying keeps a single tile.
  await status.getByRole('button', { name: 'Dismiss' }).click();
  await addLink(page, `${origin}/nothing.pdf`);
  await expect(status).toContainText('Nothing was found at that link (404)');
  await status.getByRole('button', { name: 'Try again' }).click();
  await expect(status).toHaveCount(1);
  await expect(status).toContainText('(404)');

  // Not a link at all: the dialog says so and stays open.
  await page.getByTestId('add-link').click();
  await page.getByTestId('link-input').fill('just some words');
  await page.getByTestId('link-submit').click();
  await expect(page.getByRole('alert')).toContainText('doesn’t look like a web link');
  await page.screenshot({ path: '.shots/link-dialog.png' });
});
