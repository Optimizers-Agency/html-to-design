/* End-to-end check in a real Chrome: capture the fixture (or a URL passed as the
   first argument), embed images, render the Figma SVG, and save both the page
   screenshot and the SVG rendering to test-results/ for side-by-side review.
   Usage: PLAYWRIGHT_MODULE=<path to playwright-core> node tests/browser.cjs [url] [width] */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const target = process.argv[2], width = Number(process.argv[3]) || 1280;
(async () => {
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const server = http.createServer(async (req, res) => {
    try {
      const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
      if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); res.end(await fs.readFile(file));
    } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, out = path.join(root, 'test-results');
  await fs.mkdir(out, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.CHROME_CHANNEL || 'chrome' });
    const context = await browser.newContext({ viewport: { width, height: 800 }, bypassCSP: true });
    const page = await context.newPage(), name = target ? 'site' : 'fixture';
    await page.goto(target || base + '/tests/fixture.html', { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(target ? 2500 : 200);
    for (const file of ['shared.js', 'serialize.js']) await page.addScriptTag({ content: await fs.readFile(path.join(root, 'extension', file), 'utf8') });
    const started = Date.now();
    const capture = await page.evaluate(options => captureDocument(options), { mode: 'page' });
    const captureMs = Date.now() - started;
    await page.screenshot({ path: path.join(out, `${name}-page.png`), fullPage: true });

    const studio = await context.newPage();
    await studio.setContent('<!doctype html><meta charset="utf-8"><body></body>');
    await studio.exposeFunction('pageFetch', url => page.evaluate(u => pagecraftFetchImage(u), url));
    await studio.exposeFunction('nodeFetch', async url => { try { const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 Pagecraft-test' } }); if (!r.ok) return null; return { type: r.headers.get('content-type') || '', b64: Buffer.from(await r.arrayBuffer()).toString('base64') }; } catch (_) { return null; } });
    await studio.evaluate(() => { const native = window.fetch.bind(window); window.fetch = async (url, init) => { if (!/^https?:/.test(String(url))) return native(url, init); const r = await window.nodeFetch(String(url)); if (!r) throw new Error('HTTP error'); return native(`data:${r.type.split(';')[0] || 'application/octet-stream'};base64,${r.b64}`); }; });
    await studio.evaluate(() => { window.chrome = { scripting: { executeScript: async ({ args }) => [{ result: await window.pageFetch(args[0]) }] } }; });
    for (const file of ['shared.js', 'render.js', 'images.js']) await studio.addScriptTag({ content: await fs.readFile(path.join(root, 'extension', file), 'utf8') });
    const result = await studio.evaluate(async data => { const summary = await PagecraftImages.resolveAssets(data, 1); return { data, summary, svg: renderCapture(data), svgOriginalFonts: renderCapture(data, { systemFont: null }) }; }, capture);
    await fs.writeFile(path.join(out, `${name}.pagecraft.json`), JSON.stringify(result.data));
    await fs.writeFile(path.join(out, `${name}.svg`), result.svg);
    const view = await context.newPage(); await view.setViewportSize({ width: Math.ceil(capture.width), height: 800 });
    await view.setContent(`<body style="margin:0">${result.svgOriginalFonts}</body>`); await view.waitForTimeout(300);
    await view.screenshot({ path: path.join(out, `${name}-svg.png`), fullPage: true });

    const flat = n => [n, ...(n.children || []).flatMap(flat)], nodes = flat(result.data.tree);
    const texts = nodes.filter(n => n.type === 'text'), all = JSON.stringify(result.data);
    const report = { status: 'passed', page: target || 'fixture', captureMs, size: [capture.width, capture.height], elements: capture.elementCount, layers: capture.layerCount, texts: texts.length, vectors: nodes.filter(n => n.type === 'svg').length, images: result.summary, svgMB: +(result.svg.length / 1048576).toFixed(2), warnings: result.data.warnings };
    if (!target) {
      assert.ok(capture.height > 1200, 'full page height');
      assert.ok(!all.includes('SHOULD NOT EXPORT') && !all.includes('SCREEN READER ONLY'), 'hidden content excluded');
      const rich = texts.find(t => t.segments.length >= 5 && t.segments.some(s => s.text.includes('bold words')));
      assert.ok(rich && rich.lines > 1, 'mixed inline styles stay in one multi-line text layer');
      assert.ok(rich.segments.some(s => s.fontWeight >= 700) && rich.segments.some(s => s.decoration === 'underline') && rich.segments.some(s => s.italic), 'segment styles');
      const arabic = texts.find(t => /مَرْحَبًا/.test(t.segments[0].text));
      assert.ok(arabic && arabic.align === 'RIGHT' && arabic.pieces.every(p => p.rtl), 'Arabic keeps diacritics and RTL alignment');
      assert.equal(arabic.pieces.map(p => p.text).join('').replace(/\s/g, ''), arabic.segments.map(s => s.text).join('').replace(/\s/g, ''), 'no characters lost when splitting lines');
      assert.ok(texts.some(t => t.segments[0].text === 'SECTION LABEL'), 'text-transform applied');
      assert.ok(texts.some(t => t.segments[0].text === 'Your email address') && texts.some(t => t.segments[0].text === 'Typed value') && texts.some(t => t.segments[0].text === 'Choose plan'), 'form control text');
      assert.ok(!all.includes('secret12'), 'passwords are masked');
      assert.ok(texts.some(t => t.segments[0].text === '•') && texts.some(t => t.segments[0].text === '3.'), 'list markers');
      assert.ok(texts.some(t => t.segments[0].text === 'NEW') && texts.some(t => t.segments[0].text.startsWith('★')), 'pseudo-elements');
      assert.ok(nodes.some(n => n.shadows && n.shadows.length === 2), 'box shadows');
      assert.ok(nodes.some(n => n.fills && n.fills.some(f => f.type === 'linear')) && nodes.some(n => n.fills && n.fills.some(f => f.type === 'radial')), 'gradients');
      assert.ok(nodes.filter(n => n.type === 'svg').length === 3 && nodes.some(n => n.type === 'svg' && /stroke="#c34d26"/.test(n.svg.inner)), 'inline SVG with <use> resolved');
      assert.ok(nodes.some(n => n.type === 'svg' && /linearGradient/.test(n.svg.inner)), 'shared gradient pulled into the vector');
      assert.equal(result.summary.missing, 0, 'all images embedded');
      assert.ok(nodes.some(n => n.fills && n.fills.some(f => f.vector)), 'SVG image stays vector');
      assert.ok(nodes.some(n => n.fills && n.fills.some(f => f.type === 'image' && f.mode === 'fit')), 'contain placement');
      assert.ok(/<text [^>]*text-anchor="end"/.test(result.svg) && !/data:image\/svg/.test(result.svg) && !/direction=/.test(result.svg), 'SVG uses Figma-safe constructs');
      assert.ok(/<pattern /.test(result.svg) && /<filter /.test(result.svg) && /font-family="Inter"/.test(result.svg), 'image fills, shadows, font mapping');
      const errors = await view.evaluate(() => document.querySelectorAll('parsererror').length); assert.equal(errors, 0);
    }
    console.log(JSON.stringify(report, null, 2));
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
