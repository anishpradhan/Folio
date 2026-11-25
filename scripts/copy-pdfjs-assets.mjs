// Copies pdf.js character maps and standard font data into public/ so they are served
// alongside the app (needed for CJK text and PDFs that don't embed their fonts).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/pdfjs-dist');
const dest = resolve(root, 'public/pdfjs');

for (const dir of ['cmaps', 'standard_fonts']) {
  const to = resolve(dest, dir);
  if (existsSync(to)) continue;
  mkdirSync(to, { recursive: true });
  cpSync(resolve(src, dir), to, { recursive: true });
  console.log(`[folio] copied pdf.js ${dir}`);
}
