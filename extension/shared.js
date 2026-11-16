/* Shared by the page capture script and the extension window.
   Colour parsing and conversion of a live <svg> element into self-contained
   markup that Figma's SVG importer understands. */
(function (scope) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  let colorContext = null;
  function parseColor(value) {
    const text = String(value || '').trim();
    let m = /^rgba?\(([^)]+)\)$/i.exec(text);
    if (m) {
      const p = m[1].split(/[\s,\/]+/).filter(Boolean).map((v, i) => { const n = Number.parseFloat(v); return v.endsWith('%') ? n / 100 : i < 3 ? n / 255 : n; });
      if (p.length >= 3 && p.every(Number.isFinite)) return { r: clamp01(p[0]), g: clamp01(p[1]), b: clamp01(p[2]), a: p.length > 3 ? clamp01(p[3]) : 1 };
    }
    m = /^color\(srgb\s+([^)]+)\)$/i.exec(text);
    if (m) {
      const p = m[1].split(/[\s\/]+/).filter(Boolean).map(Number.parseFloat);
      if (p.length >= 3 && p.every(Number.isFinite)) return { r: clamp01(p[0]), g: clamp01(p[1]), b: clamp01(p[2]), a: p.length > 3 ? clamp01(p[3]) : 1 };
    }
    if (!text || text === 'transparent' || text === 'none') return { r: 0, g: 0, b: 0, a: 0 };
    try {
      if (!colorContext) { const c = document.createElement('canvas'); c.width = c.height = 1; colorContext = c.getContext('2d', { willReadFrequently: true }); }
      colorContext.clearRect(0, 0, 1, 1); colorContext.fillStyle = '#000'; colorContext.fillStyle = text; colorContext.fillRect(0, 0, 1, 1);
      const d = colorContext.getImageData(0, 0, 1, 1).data;
      return { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255, a: d[3] / 255 };
    } catch (_) { return { r: 0, g: 0, b: 0, a: 1 }; }
  }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function hex(c) { return '#' + [c.r, c.g, c.b].map(v => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join(''); }
  const round = (v, p = 100) => Math.round(v * p) / p;

  const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textPath']);
  const DROP = new Set(['script', 'style', 'foreignObject', 'title', 'desc', 'metadata', 'animate', 'animateTransform', 'animateMotion', 'set']);
  const PAINT_ATTRS = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset'];
  const refId = value => { const m = /url\(\s*["']?#([^"')\s]+)/.exec(value || ''); return m ? m[1] : null; };

  /* Returns { inner, viewBox, width, height } where inner is markup for the
     children of the svg, with styles resolved to attributes, <use> expanded,
     and ids made unique so several icons can share one document. */
  let sequence = 0;
  function normalizeSvg(root, note = () => {}) {
    const doc = root.ownerDocument, view = doc.defaultView || scope;
    const lookup = id => { const r = root.getRootNode(); return (r && r.getElementById && r.getElementById(id)) || doc.getElementById(id); };
    function paint(cs, target, name) {
      const value = cs.getPropertyValue(name);
      if (!value || value === 'none') { target.setAttribute(name, 'none'); return false; }
      const ref = refId(value);
      if (ref) { target.setAttribute(name, `url(#${ref})`); return true; }
      const c = parseColor(value), opacity = c.a * (Number.parseFloat(cs.getPropertyValue(name + '-opacity')) || 0);
      target.setAttribute(name, hex(c));
      if (opacity < 1) target.setAttribute(name + '-opacity', round(opacity, 1000)); else target.removeAttribute(name + '-opacity');
      return true;
    }
    function applyComputed(cs, target, isText) {
      paint(cs, target, 'fill');
      if (cs.fillRule && cs.fillRule !== 'nonzero') target.setAttribute('fill-rule', cs.fillRule);
      if (paint(cs, target, 'stroke')) {
        target.setAttribute('stroke-width', Number.parseFloat(cs.strokeWidth) || 0);
        if (cs.strokeLinecap !== 'butt') target.setAttribute('stroke-linecap', cs.strokeLinecap);
        if (cs.strokeLinejoin !== 'miter') target.setAttribute('stroke-linejoin', cs.strokeLinejoin);
        if (cs.strokeMiterlimit && cs.strokeMiterlimit !== '4') target.setAttribute('stroke-miterlimit', cs.strokeMiterlimit);
        if (cs.strokeDasharray && cs.strokeDasharray !== 'none') {
          target.setAttribute('stroke-dasharray', cs.strokeDasharray.replace(/px/g, ''));
          if (Number.parseFloat(cs.strokeDashoffset)) target.setAttribute('stroke-dashoffset', Number.parseFloat(cs.strokeDashoffset));
        }
      } else ['stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin'].forEach(a => target.removeAttribute(a));
      if (isText) {
        target.setAttribute('font-family', cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, ''));
        target.setAttribute('font-size', Number.parseFloat(cs.fontSize) || 16);
        target.setAttribute('font-weight', cs.fontWeight);
        if (cs.textAnchor && cs.textAnchor !== 'start') target.setAttribute('text-anchor', cs.textAnchor);
      }
    }
    function build(source, ctx, depth) {
      const tag = source.localName;
      if (DROP.has(tag) || depth > 40) return null;
      let cs = null;
      if (ctx.computed) {
        cs = view.getComputedStyle(source);
        if (cs.display === 'none' && !ctx.defs) return null;
        if (SHAPES.has(tag) && cs.visibility !== 'visible' && !ctx.defs) return null;
      }
      if (tag === 'use') return expandUse(source, ctx, cs, depth);
      if (tag === 'image') {
        const href = source.getAttribute('href') || source.getAttribute('xlink:href') || '';
        if (!/^data:image\/(png|jpe?g)/i.test(href)) { note('An image inside an SVG graphic could not be embedded.'); return null; }
      }
      const copy = tag === 'a' || tag === 'switch' ? doc.createElementNS(SVG_NS, 'g') : source.cloneNode(false);
      for (const attr of [...copy.attributes]) if (/^(on|data-)/i.test(attr.name) || attr.name === 'class') copy.removeAttribute(attr.name);
      const inline = copy.getAttribute('style'); copy.removeAttribute('style');
      if (cs) {
        if (SHAPES.has(tag)) applyComputed(cs, copy, tag === 'text' || tag === 'tspan' || tag === 'textPath');
        const opacity = Number.parseFloat(cs.opacity);
        if (opacity < 1) copy.setAttribute('opacity', round(opacity, 1000)); else copy.removeAttribute('opacity');
        if (cs.transform && cs.transform !== 'none' && !source.hasAttribute('transform')) copy.setAttribute('transform', cs.transform);
        for (const [prop, attr] of [['clipPath', 'clip-path'], ['mask', 'mask']]) { const ref = refId(cs[prop]); if (ref) copy.setAttribute(attr, `url(#${ref})`); }
        if (tag === 'stop') {
          const c = parseColor(cs.stopColor); copy.setAttribute('stop-color', hex(c));
          const so = c.a * (Number.parseFloat(cs.stopOpacity) || 0); if (so < 1) copy.setAttribute('stop-opacity', round(so, 1000));
        }
      } else {
        // Detached content (the target of a <use>): keep authored paint, resolve currentColor.
        if (inline) for (const part of inline.split(';')) { const i = part.indexOf(':'); if (i > 0) { const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim(); if (/^[a-z-]+$/.test(k) && v && !k.startsWith('-')) copy.setAttribute(k, v); } }
        for (const a of ['fill', 'stroke', 'stop-color', 'color']) if (/^currentcolor$/i.test(copy.getAttribute(a) || '')) copy.setAttribute(a, ctx.color || '#000000');
      }
      const next = tag === 'defs' || tag === 'clipPath' || tag === 'mask' || tag === 'pattern' || tag === 'marker' || tag === 'symbol' || /Gradient$/.test(tag) ? { ...ctx, defs: true } : ctx;
      const keepText = tag === 'text' || tag === 'tspan' || tag === 'textPath';
      for (const child of source.childNodes) {
        if (child.nodeType === 1) { const built = build(child, next, depth + 1); if (built) copy.appendChild(built); }
        else if (child.nodeType === 3 && keepText) copy.appendChild(doc.createTextNode(child.data));
      }
      return copy;
    }
    function expandUse(source, ctx, cs, depth) {
      const href = source.getAttribute('href') || source.getAttribute('xlink:href') || '';
      const target = href.startsWith('#') ? lookup(href.slice(1)) : null;
      if (!target || target === root || target.contains(source)) { if (href && !href.startsWith('#')) note('An icon from an external SVG sprite could not be resolved.'); return null; }
      const g = doc.createElementNS(SVG_NS, 'g');
      const length = name => { try { return source.hasAttribute(name) ? source[name].baseVal.value : 0; } catch (_) { return Number.parseFloat(source.getAttribute(name)) || 0; } };
      const transforms = []; if (source.getAttribute('transform')) transforms.push(source.getAttribute('transform'));
      const x = length('x'), y = length('y'); if (x || y) transforms.push(`translate(${round(x)} ${round(y)})`);
      let color = ctx.color || '#000000';
      if (cs) {
        applyComputed(cs, g, false); color = hex(parseColor(cs.color));
        const opacity = Number.parseFloat(cs.opacity); if (opacity < 1) g.setAttribute('opacity', round(opacity, 1000));
      } else for (const a of PAINT_ATTRS) if (source.hasAttribute(a)) g.setAttribute(a, /^currentcolor$/i.test(source.getAttribute(a)) ? color : source.getAttribute(a));
      const childCtx = { computed: false, color };
      if (target.localName === 'symbol' || target.localName === 'svg') {
        const vb = target.viewBox && target.viewBox.baseVal, w = length('width'), h = length('height');
        if (vb && vb.width && vb.height && w && h) {
          const s = Math.min(w / vb.width, h / vb.height);
          transforms.push(`translate(${round((w - vb.width * s) / 2)} ${round((h - vb.height * s) / 2)}) scale(${round(s, 100000)}) translate(${-vb.x} ${-vb.y})`);
        }
        for (const child of target.childNodes) if (child.nodeType === 1) { const built = build(child, childCtx, depth + 1); if (built) g.appendChild(built); }
      } else { const built = build(target, childCtx, depth + 1); if (built) { built.removeAttribute('id'); g.appendChild(built); } }
      if (transforms.length) g.setAttribute('transform', transforms.join(' '));
      return g.childNodes.length ? g : null;
    }
    const holder = doc.createElementNS(SVG_NS, 'g');
    for (const child of root.childNodes) if (child.nodeType === 1) { const built = build(child, { computed: true }, 0); if (built) holder.appendChild(built); }
    // Pull in gradients, clips and masks that are defined elsewhere in the page.
    const all = () => [holder, ...holder.querySelectorAll('*')];
    for (let pass = 0; pass < 3; pass++) {
      const have = new Set(all().map(el => el.getAttribute('id')).filter(Boolean)); let added = false;
      for (const el of all()) for (const attr of [...el.attributes]) {
        const ref = refId(attr.value) || (/href$/.test(attr.name) && attr.value.startsWith('#') ? attr.value.slice(1) : null);
        if (!ref || have.has(ref)) continue;
        const target = lookup(ref); have.add(ref);
        if (target && !root.contains(target)) { const built = build(target, { computed: false, color: '#000000', defs: true }, 0); if (built) { let defs = holder.querySelector('defs'); if (!defs) { defs = doc.createElementNS(SVG_NS, 'defs'); holder.appendChild(defs); } defs.appendChild(built); added = true; } }
      }
      if (!added) break;
    }
    const prefix = `s${++sequence}${Math.random().toString(36).slice(2, 5)}_`, ids = new Set();
    for (const el of all()) { const id = el.getAttribute('id'); if (id) { ids.add(id); el.setAttribute('id', prefix + id); } }
    for (const el of all()) for (const attr of [...el.attributes]) {
      if (attr.name === 'id') continue;
      let value = attr.value.replace(/url\(\s*["']?#([^"')\s]+)["']?\s*\)/g, (m, id) => ids.has(id) ? `url(#${prefix}${id})` : m);
      if (/href$/.test(attr.name) && value.startsWith('#') && ids.has(value.slice(1))) value = '#' + prefix + value.slice(1);
      if (value !== attr.value) el.setAttribute(attr.name, value);
    }
    const serializer = new XMLSerializer();
    const inner = [...holder.childNodes].map(n => serializer.serializeToString(n)).join('').split(` xmlns="${SVG_NS}"`).join('');
    let viewBox = null, width = 0, height = 0;
    try { const vb = root.viewBox.baseVal; if (vb && vb.width > 0 && vb.height > 0) viewBox = [vb.x, vb.y, vb.width, vb.height]; } catch (_) {}
    const abs = name => { const v = root.getAttribute(name); return v && /^[\d.]+(px)?$/.test(v.trim()) ? Number.parseFloat(v) : 0; };
    width = abs('width') || (viewBox ? viewBox[2] : 0); height = abs('height') || (viewBox ? viewBox[3] : 0);
    return { inner, viewBox, width, height, stretch: root.getAttribute('preserveAspectRatio') === 'none' };
  }
  /* Transform that maps svg user space onto a target box (xMidYMid meet unless stretch). */
  function svgTransform(svg, x, y, w, h) {
    if (!svg.viewBox) return `translate(${round(x)} ${round(y)})`;
    const [vx, vy, vw, vh] = svg.viewBox;
    let sx = w / vw, sy = h / vh;
    if (!svg.stretch) { sx = sy = Math.min(sx, sy); x += (w - vw * sx) / 2; y += (h - vh * sy) / 2; }
    return `translate(${round(x)} ${round(y)}) scale(${round(sx, 100000)} ${round(sy, 100000)})` + (vx || vy ? ` translate(${-vx} ${-vy})` : '');
  }
  scope.PagecraftShared = { parseColor, hex, round, normalizeSvg, svgTransform, SVG_NS };
  if (typeof module !== 'undefined') module.exports = scope.PagecraftShared;
})(typeof globalThis !== 'undefined' ? globalThis : this);
