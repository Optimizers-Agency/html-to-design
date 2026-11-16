/* Loads the real unpacked extension in an isolated Chromium profile and drives
   the capture panel end to end: inject, capture, embed images, preview, export.
   Usage: PLAYWRIGHT_MODULE=<path to playwright-core> CHROMIUM_EXECUTABLE=<chromium> node tests/extension.cjs */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), extension = path.join(root, 'extension');
(async () => {
  const server = http.createServer(async (req, res) => {
    try { res.setHeader('Content-Type', 'text/html'); res.end(await fs.readFile(path.join(root, 'tests', 'fixture.html'))); } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pagecraft-test-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { headless: false, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, acceptDownloads: true, viewport: { width: 1280, height: 800 },
      args: ['--headless=new', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = new URL(worker.url()).host;
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url.startsWith('http://127.0.0.1')).id);
    const panel = await context.newPage(), errors = []; panel.on('pageerror', e => errors.push(e.message));
    await panel.setViewportSize({ width: 440, height: 780 });
    await panel.goto(`chrome-extension://${id}/capture.html?tab=${tabId}`);
    await page.bringToFront(); // the captured page must be the visible one, as in real use
    await panel.evaluate(() => document.getElementById('capture').click());
    await panel.waitForFunction(() => /Captured|could not|cannot/i.test(document.getElementById('status').textContent), null, { timeout: 60000 });
    const status = await panel.textContent('#status'); assert.match(status, /^Captured\. Press Copy/, status);
    await panel.bringToFront();
    await panel.locator('#stage img').evaluate(img => img.decode());
    assert.match(await panel.textContent('#counts'), /layers · 2\/2 images/);
    const [download] = await Promise.all([panel.waitForEvent('download'), panel.click('#svg')]);
    const svg = await fs.readFile(await download.path(), 'utf8');
    assert.ok(svg.startsWith('<svg') && svg.includes('A page worth keeping.') && svg.includes('<pattern ') && !svg.includes('data:image/svg'));
    assert.match(download.suggestedFilename(), /\.svg$/);
    const [json] = await Promise.all([panel.waitForEvent('download'), panel.click('#json')]);
    assert.equal(JSON.parse(await fs.readFile(await json.path(), 'utf8')).version, 2);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    await panel.click('#copy'); await panel.waitForTimeout(300);
    const copyStatus = await panel.textContent('#status');
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await panel.screenshot({ path: path.join(root, 'test-results', 'panel.png'), fullPage: true });
    assert.equal(await panel.getAttribute('html', 'data-theme'), 'dark');
    await panel.click('#theme-toggle');
    assert.equal(await panel.getAttribute('html', 'data-theme'), 'light');
    assert.match(await panel.getAttribute('#brandLogo', 'src'), /black/);
    await panel.mouse.move(5, 5); await panel.waitForTimeout(500);
    await panel.screenshot({ path: path.join(root, 'test-results', 'panel-light.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'passed', extensionId: id, captureStatus: status, copyStatus, svgBytes: svg.length }, null, 2));
  } finally { if (context) await context.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(profile, { recursive: true, force: true }).catch(() => {}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
