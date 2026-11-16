/* Diagnostic: splits an exported SVG into variants (no images, no text, no
   vectors, no effects, top half, bottom half) so each can be dragged into Figma
   to find what stops it importing as layers.
   Usage: PLAYWRIGHT_MODULE=<path> node tests/bisect.cjs <file.svg> [outDir] */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const input = process.argv[2], out = process.argv[3] || path.join(path.dirname(input), 'bisect');
(async () => {
  const source = await fs.readFile(input, 'utf8');
  const browser = await chromium.launch({ headless: true, channel: process.env.CHROME_CHANNEL || 'chrome' });
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(text => {
      const parse = () => new DOMParser().parseFromString(text, 'image/svg+xml');
      const first = parse(), error = first.querySelector('parsererror');
      if (error) return { error: error.textContent.slice(0, 400) };
      const write = doc => new XMLSerializer().serializeToString(doc);
      const variants = {};
      const make = (name, edit) => { const doc = parse(); edit(doc, doc.documentElement); variants[name] = write(doc); };
      const body = root => [...root.children].filter(el => el.localName !== 'defs');
      make('1-no-images', (doc, root) => {
        doc.querySelectorAll('[fill^="url(#pattern"]').forEach(el => el.setAttribute('fill', '#8a8a8a'));
        doc.querySelectorAll('pattern, defs > image').forEach(el => el.remove());
      });
      make('2-no-text', doc => doc.querySelectorAll('text').forEach(el => el.remove()));
      make('3-no-vector-icons', doc => doc.querySelectorAll('g[transform]').forEach(el => el.remove()));
      make('4-no-shadows-clips-gradients', doc => {
        doc.querySelectorAll('[filter]').forEach(el => el.removeAttribute('filter'));
        doc.querySelectorAll('[clip-path]').forEach(el => el.removeAttribute('clip-path'));
        doc.querySelectorAll('[fill^="url(#paint"]').forEach(el => el.setAttribute('fill', '#444444'));
        doc.querySelectorAll('filter, clipPath').forEach(el => el.remove());
      });
      // Halves: descend through single-child wrappers to the first level with several sections, then keep half of them.
      const sections = root => { let level = body(root).filter(el => el.localName === 'g'); let parent = level[level.length - 1]; while (parent && [...parent.children].filter(el => el.localName === 'g').length < 4 && parent.querySelector(':scope > g')) parent = [...parent.children].filter(el => el.localName === 'g').sort((a, b) => b.querySelectorAll('*').length - a.querySelectorAll('*').length)[0]; return parent ? [...parent.children] : []; };
      make('5-first-half', (doc, root) => { const list = sections(root); list.slice(Math.ceil(list.length / 2)).forEach(el => el.remove()); });
      make('6-second-half', (doc, root) => { const list = sections(root); list.slice(0, Math.ceil(list.length / 2)).forEach(el => el.remove()); });
      const count = doc => ({ elements: doc.querySelectorAll('*').length, text: doc.querySelectorAll('text').length, images: doc.querySelectorAll('defs > image').length });
      return { variants, original: count(first), sectionCount: sections(first.documentElement).length };
    }, source);
    if (result.error) { console.log('XML is not well-formed:', result.error); return; }
    await fs.mkdir(out, { recursive: true });
    for (const [name, text] of Object.entries(result.variants)) { await fs.writeFile(path.join(out, `${name}.svg`), text); console.log(name, (text.length / 1048576).toFixed(2) + ' MB'); }
    console.log('well-formed XML;', JSON.stringify(result.original), 'sections at split level:', result.sectionCount);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
