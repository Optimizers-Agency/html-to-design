/* Independent local importer. No network requests, accounts, or metering. */
figma.showUI(__html__, { width: 420, height: 510, themeColors: true });
let importing = false, cancelled = false;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const paint = c => ({ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a });
function validateCapture(data) {
  if (!data || data.format !== 'pagecraft' || data.version !== 1 || !data.tree || !data.assets || typeof data.assets !== 'object') throw new Error('This is not a valid Pagecraft capture.');
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const dimension = n => finite(n) && n > 0 && n <= 100000;
  const color = c => c && ['r','g','b','a'].every(k => finite(c[k]) && c[k] >= 0 && c[k] <= 1);
  if (!dimension(data.width) || !dimension(data.height)) throw new Error('Capture dimensions must be between 0 and 100,000 pixels for Figma.');
  const stack = [data.tree]; let count = 0;
  while (stack.length) {
    const n = stack.pop(); count++;
    if (!n || !['frame','text','svg'].includes(n.type) || !finite(n.x) || !finite(n.y) || !dimension(n.width) || !dimension(n.height)) throw new Error('A layer has invalid type or geometry.');
    if (n.opacity !== undefined && (!finite(n.opacity) || n.opacity < 0 || n.opacity > 1)) throw new Error('A layer has invalid opacity.');
    if (n.type === 'text' && (typeof n.text !== 'string' || !color(n.color) || !finite(n.fontSize) || n.fontSize <= 0 || n.fontSize > 10000 || !finite(n.letterSpacing) || !finite(n.fontWeight) || typeof n.fontFamily !== 'string')) throw new Error('Invalid text layer.');
    if (n.type === 'svg' && (typeof n.svg !== 'string' || !/^\s*<svg[\s>]/i.test(n.svg))) throw new Error('Invalid SVG layer.');
    if (n.type === 'frame') {
      if (!color(n.fill) || !Array.isArray(n.children) || !Array.isArray(n.radii) || n.radii.length !== 4 || !n.radii.every(r => finite(r) && r >= 0) || !Array.isArray(n.borders) || n.borders.length !== 4 || !n.borders.every(b => finite(b.width) && b.width >= 0 && color(b.color))) throw new Error('Invalid frame layer.');
      stack.push(...n.children);
    }
  }
  return count;
}
function decodeImage(data) {
  const match = /^data:image\/(?:png|jpeg|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(data || '');
  if (!match) throw new Error('Unsupported embedded image format.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const input = match[1].replace(/\s|=/g, '');
  const bytes = new Uint8Array(Math.floor(input.length * 6 / 8));
  let bits = 0, buffer = 0, index = 0;
  for (let i = 0; i < input.length; i++) {
    buffer = (buffer << 6) | alphabet.indexOf(input[i]); bits += 6;
    if (bits >= 8) { bits -= 8; bytes[index++] = (buffer >> bits) & 255; }
  }
  return bytes;
}
async function importCapture(data) {
  const total = validateCapture(data), notes = new Set();
  const fonts = await figma.listAvailableFontsAsync();
  const fontCache = new Map(), imageCache = new Map();
  async function chooseFont(node) {
    const families = node.fontFamily.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    const key = `${families.join(',')}|${node.fontWeight}|${node.italic}`;
    if (fontCache.has(key)) return fontCache.get(key);
    const aliases = { 'sans-serif': 'Inter', 'serif': 'Noto Serif', 'monospace': 'Roboto Mono', 'system-ui': 'Inter', '-apple-system': 'Inter' };
    let candidates = [];
    for (const family of families) {
      candidates = fonts.filter(f => f.fontName.family.toLowerCase() === (aliases[family] || family).toLowerCase());
      if (candidates.length) break;
    }
    if (!candidates.length) { notes.add(`Font substituted: ${node.fontFamily}`); candidates = fonts.filter(f => f.fontName.family === 'Inter'); }
    function score(font) {
      const style = font.fontName.style.toLowerCase();
      let weight = /black|heavy/.test(style) ? 900 : /extra.?bold/.test(style) ? 800 : /semi.?bold|demi/.test(style) ? 600 : /bold/.test(style) ? 700 : /medium/.test(style) ? 500 : /extra.?light/.test(style) ? 200 : /light/.test(style) ? 300 : /thin/.test(style) ? 100 : 400;
      return Math.abs(weight - node.fontWeight) + (/italic|oblique/.test(style) !== !!node.italic ? 1000 : 0);
    }
    candidates.sort((a,b) => score(a) - score(b));
    for (const candidate of [...candidates.map(f => f.fontName), { family: 'Inter', style: 'Regular' }]) {
      try { await figma.loadFontAsync(candidate); fontCache.set(key, candidate); return candidate; } catch (_) { /* Try the next available font. */ }
    }
    throw new Error('Could not load an available Figma font.');
  }
  let root = null, processed = 0;
  async function make(source, parent) {
    if (cancelled) throw new Error('Import cancelled. No imported layers were kept.');
    let node;
    if (source.type === 'text') {
      const font = await chooseFont(source);
      node = figma.createText(); parent.appendChild(node);
      node.fontName = font; node.fontSize = source.fontSize;
      node.characters = source.text; node.fills = [paint(source.color)];
      node.letterSpacing = { unit: 'PIXELS', value: source.letterSpacing };
      node.textAutoResize = 'NONE';
      node.textAlignHorizontal = source.direction === 'rtl' ? 'RIGHT' : 'LEFT';
      node.textDecoration = (source.decoration || '').includes('underline') ? 'UNDERLINE' : (source.decoration || '').includes('line-through') ? 'STRIKETHROUGH' : 'NONE';
      node.resize(Math.max(.01, source.width + .5), Math.max(.01, source.height));
    } else if (source.type === 'svg') {
      try { node = figma.createNodeFromSvg(source.svg); parent.appendChild(node); node.resize(source.width, source.height); }
      catch (_) { notes.add(`SVG could not be imported: ${source.name}`); return; }
    } else {
      node = figma.createFrame(); parent.appendChild(node);
      node.resize(source.width, source.height); node.clipsContent = !!source.clip;
      node.fills = source.fill.a ? [paint(source.fill)] : [];
      const radii = source.radii.map(r => clamp(r, 0, Math.min(source.width,source.height) / 2));
      [node.topLeftRadius,node.topRightRadius,node.bottomRightRadius,node.bottomLeftRadius] = radii;
      if (source.image) {
        const asset = data.assets[source.image];
        if (asset && asset.data) {
          try {
            if (!imageCache.has(source.image)) imageCache.set(source.image, figma.createImage(decodeImage(asset.data)).hash);
            node.fills = [{ type: 'IMAGE', imageHash: imageCache.get(source.image), scaleMode: source.imageFit === 'FIT' ? 'FIT' : 'FILL' }, ...node.fills];
          } catch (_) { notes.add(`Image could not be imported: ${source.name}`); }
        } else notes.add(`Missing image: ${source.name}`);
      }
      const uniformBorder = source.borders.every(b => JSON.stringify(b) === JSON.stringify(source.borders[0]));
      const firstBorder = source.borders[0];
      if (uniformBorder && firstBorder.width && firstBorder.color.a && firstBorder.style !== 'none') {
        node.strokes = [paint(firstBorder.color)]; node.strokeWeight = firstBorder.width; node.strokeAlign = 'INSIDE';
        if (firstBorder.style === 'dashed' || firstBorder.style === 'dotted') node.dashPattern = [firstBorder.width * (firstBorder.style === 'dotted' ? 1 : 3), firstBorder.width * 2];
      }
      // Separate side layers preserve differently colored and sized CSS borders.
      (uniformBorder ? [] : source.borders).forEach((border, side) => {
        if (!border.width || !border.color.a || border.style === 'none') return;
        const b = figma.createRectangle(); node.appendChild(b); b.name = ['Border top','Border right','Border bottom','Border left'][side];
        const bw = Math.min(border.width, side % 2 ? source.width : source.height);
        b.resize(side % 2 ? bw : source.width, side % 2 ? source.height : bw);
        b.x = side === 1 ? source.width - bw : 0; b.y = side === 2 ? source.height - bw : 0; b.fills = [paint(border.color)];
        if (border.style !== 'solid') notes.add('Non-solid borders are imported as solid edges.');
      });
    }
    node.name = String(source.name || source.type).slice(0,200); node.x = source.x; node.y = source.y; node.opacity = source.opacity ?? 1;
    processed++;
    if (processed % 100 === 0) {
      figma.ui.postMessage({ type: 'progress', message: `Creating layers… ${processed.toLocaleString()} / ${total.toLocaleString()}` });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (source.children) for (const child of source.children) await make(child, node);
    return node;
  }
  try {
    root = figma.createFrame(); root.name = `${data.title || 'Webpage'} · Pagecraft`;
    root.resize(data.width, data.height); root.fills = [paint({ r:1,g:1,b:1,a:1 })]; root.clipsContent = true;
    root.x = figma.viewport.center.x - data.width / 2; root.y = figma.viewport.center.y - data.height / 2;
    await make(data.tree, root);
    if (cancelled) throw new Error('Import cancelled. No imported layers were kept.');
    root.setPluginData('pagecraft-source', String(data.url || '')); root.setPluginData('pagecraft-date', String(data.capturedAt || ''));
    figma.currentPage.selection = [root]; figma.viewport.scrollAndZoomIntoView([root]);
    const captureNotes = Array.isArray(data.warnings) ? data.warnings.filter(n => typeof n === 'string') : [];
    figma.ui.postMessage({ type: 'done', message: `Imported ${processed.toLocaleString()} editable layers.\n${[...notes, ...captureNotes].join('\n')}` });
    figma.notify('Pagecraft capture imported');
  } catch (error) { if (root) root.remove(); throw error; }
}
figma.ui.onmessage = async message => {
  if (message.type === 'cancel') { cancelled = true; return; }
  if (message.type !== 'import' || importing) return;
  importing = true; cancelled = false;
  try { await importCapture(message.data); }
  catch (error) { figma.ui.postMessage({ type: 'error', message: error.message || String(error) }); }
  finally { importing = false; }
};
if (typeof module !== 'undefined') module.exports = { validateCapture, decodeImage, importCapture };
