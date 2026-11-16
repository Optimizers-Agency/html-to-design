const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { renderCapture } = require('../extension/render.js');
const { placeImage, finalizeCapture } = require('../extension/images.js');
const black = { r: 0, g: 0, b: 0, a: 1 }, white = { r: 1, g: 1, b: 1, a: 1 };
const style = { color: black, fontFamily: 'Arial', fontStack: 'Arial, sans-serif', system: true, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0, decoration: 'none' };
function frame(extra = {}) { return { type: 'frame', name: 'box', x: 0, y: 0, width: 200, height: 100, opacity: 1, clip: false, radii: [0, 0, 0, 0], fills: [], borders: null, shadows: [], children: [], ...extra }; }
function text(value, extra = {}) { return { type: 'text', name: value, x: 4, y: 5, width: 80, height: 20, align: 'LEFT', lineHeight: null, lines: 1, segments: [{ text: value, ...style }], pieces: [{ s: 0, text: value, x: 4, y: 5, width: 80, height: 20, baseline: 20, rtl: false }], ...extra }; }
function capture(tree = frame({ fills: [{ type: 'solid', color: white }] })) { return { format: 'pagecraft', version: 2, width: 200, height: 100, title: 'Test <&>', background: white, tree, assets: {}, warnings: [] }; }
function harness() {
  const all = [], messages = [], page = { selection: [] };
  function create(type) {
    const n = { type, children: [], fills: [], width: 100, height: 20, ranges: [],
      resize(w, h) { assert.ok(w > 0 && h > 0); this.width = w; this.height = h; }, appendChild(c) { this.children.push(c); }, insertChild(i, c) { this.children.splice(i, 0, c); }, setPluginData() {}, remove() { this.removed = true; },
      setRangeFontName(a, b, f) { this.ranges.push(['font', a, b, f]); }, setRangeFontSize() {}, setRangeFills() {}, setRangeLetterSpacing() {}, setRangeTextDecoration(a, b, d) { this.ranges.push(['deco', a, b, d]); } };
    all.push(n); return n;
  }
  const available = [{ fontName: { family: 'Inter', style: 'Regular' } }, { fontName: { family: 'Inter', style: 'Bold' } }, { fontName: { family: 'Noto Sans Arabic', style: 'Regular' } }];
  const figma = { showUI() {}, ui: { postMessage: m => messages.push(m) }, listAvailableFontsAsync: async () => available, loadFontAsync: async () => {}, createFrame: () => create('FRAME'), createText: () => create('TEXT'), createRectangle: () => create('RECTANGLE'), createNodeFromSvg: markup => Object.assign(create('SVG'), { markup }), createImage: () => ({ hash: 'image' }), currentPage: page, viewport: { center: { x: 0, y: 0 }, scrollAndZoomIntoView() {} }, notify() {} };
  const context = { figma, __html__: '', module: { exports: {} }, Uint8Array, setTimeout, console };
  vm.runInNewContext(fs.readFileSync(require.resolve('../figma-plugin/code.js'), 'utf8'), context);
  return { api: context.module.exports, figma, all, messages };
}
test('rejects non-captures, old versions and invalid geometry before touching Figma', () => {
  const h = harness(); assert.throws(() => h.api.validateCapture({}));
  const old = capture(); old.version = 1; assert.throws(() => h.api.validateCapture(old), /older/);
  const bad = capture(); bad.tree.x = NaN; assert.throws(() => h.api.validateCapture(bad));
  assert.equal(h.all.length, 0);
});
test('decodes embedded image bytes', () => {
  const h = harness(); assert.deepEqual([...h.api.decodeImage('data:image/png;base64,AQIDBA==')], [1, 2, 3, 4]);
  assert.throws(() => h.api.decodeImage('https://example.com/a.png'));
});
test('gradient transform maps the gradient line back onto the unit square', () => {
  const h = harness(), paint = h.api.gradientPaint({ type: 'linear', x1: 0, y1: 50, x2: 200, y2: 50, stops: [{ offset: 0, color: black }, { offset: 1, color: white }] }, 200, 100);
  const m = paint.gradientTransform, at = (x, y) => [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];
  assert.ok(Math.abs(at(0, 0.5)[0]) < 1e-9 && Math.abs(at(1, 0.5)[0] - 1) < 1e-9 && Math.abs(at(0.3, 0.5)[1] - 0.5) < 1e-9);
});
test('imports a styled paragraph as one text layer with ranges, plus a vector and image', async () => {
  const h = harness();
  const rich = text('Hello bold', { lines: 2, width: 120, height: 40, segments: [{ text: 'Hello ', ...style }, { text: 'bold', ...style, fontWeight: 700, decoration: 'underline' }] });
  const image = frame({ name: 'photo', x: 10, y: 10, width: 50, height: 50, fills: [{ type: 'image', asset: 'a1', rect: { x: 0, y: 0, width: 50, height: 50 }, mode: 'fill' }] });
  const vector = { type: 'svg', name: 'icon', x: 90, y: 0, width: 20, height: 20, opacity: 1, svg: { inner: '<path d="M0 0h4v4z" fill="#000000"/>', viewBox: [0, 0, 24, 24] } };
  const data = capture(frame({ fills: [{ type: 'solid', color: white }], shadows: [{ inset: false, x: 0, y: 4, blur: 8, spread: 0, color: black }], borders: Array(4).fill({ width: 1, color: black, style: 'solid' }), children: [rich, image, vector] }));
  data.assets.a1 = { data: 'data:image/png;base64,AQIDBA==', pw: 1, ph: 1, width: 1, height: 1 };
  await h.api.importCapture(data);
  const t = h.all.find(n => n.type === 'TEXT');
  assert.equal(t.characters, 'Hello bold'); assert.equal(t.textAutoResize, 'HEIGHT');
  assert.ok(t.ranges.some(r => r[0] === 'font' && r[1] === 6 && r[2] === 10 && r[3].style === 'Bold'));
  assert.ok(t.ranges.some(r => r[0] === 'deco' && r[3] === 'UNDERLINE'));
  assert.match(h.all.find(n => n.type === 'SVG').markup, /viewBox="0 0 24 24"/);
  assert.equal(h.all.find(n => n.name === 'photo').fills[0].type, 'IMAGE');
  const card = h.all.find(n => n.name === 'box'); assert.equal(card.effects[0].type, 'DROP_SHADOW'); assert.equal(card.strokeWeight, 1);
  assert.equal(h.figma.currentPage.selection.length, 1); assert.equal(h.messages.at(-1).type, 'done');
});
test('falls back to an Arabic font Figma ships when the page font is missing', async () => {
  const h = harness(); await h.api.importCapture(capture(frame({ children: [text('مرحبا', { align: 'RIGHT' })] })));
  const t = h.all.find(n => n.type === 'TEXT'); assert.equal(t.fontName.family, 'Noto Sans Arabic'); assert.equal(t.textAlignHorizontal, 'RIGHT');
});
test('rolls back everything when Figma fails mid-import', async () => {
  const h = harness(); h.figma.createText = () => { throw new Error('simulated Figma failure'); };
  await assert.rejects(h.api.importCapture(capture(frame({ children: [text('a')] }))), /simulated/); assert.equal(h.all[0].removed, true);
});
test('SVG export escapes page text, never references remote URLs, and names layers', () => {
  const tree = frame({ name: 'card & <b>', fills: [{ type: 'solid', color: white }, { type: 'image', asset: 'gone', missing: true }], children: [text('<script>&"')] });
  const data = capture(tree); data.assets.gone = { url: 'https://example.com/track.png' };
  const svg = renderCapture(data);
  assert.match(svg, /&lt;script&gt;&amp;&quot;/); assert.ok(!svg.includes('https://example.com') && !svg.includes('<script>')); assert.match(svg, /id="card &amp; &lt;b&gt;"/);
});
test('SVG export writes image fills, RTL anchors and font mapping the way Figma imports them', () => {
  const rtl = text('مرحبا.', { pieces: [{ s: 0, text: 'مرحبا.', x: 4, y: 5, width: 80, height: 20, baseline: 20, rtl: true }] });
  const photo = frame({ name: 'photo', radii: [8, 8, 8, 8], fills: [{ type: 'image', asset: 'p', rect: { x: -50, y: 0, width: 300, height: 100 }, mode: 'fill' }] });
  const data = capture(frame({ children: [photo, rtl, text('Plain')] })); data.assets.p = { data: 'data:image/png;base64,AQIDBA==', pw: 30, ph: 10, width: 30, height: 10 };
  const svg = renderCapture(data);
  assert.match(svg, /<pattern id="pattern\d+" patternContentUnits="objectBoundingBox" width="1" height="1"><use xlink:href="#image_p" transform="matrix\(0\.05 0 0 0\.1 -0\.25 0\)"/);
  assert.match(svg, /<text x="84" y="20" text-anchor="end" font-family="Noto Sans Arabic"/); assert.match(svg, /font-family="Inter"[^>]*>Plain/);
  assert.match(renderCapture(data, { systemFont: null }), /font-family="Arial"[^>]*>Plain/);
  assert.ok(!/direction=|data:image\/svg/.test(svg));
});
test('image placement follows object-fit and background-size rules', () => {
  const area = { x: 0, y: 0, width: 200, height: 100 };
  assert.deepEqual(placeImage({ kind: 'object', fit: 'cover', position: '50% 50%', area }, 100, 100), { x: 0, y: -50, width: 200, height: 200 });
  assert.deepEqual(placeImage({ kind: 'object', fit: 'contain', position: '50% 50%', area }, 100, 100), { x: 50, y: 0, width: 100, height: 100 });
  assert.deepEqual(placeImage({ kind: 'background', size: '50px auto', position: '100% 0%', area }, 100, 200), { x: 150, y: 0, width: 50, height: 100 });
  const data = capture(frame({ fills: [{ type: 'image', asset: 'a', kind: 'object', fit: 'contain', position: '50% 50%', area }] })); data.assets.a = { url: 'x', data: 'data:image/png;base64,AQIDBA==', width: 100, height: 100 };
  assert.deepEqual(finalizeCapture(data), { total: 1, embedded: 1, missing: 0 }); assert.equal(data.tree.fills[0].mode, 'fit');
});
