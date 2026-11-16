/* Runs in the isolated world of the selected tab. No page scripts are copied. */
async function captureDocument(options = {}) {
  await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 2500))]);
  const warnings = new Set();
  const mode = options.mode || 'page';
  const selected = mode === 'selector' ? document.querySelector(options.selector) : document.documentElement;
  if (!selected) throw new Error('No element matches that CSS selector.');
  const r = selected.getBoundingClientRect();
  const bounds = mode === 'viewport' ? { x: 0, y: 0, width: innerWidth, height: innerHeight } :
    mode === 'selector' ? { x: r.x, y: r.y, width: r.width, height: r.height } :
    { x: -scrollX, y: -scrollY, width: Math.max(document.documentElement.scrollWidth, innerWidth), height: Math.max(document.documentElement.scrollHeight, innerHeight) };
  if (!bounds.width || !bounds.height) throw new Error('The selected element has no visible size.');
  const assets = {};
  const assetURLs = new Map();
  let sequence = 0, count = 0;
  const number = value => Number.parseFloat(value) || 0;
  const colorCanvas = document.createElement('canvas'); colorCanvas.width = colorCanvas.height = 1;
  const colorContext = colorCanvas.getContext('2d', { willReadFrequently: true });
  function color(value) {
    colorContext.clearRect(0, 0, 1, 1); colorContext.fillStyle = '#000'; colorContext.fillStyle = value;
    colorContext.fillRect(0, 0, 1, 1); const c = colorContext.getImageData(0, 0, 1, 1).data;
    return { r: c[0] / 255, g: c[1] / 255, b: c[2] / 255, a: c[3] / 255 };
  }
  function asset(url, element) {
    if (!url) return null;
    if (assetURLs.has(url)) return assetURLs.get(url);
    const id = `asset-${++sequence}`; assetURLs.set(url, id);
    let data = null;
    try {
      if (element && (element.naturalWidth || element.width)) {
        const w = element.naturalWidth || element.width, h = element.naturalHeight || element.height;
        const scale = Math.min(1, 4096 / Math.max(w, h));
        const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
        c.getContext('2d').drawImage(element, 0, 0, c.width, c.height); data = c.toDataURL('image/png');
      }
    } catch (_) { /* Cross-origin images can be embedded by the extension with optional permission. */ }
    assets[id] = { url, data }; return id;
  }
  function geometry(rect, origin) { return { x: rect.x - origin.x, y: rect.y - origin.y, width: Math.max(.01, rect.width), height: Math.max(.01, rect.height) }; }
  function textRuns(textNode, style, origin) {
    if (!textNode.textContent.trim()) return [];
    const raw = textNode.textContent, range = document.createRange();
    const runs = []; let line = null;
    // Range geometry preserves browser wrapping, including mixed inline styles and RTL runs.
    for (let i = 0; i < raw.length;) {
      const ch = String.fromCodePoint(raw.codePointAt(i));
      range.setStart(textNode, i); i += ch.length; range.setEnd(textNode, i);
      const boxes = range.getClientRects(); if (!boxes.length) continue;
      const b = boxes[0]; if (b.width < .01 || b.height < .01) continue;
      if (!line || Math.abs(line.top - b.y) > 2) {
        line = { text: '', top: b.y, left: b.x, right: b.right, bottom: b.bottom }; runs.push(line);
      }
      line.text += ch; line.left = Math.min(line.left, b.x); line.right = Math.max(line.right, b.right); line.bottom = Math.max(line.bottom, b.bottom);
    }
    return runs.filter(l => l.text.trim()).map(l => {
      let text = /^(pre|pre-wrap|break-spaces)$/.test(style.whiteSpace) ? l.text : l.text.replace(/\s+/g, ' ');
      if (style.textTransform === 'uppercase') text = text.toUpperCase();
      if (style.textTransform === 'lowercase') text = text.toLowerCase();
      return { type: 'text', name: text.slice(0, 60), text, x: l.left - origin.x, y: l.top - origin.y, width: l.right - l.left, height: l.bottom - l.top,
        color: color(style.color), fontFamily: style.fontFamily, fontSize: number(style.fontSize), fontWeight: number(style.fontWeight), italic: style.fontStyle !== 'normal', letterSpacing: number(style.letterSpacing), decoration: style.textDecorationLine, direction: style.direction };
    });
  }
  function serializeSVG(element) {
    const clone = element.cloneNode(true), originals = [element, ...element.querySelectorAll('*')], copies = [clone, ...clone.querySelectorAll('*')];
    const properties = ['fill','fill-opacity','stroke','stroke-width','stroke-opacity','stroke-linecap','stroke-linejoin','opacity','color','font-family','font-size','font-weight'];
    copies.forEach((el, i) => {
      const style = getComputedStyle(originals[i]);
      properties.forEach(p => el.style.setProperty(p, style.getPropertyValue(p)));
      for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    });
    clone.querySelectorAll('script,foreignObject').forEach(el => el.remove());
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return new XMLSerializer().serializeToString(clone);
  }
  async function walk(element, origin) {
    if (['SCRIPT','STYLE','LINK','META','NOSCRIPT','TEMPLATE','HEAD'].includes(element.tagName)) return null;
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || number(style.opacity) === 0) return null;
    if (++count % 350 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    const empty = !rect.width || !rect.height;
    const box = empty ? { x: origin.x, y: origin.y, width: .01, height: .01 } : rect;
    if (style.transform !== 'none') warnings.add('Transforms are captured as axis-aligned bounding boxes; rotated or skewed content may differ.');
    if (style.filter !== 'none' || style.backdropFilter !== 'none') warnings.add('CSS filters and backdrop blur are not reproduced.');
    if (style.boxShadow !== 'none') warnings.add('CSS box shadows are not reproduced.');
    if (style.backgroundImage.includes('gradient(')) warnings.add('CSS gradients are approximated by the background color.');
    const node = { type: 'frame', name: element.tagName.toLowerCase() + (element.id ? `#${element.id}` : ''), ...geometry(box, origin), opacity: number(style.opacity), fill: color(style.backgroundColor),
      radii: ['borderTopLeftRadius','borderTopRightRadius','borderBottomRightRadius','borderBottomLeftRadius'].map(k => style[k].includes('%') ? number(style[k]) * Math.min(box.width,box.height) / 100 : number(style[k])),
      clip: ['hidden','clip','scroll','auto'].includes(style.overflowX) || ['hidden','clip','scroll','auto'].includes(style.overflowY), children: [],
      borders: ['Top','Right','Bottom','Left'].map(side => ({ width: number(style[`border${side}Width`]), color: color(style[`border${side}Color`]), style: style[`border${side}Style`] })) };
    const bg = style.backgroundImage.match(/^url\(["']?(.*?)["']?\)$/);
    if (bg) { node.image = asset(bg[1]); node.imageFit = style.backgroundSize === 'contain' ? 'FIT' : 'FILL'; warnings.add('Background images use cover/contain; tiling and custom positioning are approximated.'); }
    if (element.tagName.toLowerCase() === 'svg') return { type: 'svg', name: 'SVG', ...geometry(box, origin), svg: serializeSVG(element), opacity: node.opacity };
    if (element.tagName === 'IMG') { node.image = asset(element.currentSrc || element.src, element); node.imageFit = style.objectFit === 'contain' ? 'FIT' : 'FILL'; }
    if (element.tagName === 'CANVAS') {
      try { const data = element.toDataURL('image/png'); node.image = asset(data, element); }
      catch (_) { warnings.add('A protected canvas could not be captured.'); }
    }
    if (element.tagName === 'IFRAME') warnings.add('Iframe content is not included. Open the frame in its own tab to capture it.');
    if (element.tagName === 'VIDEO') warnings.add('Video content is not included.');
    if (['INPUT','TEXTAREA','SELECT'].includes(element.tagName)) { warnings.add('Native form control contents are omitted; entered values are not exported.'); return node; }
    for (const pseudo of ['::before','::after']) {
      const ps = getComputedStyle(element, pseudo);
      if (ps.content && !['none','normal','""'].includes(ps.content)) warnings.add('CSS pseudo-elements are not included.');
    }
    const children = element.shadowRoot ? element.shadowRoot.childNodes : element.tagName === 'SLOT' ? element.assignedNodes({ flatten: true }) : element.childNodes;
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) node.children.push(...textRuns(child, style, box));
      else if (child.nodeType === Node.ELEMENT_NODE) { const next = await walk(child, box); if (next) node.children.push(next); }
    }
    return node;
  }
  const tree = await walk(selected, { x: bounds.x, y: bounds.y });
  if (!tree) throw new Error('The selected area is hidden.');
  warnings.add('Layout uses fixed positions. Auto Layout, interactions and responsive rules are not reconstructed.');
  return { format: 'pagecraft', version: 1, title: document.title || 'Untitled page', url: location.href, capturedAt: new Date().toISOString(), width: bounds.width, height: bounds.height, viewport: { width: innerWidth, height: innerHeight }, tree, assets, warnings: [...warnings], elementCount: count };
}
if (typeof module !== 'undefined') module.exports = { captureDocument };
