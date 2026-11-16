/* Runs in the extension window. Downloads every image the capture refers to,
   converts it to something Figma accepts (PNG/JPEG, or vector for SVG files),
   and works out where each image sits inside its box. */
(function (scope) {
  const S = scope.PagecraftShared;
  const MAX = 4096;
  const toDataURL = blob => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read image')); reader.readAsDataURL(blob); });
  const timeout = (promise, ms, message) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer)); };

  async function loadElement(blob) {
    const url = URL.createObjectURL(blob);
    try { const image = new Image(); image.src = url; await timeout(image.decode(), 15000, 'Image decoding timed out'); return image; }
    finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
  }
  const sources = new Map();
  function draw(source, sw, sh, forceSize, quality = 0.9) {
    const scale = Math.min(1, MAX / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((forceSize ? forceSize[0] : sw) * (forceSize ? 1 : scale)));
    canvas.height = Math.max(1, Math.round((forceSize ? forceSize[1] : sh) * (forceSize ? 1 : scale)));
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    let opaque = true;
    try { const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data; for (let i = 3; i < data.length; i += 16) if (data[i] < 250) { opaque = false; break; } } catch (_) { opaque = false; }
    return { data: canvas.toDataURL(opaque ? 'image/jpeg' : 'image/png', quality), pw: canvas.width, ph: canvas.height };
  }
  let sandbox = null;
  function vectorFromText(text) {
    const parsed = new DOMParser().parseFromString(text, 'image/svg+xml'), root = parsed.documentElement;
    if (!root || root.localName !== 'svg' || parsed.querySelector('parsererror')) throw new Error('Invalid SVG');
    root.querySelectorAll('script,foreignObject').forEach(el => el.remove());
    if (!sandbox) { const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden'; document.body.appendChild(host); sandbox = host.attachShadow({ mode: 'closed' }); }
    const live = document.importNode(root, true); sandbox.appendChild(live);
    try {
      const svg = S.normalizeSvg(live);
      if (!svg.inner || !(svg.width > 0 && svg.height > 0)) throw new Error('Empty SVG');
      if (!svg.viewBox) svg.viewBox = [0, 0, svg.width, svg.height];
      return svg;
    } finally { live.remove(); }
  }
  async function ingest(asset, blob) {
    const type = (blob.type || '').toLowerCase();
    const looksSvg = type.includes('svg') || /\.svg([?#]|$)/i.test(asset.url) || /^data:image\/svg/i.test(asset.url);
    if (looksSvg) {
      try {
        const svg = vectorFromText(await blob.text());
        if (svg.inner.length < 400000) { asset.svg = { inner: svg.inner, viewBox: svg.viewBox, stretch: svg.stretch }; asset.width = svg.width; asset.height = svg.height; return; }
      } catch (_) { /* fall through to a raster copy */ }
      const image = await loadElement(blob.type ? blob : new Blob([blob], { type: 'image/svg+xml' }));
      const w = image.naturalWidth || 300, h = image.naturalHeight || 150, s = Math.min(4, MAX / Math.max(w, h));
      Object.assign(asset, draw(image, w, h, [w * s, h * s]), { width: w, height: h }); return;
    }
    let source, w, h;
    try { source = await createImageBitmap(blob); w = source.width; h = source.height; }
    catch (_) { source = await loadElement(blob); w = source.naturalWidth; h = source.naturalHeight; }
    if (!w || !h) throw new Error('Image contains no pixels');
    asset.width = w; asset.height = h; asset.loaded = true;
    sources.set(asset, { source, w, h, blob, type }); // encoded later, once we know how large it is shown
  }
  /* Embed every photo at the size it is actually displayed (times a sharpness
     factor) instead of its original resolution. A page full of original-size
     images makes an SVG of tens of megabytes, which Figma stops importing as
     layers; this keeps a long page to a few megabytes. Steps down in quality
     until the total fits the budget. */
  const LEVELS = [[2, 0.86], [1.5, 0.82], [1.25, 0.78], [1, 0.74], [1, 0.62], [0.75, 0.55]];
  async function encodeAssets(capture, budget = 3.5e6) {
    const list = Object.values(capture.assets).filter(a => sources.has(a)); let level = 0, total = 0;
    const fixed = Object.values(capture.assets).filter(a => !sources.has(a) && a.data).reduce((sum, a) => sum + a.data.length, 0);
    for (; level < LEVELS.length; level++) {
      const [density, quality] = LEVELS[level]; total = fixed;
      for (const asset of list) {
        const { source, w, h } = sources.get(asset);
        const scale = Math.min(1, MAX / Math.max(w, h), Math.max(0.02, (asset.need || 1) * density));
        // Always re-encode through a canvas: original files can be CMYK, progressive,
        // EXIF-rotated, 16-bit or mislabelled, any of which an importer may refuse.
        Object.assign(asset, draw(source, w, h, [w * scale, h * scale], quality));
        total += asset.data.length;
      }
      if (total <= budget) break;
    }
    capture.imageBytes = total; capture.imageLevel = Math.min(level, LEVELS.length - 1);
    return total;
  }
  async function fetchBlob(url) {
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.blob();
  }
  async function resolveAssets(capture, tabId, progress = () => {}, budget) {
    sources.clear();
    const assets = Object.values(capture.assets).filter(a => !a.data && !a.svg); let done = 0, next = 0;
    await Promise.all(Array.from({ length: Math.min(6, assets.length) }, async () => {
      while (next < assets.length) {
        const asset = assets[next++]; delete asset.error;
        try {
          let blob;
          try { if (asset.url.startsWith('blob:')) throw new Error('page-only URL'); blob = await fetchBlob(asset.url); }
          catch (first) {
            // Second chance inside the page itself: same cookies, and blob: URLs resolve there.
            const result = await chrome.scripting.executeScript({ target: { tabId }, func: url => pagecraftFetchImage(url), args: [asset.url] }).catch(() => null);
            const data = result && result[0] && result[0].result; if (!data) throw first;
            blob = await (await fetch(data)).blob();
          }
          await ingest(asset, blob);
        } catch (error) { asset.error = (error && error.message) || 'download failed'; }
        progress(++done, assets.length);
      }
    }));
    for (const asset of Object.values(capture.assets)) if (asset.url.startsWith('data:')) asset.url = 'embedded';
    finalizeCapture(capture);
    await encodeAssets(capture, budget);
    return finalizeCapture(capture);
  }

  /* ---- Image placement (object-fit / background-size / position) ---- */
  function offset(token, free) {
    const t = (token || '50%').trim(), calc = /^calc\(\s*(-?[\d.]+)%\s*([+-])\s*([\d.]+)px\s*\)$/.exec(t);
    if (calc) return free * Number.parseFloat(calc[1]) / 100 + (calc[2] === '-' ? -1 : 1) * Number.parseFloat(calc[3]);
    return t.endsWith('%') ? free * Number.parseFloat(t) / 100 : Number.parseFloat(t) || 0;
  }
  function placeImage(paint, iw, ih) {
    const a = paint.area; let w = iw, h = ih;
    if (paint.kind === 'object') {
      const fit = paint.fit || 'fill';
      if (fit === 'fill') { w = a.width; h = a.height; }
      else if (fit !== 'none') { let s = fit === 'cover' ? Math.max(a.width / iw, a.height / ih) : Math.min(a.width / iw, a.height / ih); if (fit === 'scale-down') s = Math.min(1, s); w = iw * s; h = ih * s; }
    } else {
      const size = (paint.size || 'auto').trim();
      if (size === 'cover' || size === 'contain') { const s = size === 'cover' ? Math.max(a.width / iw, a.height / ih) : Math.min(a.width / iw, a.height / ih); w = iw * s; h = ih * s; }
      else {
        const [sw, sh = 'auto'] = size.split(/\s+/), len = (v, total) => v === 'auto' ? null : v.endsWith('%') ? total * Number.parseFloat(v) / 100 : Number.parseFloat(v);
        const cw = len(sw, a.width), ch = len(sh, a.height);
        if (cw !== null && ch !== null) { w = cw; h = ch; } else if (cw !== null) { w = cw; h = ih * cw / iw; } else if (ch !== null) { h = ch; w = iw * ch / ih; }
      }
    }
    const pos = (paint.position || '50% 50%').trim().match(/calc\([^)]*\)|\S+/g) || [];
    return { x: a.x + offset(pos[0], a.width - w), y: a.y + offset(pos[1], a.height - h), width: w, height: h };
  }
  function finalizeCapture(capture) {
    const near = (a, b) => Math.abs(a - b) <= 1;
    for (const asset of Object.values(capture.assets)) delete asset.need;
    (function visit(node) {
      if (node.type !== 'frame') return;
      for (const paint of node.fills) {
        if (paint.type !== 'image') continue;
        const asset = capture.assets[paint.asset];
        paint.missing = !(asset && (asset.data || asset.svg || asset.loaded)); paint.vector = !!(asset && asset.svg);
        if (paint.vectorOnly && !paint.vector) paint.missing = true;
        if (paint.missing || !paint.area) continue;
        const natural = paint.natural && !asset.svg ? paint.natural : [asset.width, asset.height];
        const r = paint.rect = placeImage(paint, natural[0] || 1, natural[1] || 1);
        if (asset.width && asset.height) asset.need = Math.max(asset.need || 0, r.width / asset.width, r.height / asset.height);
        const centred = near(r.x + r.width / 2, node.width / 2) && near(r.y + r.height / 2, node.height / 2);
        const covers = r.x <= 0.5 && r.y <= 0.5 && r.x + r.width >= node.width - 0.5 && r.y + r.height >= node.height - 0.5;
        const inside = r.x >= -0.5 && r.y >= -0.5 && r.x + r.width <= node.width + 0.5 && r.y + r.height <= node.height + 0.5;
        const touches = near(r.width, node.width) || near(r.height, node.height);
        paint.mode = centred && covers ? 'fill' : centred && inside && touches ? 'fit' : 'custom';
      }
      node.children.forEach(visit);
    })(capture.tree);
    const all = Object.values(capture.assets), missing = all.filter(a => !a.data && !a.svg && !a.loaded);
    capture.imageSummary = { total: all.length, embedded: all.length - missing.length, missing: missing.length };
    return capture.imageSummary;
  }
  scope.PagecraftImages = { resolveAssets, encodeAssets, finalizeCapture, placeImage };
  if (typeof module !== 'undefined') module.exports = scope.PagecraftImages;
})(typeof globalThis !== 'undefined' ? globalThis : this);
