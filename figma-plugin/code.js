/* Layerlift Import — rebuilds a .layerlift.json capture as Figma layers.
   Independent and local: no network requests, accounts, or metering. */
figma.showUI(__html__, { width: 420, height: 520, themeColors: true });
let importing = false, cancelled = false;
const solid = c => ({ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a });
const rgba = c => ({ r: c.r, g: c.g, b: c.b, a: c.a });

function validateCapture(data) {
  if (!data || data.format !== 'pagecraft' || !data.tree || !data.assets || typeof data.assets !== 'object') throw new Error('This is not a Layerlift capture file.');
  if (data.version !== 2) throw new Error('This capture was made by an older version of the extension. Capture the page again with the current extension.');
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  if (!finite(data.width) || !finite(data.height) || data.width <= 0 || data.height <= 0 || data.width > 100000 || data.height > 100000) throw new Error('Capture dimensions must be between 0 and 100,000 pixels for Figma.');
  const stack = [data.tree]; let count = 0;
  while (stack.length) {
    const n = stack.pop(); count++;
    if (!n || !['frame', 'text', 'svg'].includes(n.type) || ![n.x, n.y, n.width, n.height].every(finite) || n.width < 0 || n.height < 0) throw new Error('A layer has an invalid type or geometry.');
    if (n.type === 'text' && (!Array.isArray(n.segments) || !n.segments.length || !Array.isArray(n.pieces) || !n.pieces.length || !n.segments.every(s => typeof s.text === 'string' && s.color && finite(s.fontSize) && s.fontSize > 0))) throw new Error('A text layer is invalid.');
    if (n.type === 'svg' && (!n.svg || typeof n.svg.inner !== 'string')) throw new Error('A vector layer is invalid.');
    if (n.type === 'frame') { if (!Array.isArray(n.children) || !Array.isArray(n.fills) || !Array.isArray(n.radii)) throw new Error('A frame layer is invalid.'); stack.push(...n.children); }
  }
  return count;
}
function decodeImage(data) {
  const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/.exec(data || '');
  if (!match) throw new Error('Unsupported embedded image format.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(128); for (let i = 0; i < 64; i++) lookup[alphabet.charCodeAt(i)] = i;
  const input = match[1].replace(/[\s=]/g, ''), bytes = new Uint8Array(Math.floor(input.length * 6 / 8));
  let bits = 0, buffer = 0, index = 0;
  for (let i = 0; i < input.length; i++) { buffer = ((buffer << 6) | lookup[input.charCodeAt(i)]) & 0xffffff; bits += 6; if (bits >= 8) { bits -= 8; bytes[index++] = (buffer >> bits) & 255; } }
  return bytes;
}
/* Figma gradient transforms map the node's unit square into gradient space. */
function invert(m) {
  const [[a, c, e], [b, d, f]] = m, det = a * d - b * c || 1e-9;
  return [[d / det, -c / det, (c * f - d * e) / det], [-b / det, a / det, (b * e - a * f) / det]];
}
function gradientPaint(fill, w, h) {
  const gradientStops = fill.stops.map(s => ({ position: Math.max(0, Math.min(1, s.offset)), color: rgba(s.color) }));
  if (fill.type === 'linear') {
    const dx = fill.x2 - fill.x1, dy = fill.y2 - fill.y1, nx = -dy, ny = dx;
    return { type: 'GRADIENT_LINEAR', gradientStops, gradientTransform: invert([[dx / w, nx / w, (fill.x1 - nx / 2) / w], [dy / h, ny / h, (fill.y1 - ny / 2) / h]]) };
  }
  return { type: 'GRADIENT_RADIAL', gradientStops, gradientTransform: invert([[2 * fill.rx / w, 0, (fill.cx - fill.rx) / w], [0, 2 * fill.ry / h, (fill.cy - fill.ry) / h]]) };
}
function svgMarkup(svg, w, h, tint) {
  const box = svg.viewBox ? ` viewBox="${svg.viewBox.join(' ')}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}"${box}${svg.stretch ? ' preserveAspectRatio="none"' : ''}>${tint ? svg.inner.replace(/(fill|stroke)="#[0-9a-f]{6}"/gi, `$1="${tint}"`) : svg.inner}</svg>`;
}

async function importCapture(data) {
  const total = validateCapture(data), notes = new Set();
  const fonts = await figma.listAvailableFontsAsync();
  const byFamily = new Map();
  for (const f of fonts) { const key = f.fontName.family.toLowerCase(); if (!byFamily.has(key)) byFamily.set(key, []); byFamily.get(key).push(f.fontName); }
  const fontCache = new Map(), imageCache = new Map();
  const fallback = { family: 'Inter', style: 'Regular' };
  await figma.loadFontAsync(fallback);
  function weightOf(style) {
    const s = style.toLowerCase();
    return /black|heavy/.test(s) ? 900 : /extra.?bold|ultra.?bold/.test(s) ? 800 : /semi.?bold|demi/.test(s) ? 600 : /bold/.test(s) ? 700 : /medium/.test(s) ? 500 : /extra.?light|ultra.?light/.test(s) ? 200 : /light/.test(s) ? 300 : /thin|hairline/.test(s) ? 100 : 400;
  }
  async function chooseFont(seg) {
    const arabic = /[\u0600-\u06FF\u0750-\u077F]/.test(seg.text), hebrew = /[\u0590-\u05FF]/.test(seg.text);
    const key = `${seg.fontFamily}|${seg.fontStack}|${seg.fontWeight}|${seg.italic}|${arabic}|${hebrew}`;
    if (fontCache.has(key)) return fontCache.get(key);
    const stack = String(seg.fontStack || '').split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    const wanted = [seg.fontFamily, ...stack, arabic ? 'Noto Sans Arabic' : hebrew ? 'Noto Sans Hebrew' : null, 'Inter'].filter(Boolean);
    let candidates = [], family = null;
    for (const name of wanted) { candidates = byFamily.get(String(name).toLowerCase()) || []; if (candidates.length) { family = name; break; } }
    if (family !== seg.fontFamily) notes.add(`Font "${seg.fontFamily}" is not available in Figma; used ${family || 'Inter'}.`);
    const score = f => Math.abs(weightOf(f.style) - (seg.fontWeight || 400)) + (/italic|oblique/i.test(f.style) !== !!seg.italic ? 1000 : 0);
    const ordered = [...candidates].sort((a, b) => score(a) - score(b));
    for (const candidate of [...ordered, fallback]) {
      try { await figma.loadFontAsync(candidate); fontCache.set(key, candidate); return candidate; } catch (_) { /* try the next style */ }
    }
    throw new Error('Could not load any font in Figma.');
  }
  function imageHash(id) {
    if (!imageCache.has(id)) imageCache.set(id, figma.createImage(decodeImage(data.assets[id].data)).hash);
    return imageCache.get(id);
  }
  let root = null, processed = 0;
  async function tick() {
    if (cancelled) throw new Error('Import cancelled. No layers were kept.');
    if (++processed % 80 === 0) { figma.ui.postMessage({ type: 'progress', message: `Creating layers… ${processed.toLocaleString()} / ${total.toLocaleString()}` }); await new Promise(resolve => setTimeout(resolve, 0)); }
  }
  async function makeText(source, parent, ox, oy) {
    const node = figma.createText(); parent.appendChild(node);
    const loaded = []; for (const seg of source.segments) loaded.push(await chooseFont(seg));
    node.fontName = loaded[0];
    node.characters = source.segments.map(s => s.text).join('');
    let start = 0;
    source.segments.forEach((seg, i) => {
      const end = start + seg.text.length;
      if (end > start) {
        node.setRangeFontName(start, end, loaded[i]); node.setRangeFontSize(start, end, seg.fontSize); node.setRangeFills(start, end, [solid(seg.color)]);
        if (seg.letterSpacing) node.setRangeLetterSpacing(start, end, { unit: 'PIXELS', value: seg.letterSpacing });
        if (seg.decoration && seg.decoration !== 'none') node.setRangeTextDecoration(start, end, seg.decoration === 'underline' ? 'UNDERLINE' : 'STRIKETHROUGH');
      }
      start = end;
    });
    if (source.lineHeight) node.lineHeight = { unit: 'PIXELS', value: source.lineHeight };
    const align = source.align || 'LEFT', first = source.pieces[0];
    node.textAlignHorizontal = align;
    const lead = source.lineHeight ? (source.lineHeight - first.height) / 2 : 0;
    if (source.lines > 1) {
      // A paragraph: one wrapping text box, a hair wider than the browser's so lines break in the same places.
      node.resize(Math.max(1, source.width + 2), Math.max(1, source.height)); node.textAutoResize = 'HEIGHT';
      node.x = source.x - ox - (align === 'RIGHT' ? 2 : align === 'CENTER' ? 1 : 0);
    } else {
      node.textAutoResize = 'WIDTH_AND_HEIGHT';
      node.x = align === 'RIGHT' ? source.x + source.width - node.width - ox : align === 'CENTER' ? source.x + (source.width - node.width) / 2 - ox : source.x - ox;
    }
    node.y = source.y - oy - lead;
    node.name = String(source.name || 'Text').slice(0, 80);
  }
  function applyBox(node, source, isFrame) {
    const w = Math.max(0.01, source.width), h = Math.max(0.01, source.height);
    node.resize(w, h);
    const limit = Math.min(w, h) / 2, r = source.radii.map(v => Math.max(0, Math.min(v, limit)));
    if (r.some(v => v > 0)) { node.topLeftRadius = r[0]; node.topRightRadius = r[1]; node.bottomRightRadius = r[2]; node.bottomLeftRadius = r[3]; }
    const fills = [], extras = [];
    for (const fill of source.fills) {
      try {
        if (fill.type === 'solid') fills.push(solid(fill.color));
        else if (fill.type === 'linear' || fill.type === 'radial') fills.push(gradientPaint(fill, w, h));
        else if (fill.type === 'image') {
          if (fill.missing || !fill.rect) { if (!fill.vectorOnly) notes.add(`Missing image: ${source.name}`); continue; }
          if (fill.vector || fill.mode === 'custom') extras.push(fill);
          else fills.push({ type: 'IMAGE', imageHash: imageHash(fill.asset), scaleMode: fill.mode === 'fit' ? 'FIT' : 'FILL' });
        }
      } catch (_) { notes.add(`A background could not be imported: ${source.name}`); }
    }
    node.fills = fills;
    const b = source.borders;
    if (b) {
      const live = b.filter(s => s.width > 0), sameColor = live.every(s => JSON.stringify(s.color) === JSON.stringify(live[0].color));
      if (live.length && sameColor) {
        node.strokes = [solid(live[0].color)]; node.strokeAlign = 'INSIDE';
        if (live.length === 4 && live.every(s => s.width === live[0].width)) node.strokeWeight = live[0].width;
        else { node.strokeTopWeight = b[0].width; node.strokeRightWeight = b[1].width; node.strokeBottomWeight = b[2].width; node.strokeLeftWeight = b[3].width; }
        if (live[0].style === 'dashed' || live[0].style === 'dotted') node.dashPattern = live[0].style === 'dotted' ? [live[0].width, live[0].width] : [live[0].width * 3, live[0].width * 2];
      } else if (live.length) extras.push({ borders: b });
    }
    if (source.shadows.length) {
      try {
        node.effects = source.shadows.map(s => Object.assign({ type: s.inset ? 'INNER_SHADOW' : 'DROP_SHADOW', color: rgba(s.color), offset: { x: s.x, y: s.y }, radius: Math.max(0, s.blur), visible: true, blendMode: 'NORMAL' }, (isFrame ? source.clip : true) && s.spread ? { spread: s.spread } : {}));
      } catch (_) { notes.add('A shadow could not be imported.'); }
    }
    return extras;
  }
  function addExtras(node, source, extras) {
    for (const extra of extras) {
      try {
        if (extra.borders) {
          extra.borders.forEach((s, side) => {
            if (!(s.width > 0)) return;
            const line = figma.createRectangle(); node.appendChild(line); line.name = ['Border top', 'Border right', 'Border bottom', 'Border left'][side];
            const bw = Math.min(s.width, side % 2 ? source.width : source.height);
            line.resize(Math.max(0.01, side % 2 ? bw : source.width), Math.max(0.01, side % 2 ? source.height : bw));
            line.x = side === 1 ? source.width - bw : 0; line.y = side === 2 ? source.height - bw : 0; line.fills = [solid(s.color)];
          });
        } else if (extra.vector) {
          const r = extra.rect, vector = figma.createNodeFromSvg(svgMarkup(data.assets[extra.asset].svg, r.width, r.height, extra.tint));
          node.appendChild(vector); vector.x = r.x; vector.y = r.y; vector.name = 'Vector image';
        } else {
          const r = extra.rect, image = figma.createRectangle(); node.appendChild(image); image.name = 'Image';
          image.resize(Math.max(0.01, r.width), Math.max(0.01, r.height)); image.x = r.x; image.y = r.y;
          image.fills = [{ type: 'IMAGE', imageHash: imageHash(extra.asset), scaleMode: 'FILL' }];
          const outside = r.x < -0.5 || r.y < -0.5 || r.x + r.width > source.width + 0.5 || r.y + r.height > source.height + 0.5;
          if (outside && !node.clipsContent) { const mask = figma.createFrame(); node.insertChild(node.children.length - 1, mask); mask.name = 'Image'; mask.fills = []; mask.resize(Math.max(0.01, source.width), Math.max(0.01, source.height)); mask.clipsContent = true; mask.appendChild(image); }
        }
      } catch (_) { notes.add(`An image or border could not be imported: ${source.name}`); }
    }
  }
  async function make(source, parent, ox, oy) {
    await tick();
    if (source.type === 'text') return makeText(source, parent, ox, oy);
    if (source.type === 'svg') {
      try {
        const node = figma.createNodeFromSvg(svgMarkup(source.svg, Math.max(1, source.width), Math.max(1, source.height)));
        parent.appendChild(node); node.x = source.x - ox; node.y = source.y - oy; node.fills = []; node.clipsContent = false;
        node.name = String(source.name || 'Vector').slice(0, 80); if (source.opacity < 1) node.opacity = source.opacity;
      } catch (_) { notes.add(`A vector could not be imported: ${source.name}`); }
      return;
    }
    const simple = !source.children.length && !(source.borders && new Set(source.borders.filter(s => s.width > 0).map(s => JSON.stringify(s.color))).size > 1) && !source.fills.some(f => f.type === 'image' && (f.vector || f.mode === 'custom'));
    const node = simple ? figma.createRectangle() : figma.createFrame();
    parent.appendChild(node);
    if (!simple) node.clipsContent = !!source.clip;
    const extras = applyBox(node, source, !simple);
    node.x = source.x - ox; node.y = source.y - oy;
    node.name = String(source.name || 'Layer').slice(0, 80); if (source.opacity < 1) node.opacity = source.opacity;
    if (!simple) { addExtras(node, source, extras); for (const child of source.children) await make(child, node, source.x, source.y); }
  }
  try {
    root = figma.createFrame(); root.name = `${data.title || 'Webpage'}`.slice(0, 100);
    root.resize(data.width, data.height); root.fills = [solid(data.background || { r: 1, g: 1, b: 1, a: 1 })]; root.clipsContent = true;
    root.x = Math.round(figma.viewport.center.x - data.width / 2); root.y = Math.round(figma.viewport.center.y - Math.min(data.height, 1200) / 2);
    await make(data.tree, root, 0, 0);
    if (cancelled) throw new Error('Import cancelled. No layers were kept.');
    root.setPluginData('pagecraft-source', String(data.url || '')); root.setPluginData('pagecraft-date', String(data.capturedAt || ''));
    figma.currentPage.selection = [root]; figma.viewport.scrollAndZoomIntoView([root]);
    figma.ui.postMessage({ type: 'done', message: `Imported ${processed.toLocaleString()} layers.${notes.size ? '\n' + [...notes].slice(0, 30).join('\n') : ''}` });
    figma.notify('Layerlift capture imported');
  } catch (error) { if (root) root.remove(); throw error; }
}
figma.ui.onmessage = async message => {
  if (message.type === 'cancel') { cancelled = true; return; }
  if (message.type !== 'import' || importing) return;
  importing = true; cancelled = false;
  try { await importCapture(message.data); }
  catch (error) { figma.ui.postMessage({ type: 'error', message: (error && error.message) || String(error) }); }
  finally { importing = false; }
};
if (typeof module !== 'undefined') module.exports = { validateCapture, decodeImage, importCapture, gradientPaint, invert };
