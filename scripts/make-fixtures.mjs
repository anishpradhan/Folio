// Generates test fixtures in tests/fixtures/:
//   quiet-art.pdf   — 10-page "book" with metadata, a nested outline and varied text
//   plain-notes.pdf — 3 pages, no outline, no metadata title
//   not-a-pdf.docx  — random bytes with a .docx name (unsupported-file state)
import { PDFDocument, StandardFonts, rgb, PDFName, PDFHexString, PDFNull, PDFNumber } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures');
mkdirSync(out, { recursive: true });

const PARAS = [
  'Reading is a slow art. It asks for patience, for a willingness to stay with a sentence until it opens. The best books are not consumed; they are inhabited, room by room, until their furniture feels familiar.',
  'There is a particular serendipity in finding the right passage at the right moment. A line read years ago returns, luminous, when life finally catches up with it. This is why we keep marginalia: small notes to a future self.',
  'Attention is the scarce resource of our age. Every interface competes for it, and most of them win by fragmenting it. A good reading environment does the opposite. It gathers attention and gives it somewhere quiet to rest.',
  'The ephemeral and the enduring live side by side on every page. Typography, spacing and the colour of the paper are not decoration; they are the conditions under which thought becomes possible.',
  'Consider the humble bookmark. It is a promise to return, a thread through the labyrinth. Without it, every interruption becomes a small loss, and the reader must search again for the place where meaning was left.',
  'Highlighting is an act of conversation. When we mark a passage we are saying: this matters, remember this. Over time, the highlights become a map of what we cared about, and sometimes a portrait of who we were.',
];

const CHAPTERS = [
  { title: 'Preface', sections: [] },
  { title: 'Chapter One: The Slow Art', sections: ['On Patience', 'The Furniture of Books'] },
  { title: 'Chapter Two: Attention', sections: ['A Scarce Resource', 'Quiet Rooms'] },
  { title: 'Chapter Three: Marginalia', sections: ['Notes to a Future Self'] },
  { title: 'Chapter Four: Return', sections: ['The Humble Bookmark', 'Maps of What We Cared About'] },
  { title: 'Afterword', sections: [] },
];

function wrap(text, font, size, width) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(t, size) > width && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

async function makeBook() {
  const pdf = await PDFDocument.create();
  pdf.setTitle('The Quiet Art of Reading');
  pdf.setAuthor('Eleanor Vance');
  pdf.setSubject('Essays on attention, books and the reading life');
  pdf.setKeywords(['reading', 'attention', 'marginalia']);
  pdf.setProducer('Folio fixture generator');
  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const W = 432,
    H = 648,
    M = 54;

  const outline = []; // { title, pageIndex, children }
  let pageNo = 0;
  const newPage = () => {
    const p = pdf.addPage([W, H]);
    pageNo++;
    p.drawText(String(pageNo), { x: W / 2 - 4, y: 28, size: 9, font: serif, color: rgb(0.45, 0.45, 0.45) });
    return p;
  };

  // Title page
  const tp = newPage();
  tp.drawText('The Quiet Art', { x: M, y: H - 220, size: 34, font: bold });
  tp.drawText('of Reading', { x: M, y: H - 260, size: 34, font: bold });
  tp.drawText('Eleanor Vance', { x: M, y: H - 310, size: 14, font: italic });

  let pi = 0;
  for (const ch of CHAPTERS) {
    let page = newPage();
    const chNode = { title: ch.title, pageIndex: pageNo - 1, children: [] };
    outline.push(chNode);
    let y = H - 110;
    page.drawText(ch.title, { x: M, y, size: 20, font: bold });
    y -= 40;
    const blocks = ch.sections.length ? ch.sections : [null];
    for (const sec of blocks) {
      if (sec) {
        if (y < 160) {
          page = newPage();
          y = H - 80;
        }
        chNode.children.push({ title: sec, pageIndex: pageNo - 1, children: [] });
        page.drawText(sec, { x: M, y, size: 14, font: italic });
        y -= 28;
      }
      for (let k = 0; k < 3; k++) {
        const para = PARAS[pi++ % PARAS.length];
        const lines = wrap(para, serif, 11.5, W - 2 * M);
        if (y - lines.length * 16 < 60) {
          page = newPage();
          y = H - 80;
        }
        for (const l of lines) {
          page.drawText(l, { x: M, y, size: 11.5, font: serif });
          y -= 16;
        }
        y -= 12;
      }
    }
  }

  // ---- Outline (bookmarks) via low-level objects ----
  const ctx = pdf.context;
  const pages = pdf.getPages();
  const outlinesRef = ctx.nextRef();
  const build = (nodes, parentRef) => {
    const refs = nodes.map(() => ctx.nextRef());
    nodes.forEach((n, i) => {
      const dict = new Map();
      const d = ctx.obj({});
      d.set(PDFName.of('Title'), PDFHexString.fromText(n.title));
      d.set(PDFName.of('Parent'), parentRef);
      d.set(PDFName.of('Dest'), ctx.obj([pages[n.pageIndex].ref, PDFName.of('XYZ'), PDFNull, PDFNull, PDFNull]));
      if (i > 0) d.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < nodes.length - 1) d.set(PDFName.of('Next'), refs[i + 1]);
      if (n.children.length) {
        const kids = build(n.children, refs[i]);
        d.set(PDFName.of('First'), kids[0]);
        d.set(PDFName.of('Last'), kids[kids.length - 1]);
        d.set(PDFName.of('Count'), PDFNumber.of(n.children.length));
      }
      void dict;
      ctx.assign(refs[i], d);
    });
    return refs;
  };
  const top = build(outline, outlinesRef);
  const root = ctx.obj({});
  root.set(PDFName.of('Type'), PDFName.of('Outlines'));
  root.set(PDFName.of('First'), top[0]);
  root.set(PDFName.of('Last'), top[top.length - 1]);
  root.set(PDFName.of('Count'), PDFNumber.of(top.length));
  ctx.assign(outlinesRef, root);
  pdf.catalog.set(PDFName.of('Outlines'), outlinesRef);

  writeFileSync(resolve(out, 'quiet-art.pdf'), await pdf.save());
  console.log(`quiet-art.pdf: ${pageNo} pages`);
}

async function makePlain() {
  const pdf = await PDFDocument.create();
  const f = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const p = pdf.addPage([595, 842]);
    p.drawText(`Meeting notes, part ${i}`, { x: 60, y: 760, size: 18, font: f });
    wrap(`These plain notes have no outline. Page ${i} mentions the quarterly roadmap and the archipelago project so search has something to find.`, f, 11, 470).forEach((l, k) =>
      p.drawText(l, { x: 60, y: 720 - k * 16, size: 11, font: f }),
    );
  }
  writeFileSync(resolve(out, 'plain-notes.pdf'), await pdf.save());
  console.log('plain-notes.pdf: 3 pages');
}

async function makeLarge(pages = 400) {
  const pdf = await PDFDocument.create();
  pdf.setTitle('A Very Long Report');
  const f = await pdf.embedFont(StandardFonts.TimesRoman);
  for (let i = 1; i <= pages; i++) {
    const p = pdf.addPage([612, 792]);
    p.drawText(`Section ${Math.ceil(i / 20)} — page ${i}`, { x: 72, y: 720, size: 16, font: f });
    let y = 690;
    for (let k = 0; k < 30; k++) {
      p.drawText(`${PARAS[(i + k) % PARAS.length].slice(0, 88)}${i === 333 && k === 5 ? ' needle-in-haystack' : ''}`, { x: 72, y, size: 10.5, font: f });
      y -= 19;
    }
  }
  writeFileSync(resolve(out, 'large.pdf'), await pdf.save());
  console.log(`large.pdf: ${pages} pages`);
}

// ------------------------------------------------------------------ EPUB fixtures
const xhtml = (title, body) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><title>${title}</title><link rel="stylesheet" href="style.css"/><style>body{color:red}</style></head>
<body>${body}</body></html>`;

const COVER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
<rect width="600" height="900" fill="#2f4b3a"/><rect x="40" y="40" width="520" height="820" fill="none" stroke="#e9dcc0" stroke-width="3"/>
<text x="300" y="380" font-family="Georgia" font-size="58" fill="#f3ead6" text-anchor="middle">The Lantern</text>
<text x="300" y="450" font-family="Georgia" font-size="58" fill="#f3ead6" text-anchor="middle">Keeper</text>
<text x="300" y="560" font-family="Georgia" font-style="italic" font-size="28" fill="#d9c9a3" text-anchor="middle">Mara Ellison</text></svg>`;
const FIGURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="160"><rect width="400" height="160" fill="#c9b48a"/><circle cx="200" cy="80" r="50" fill="#f6e7b0"/></svg>`;

const CH = {
  'text/cover.xhtml': xhtml('Cover', `<section epub:type="cover"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 600 900"><image width="600" height="900" xlink:href="../images/cover.svg"/></svg></section>`),
  'text/ch1.xhtml': xhtml('One', `<h1 id="start">Chapter One: The Harbour</h1>
<p>The harbour town woke slowly, the way old towns do. Fog sat on the water like a held breath, and the gulls argued over nothing at all.</p>
<p>Ada had kept the lamp for eleven winters. It was a small, stubborn kind of serendipity that she had found the work at all, answering a notice nobody else had read.</p>
<p>Each evening she climbed the ninety-one steps and trimmed the wick. Each morning she wrote one line in the ledger: <em>All well.</em></p>`),
  'text/ch2.xhtml': xhtml('Two', `<h1>Chapter Two: Weather</h1>
<h2 id="s2a">The First Storm</h2>
<p>The lantern swung on its hook as the first storm came in from the west. She steadied it with one hand and counted the seconds between the flashes.</p>
<p>Ships remember a light the way people remember a voice — not its words, but its steadiness.</p>
<h2 id="s2b">After the Storm</h2>
<p>By dawn the sea had gone grey and polite. She polished the lantern again, because a clean glass is a kind of promise.</p>
<blockquote><p>“A light is only useful if it is the same light every night.”</p></blockquote>`),
  'text/ch3.xhtml': xhtml('Three', `<h1>Chapter Three: Letters</h1>
<p onclick="window.__pwned = true">A letter arrived with a stamp she did not recognise. The handwriting leaned forward, impatient, as if it had somewhere better to be.</p>
<script>window.__pwned = true;</script>
<iframe src="https://example.com"></iframe>
<figure><img src="../images/figure.svg" alt="A pale moon over sand"/><figcaption>The moon over the sandbar.</figcaption></figure>
<p>She read it twice, then went back to <a href="ch1.xhtml#start">the beginning of her ledger</a> to check a date. The writer had also enclosed a <a href="https://example.org/tides">tide table</a>.</p>
<p><a href="javascript:alert(1)">Click for a surprise</a> said the postscript, which she ignored.</p>`),
  'text/ch4.xhtml': xhtml('Four', `<h1>Chapter Four: The Lighthouse</h1>
<p>In the end the lighthouse was automated, as everyone had said it would be. Ada kept the ledger anyway.</p>
<p>On the last page she wrote: <strong>All well.</strong> Then, after a while, she added a second line: <em>Still well.</em></p>`),
};

const NAV = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body>
<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
<li><a href="text/ch1.xhtml">Chapter One: The Harbour</a></li>
<li><a href="text/ch2.xhtml">Chapter Two: Weather</a><ol>
  <li><a href="text/ch2.xhtml#s2a">The First Storm</a></li>
  <li><a href="text/ch2.xhtml#s2b">After the Storm</a></li></ol></li>
<li><a href="text/ch3.xhtml">Chapter Three: Letters</a></li>
<li><a href="text/ch4.xhtml">Chapter Four: The Lighthouse</a></li>
</ol></nav>
<nav epub:type="landmarks"><ol><li><a epub:type="bodymatter" href="text/ch1.xhtml">Start</a></li></ol></nav></body></html>`;

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:identifier id="uid">urn:uuid:4b1d7a8e-folio-fixture</dc:identifier>
  <dc:title>The Lantern Keeper</dc:title><dc:creator>Mara Ellison</dc:creator><dc:language>en</dc:language>
  <dc:publisher>Folio Test Press</dc:publisher><dc:subject>Fiction</dc:subject><dc:date>2021-04-12</dc:date>
  <dc:description>A short novel about a lighthouse keeper.</dc:description>
</metadata>
<manifest>
  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  <item id="cover-img" href="images/cover.svg" media-type="image/svg+xml" properties="cover-image"/>
  <item id="fig" href="images/figure.svg" media-type="image/svg+xml"/>
  <item id="css" href="text/style.css" media-type="text/css"/>
  <item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml" properties="svg"/>
  <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
  <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
  <item id="ch3" href="text/ch3.xhtml" media-type="application/xhtml+xml" properties="scripted"/>
  <item id="ch4" href="text/ch4.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine toc="ncx"><itemref idref="cover"/><itemref idref="ch1"/><itemref idref="ch2"/><itemref idref="ch3"/><itemref idref="ch4"/></spine>
</package>`;

const CONTAINER = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

function makeEpub() {
  const enc = (s) => strToU8(s);
  const files = {
    mimetype: [enc('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': enc(CONTAINER),
    'OEBPS/content.opf': enc(OPF),
    'OEBPS/nav.xhtml': enc(NAV),
    'OEBPS/toc.ncx': enc(`<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
<navPoint id="n1"><navLabel><text>NCX One</text></navLabel><content src="text/ch1.xhtml"/></navPoint></navMap></ncx>`),
    'OEBPS/images/cover.svg': enc(COVER_SVG),
    'OEBPS/images/figure.svg': enc(FIGURE_SVG),
    'OEBPS/text/style.css': enc('body { font-family: Comic Sans MS; color: red; }'),
    ...Object.fromEntries(Object.entries(CH).map(([k, v]) => [`OEBPS/${k}`, enc(v)])),
  };
  writeFileSync(resolve(out, 'lantern-keeper.epub'), zipSync(files));
  console.log('lantern-keeper.epub: 5 sections');

  // EPUB 2 flavour: NCX-only table of contents, no nav document, compressed mimetype entry,
  // sloppy (non-XML) HTML and an uppercase file name mismatch.
  const opf2 = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><dc:title>Old Almanac</dc:title><dc:creator opf:role="aut">Anonymous</dc:creator><dc:identifier id="id">almanac-1</dc:identifier></metadata>
<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="a" href="Part1.html" media-type="application/xhtml+xml"/><item id="b" href="part2.html" media-type="application/xhtml+xml"/></manifest>
<spine toc="ncx"><itemref idref="a"/><itemref idref="b"/></spine></package>`;
  const ncx2 = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
<navPoint id="p1" playOrder="1"><navLabel><text>Spring</text></navLabel><content src="Part1.html"/></navPoint>
<navPoint id="p2" playOrder="2"><navLabel><text>Summer</text></navLabel><content src="part2.html"/></navPoint></navMap></ncx>`;
  writeFileSync(
    resolve(out, 'old-almanac.epub'),
    zipSync({
      'META-INF/container.xml': enc(CONTAINER.replace('OEBPS/content.opf', 'content.opf')),
      'content.opf': enc(opf2),
      'toc.ncx': enc(ncx2),
      'part1.html': enc('<html><body><h1>Spring<p>Plant the peas when the soil is warm.<br>Mind the late frost.</body></html>'),
      'part2.html': enc('<html><body><h1>Summer</h1><p>Harvest the almanac herbs at noon.</p></body></html>'),
      mimetype: enc('application/epub+zip'),
    }),
  );
  console.log('old-almanac.epub: 2 sections (EPUB 2, NCX)');
}

await makeBook();
await makePlain();
await makeLarge();
makeEpub();
writeFileSync(resolve(out, 'not-a-pdf.docx'), Buffer.from('PK\u0003\u0004 definitely not a pdf'));
console.log('not-a-pdf.docx');
