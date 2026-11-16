/* Injected into the page being captured (isolated world, after shared.js).
   Reads the rendered layout and returns a tree of frames, text and vectors.
   All coordinates are absolute, relative to the top-left of the capture. */
(function (scope) {
  const S = scope.PagecraftShared;
  const SKIP = new Set(['script', 'style', 'link', 'meta', 'noscript', 'template', 'head', 'title', 'base', 'datalist', 'source', 'track', 'param', 'area', 'map', 'option', 'optgroup']);
  const REPLACED = new Set(['img', 'svg', 'canvas', 'video', 'iframe', 'input', 'textarea', 'select', 'button', 'object', 'embed', 'picture', 'audio', 'meter', 'progress']);
  const ICON_FONT = /material (icons|symbols)|icomoon|font ?awesome|glyphicons|bootstrap-icons|remixicon|ionicons|dashicons|themify|linearicons|icofont|eicons|swiper-icons|fontello|elegant ?icons|simple-line-icons|typicons|boxicons|phosphor|tabler-icons|lucide/i;
  const PRIVATE_USE = /^[\s\uE000-\uF8FF\u{F0000}-\u{10FFFD}]+$/u;

  async function captureDocument(options = {}) {
    const mode = options.mode || 'page';
    const warnings = new Set(), note = message => warnings.add(message);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const num = value => Number.parseFloat(value) || 0;
    const px = value => (typeof value === 'string' && value.endsWith('px') ? Number.parseFloat(value) : null);
    const docEl = document.documentElement;
    let selected = docEl;
    if (mode === 'selector') {
      try { selected = document.querySelector(options.selector || ''); } catch (_) { throw new Error('That is not a valid CSS selector.'); }
      if (!selected) throw new Error('No element matches that CSS selector.');
    }
    const restore = { x: scrollX, y: scrollY };
    await Promise.race([document.fonts.ready, sleep(2500)]);

    /* ---- Let the page settle: trigger lazy content, finish animations, load images ---- */
    const pageHeight = () => Math.max(docEl.scrollHeight, document.body ? document.body.scrollHeight : 0, docEl.clientHeight);
    if (mode === 'page') {
      if (options.scroll !== false && pageHeight() > innerHeight + 8) {
        const step = Math.max(200, innerHeight * 0.85);
        for (let y = 0, i = 0; y < pageHeight() && i < 80; y += step, i++) { scrollTo({ left: 0, top: y, behavior: 'instant' }); await sleep(110); }
      }
      scrollTo({ left: 0, top: 0, behavior: 'instant' }); await sleep(250);
    }
    try {
      for (const animation of document.getAnimations()) {
        const timing = animation.effect && animation.effect.getComputedTiming();
        if (timing && Number.isFinite(timing.endTime) && animation.playState === 'running') { try { animation.finish(); } catch (_) {} }
      }
    } catch (_) {}
    const pendingImages = [...selected.querySelectorAll('img')].filter(img => !(img.complete && img.naturalWidth) && (img.currentSrc || img.src || img.getAttribute('srcset')));
    if (pendingImages.length) {
      await Promise.race([sleep(8000), Promise.all(pendingImages.map(img => { img.loading = 'eager'; return img.decode().catch(() => {}); }))]);
    }
    await new Promise(resolve => requestAnimationFrame(() => resolve())).catch(() => {});

    try {
      /* ---- Geometry ---- */
      const sr = selected.getBoundingClientRect();
      const bounds = mode === 'viewport' ? { x: 0, y: 0, width: docEl.clientWidth || innerWidth, height: docEl.clientHeight || innerHeight }
        : mode === 'selector' ? { x: sr.x, y: sr.y, width: sr.width, height: sr.height }
        : { x: -scrollX, y: -scrollY, width: docEl.clientWidth || innerWidth, height: pageHeight() };
      if (!(bounds.width > 0 && bounds.height > 0)) throw new Error('The selected element has no visible size.');
      const off = { x: 0, y: 0 }; // offset of the current (i)frame's viewport inside the top viewport
      const box = r => ({ x: r.x + off.x - bounds.x, y: r.y + off.y - bounds.y, width: r.width, height: r.height });

      /* ---- Assets ---- */
      const assets = {}, assetIds = new Map(); let sequence = 0, count = 0;
      function asset(url, base) {
        if (!url) return null; let abs;
        try { abs = new URL(url, base || document.baseURI).href; } catch (_) { return null; }
        if (!/^(https?:|data:image\/|blob:|file:)/i.test(abs)) return null;
        let id = assetIds.get(abs);
        if (!id) { id = `a${++sequence}`; assetIds.set(abs, id); assets[id] = { url: abs }; }
        return id;
      }
      function inlineAsset(canvas, cssWidth, cssHeight, type) {
        const id = `a${++sequence}`;
        assets[id] = { url: `inline:${id}`, data: canvas.toDataURL(type || 'image/png', 0.92), width: cssWidth || canvas.width, height: cssHeight || canvas.height, pw: canvas.width, ph: canvas.height };
        return id;
      }

      /* ---- Fonts and text metrics ---- */
      const measure = document.createElement('canvas').getContext('2d');
      const mac = /mac|iphone|ipad/i.test(navigator.platform || '');
      const GENERIC = { 'sans-serif': mac ? 'Helvetica' : 'Arial', serif: mac ? 'Times' : 'Times New Roman', monospace: mac ? 'Menlo' : 'Consolas', 'system-ui': mac ? 'SF Pro Text' : 'Segoe UI', '-apple-system': mac ? 'SF Pro Text' : 'Segoe UI', blinkmacsystemfont: mac ? 'SF Pro Text' : 'Segoe UI', 'ui-sans-serif': mac ? 'SF Pro Text' : 'Segoe UI', 'ui-serif': mac ? 'Times' : 'Times New Roman', 'ui-monospace': mac ? 'Menlo' : 'Consolas', cursive: 'Comic Sans MS', fantasy: 'Impact', emoji: 'Segoe UI Emoji', math: 'Cambria Math' };
      const SYSTEM = /^(arial|helvetica|helvetica neue|segoe ui|sf pro text|sf pro display|tahoma|verdana|times|times new roman|georgia|consolas|menlo|courier new|courier|trebuchet ms|calibri|cambria|lucida grande|lucida sans unicode|san francisco|apple color emoji|segoe ui emoji|comic sans ms|impact)$/i;
      const available = new Map(), families = new Map(), metricCache = new Map();
      function isAvailable(family) {
        if (available.has(family)) return available.get(family);
        const probe = 'mmmmmmmmlli10WQ@ءيabc', quoted = `"${family.replace(/"/g, '')}"`; let result = false;
        for (const base of ['monospace', 'serif']) {
          measure.font = `72px ${base}`; const a = measure.measureText(probe).width;
          measure.font = `72px ${quoted}, ${base}`; if (measure.measureText(probe).width !== a) { result = true; break; }
        }
        available.set(family, result); return result;
      }
      function resolveFamily(stack) {
        if (families.has(stack)) return families.get(stack);
        const list = stack.split(',').map(f => f.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        let result = null;
        for (const family of list) {
          const generic = GENERIC[family.toLowerCase()];
          if (generic) { result = { family: generic, system: true }; break; }
          if (isAvailable(family)) { result = { family, system: SYSTEM.test(family) }; break; }
        }
        if (!result) result = { family: list.find(f => !GENERIC[f.toLowerCase()]) || 'Inter', system: true };
        families.set(stack, result); return result;
      }
      function metrics(cs) {
        const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        let m = metricCache.get(font);
        if (!m) {
          measure.font = font; const t = measure.measureText('Hxgp'), size = num(cs.fontSize);
          m = { font, ascent: Number.isFinite(t.fontBoundingBoxAscent) ? t.fontBoundingBoxAscent : size * 0.9, descent: Number.isFinite(t.fontBoundingBoxDescent) ? t.fontBoundingBoxDescent : size * 0.25 };
          metricCache.set(font, m);
        }
        return m;
      }
      function textWidth(text, cs) { const m = metrics(cs); measure.font = m.font; return measure.measureText(text).width + num(cs.letterSpacing) * [...text].length; }
      function lineHeight(cs) { const m = metrics(cs); return px(cs.lineHeight) || (m.ascent + m.descent); }
      function textStyle(cs, deco) {
        const family = resolveFamily(cs.fontFamily);
        let color = S.parseColor(cs.webkitTextFillColor && cs.webkitTextFillColor !== 'currentcolor' ? cs.webkitTextFillColor : cs.color);
        if (color.a === 0) { // gradient text: background-clip:text with a transparent fill
          const first = /rgba?\([^)]+\)/.exec(cs.backgroundImage || ''); if (first) color = S.parseColor(first[0]);
        }
        const line = `${cs.textDecorationLine || ''} ${deco || ''}`;
        return { color, fontFamily: family.family, system: family.system, fontStack: cs.fontFamily, fontSize: num(cs.fontSize), fontWeight: num(cs.fontWeight) || 400, italic: cs.fontStyle !== 'normal', letterSpacing: num(cs.letterSpacing), decoration: line.includes('underline') ? 'underline' : line.includes('line-through') ? 'line-through' : 'none' };
      }
      function transformText(text, cs) {
        const t = cs.textTransform;
        return t === 'uppercase' ? text.toUpperCase() : t === 'lowercase' ? text.toLowerCase() : t === 'capitalize' ? text.replace(/(^|[\s\-(])(\p{L})/gu, (m, a, c) => a + c.toUpperCase()) : text;
      }
      function alignOf(cs) {
        const a = cs.textAlign, rtl = cs.direction === 'rtl';
        return a.includes('center') ? 'CENTER' : a === 'justify' ? 'JUSTIFIED' : a === 'right' || a.includes('-right') || (a === 'end' && !rtl) || (a === 'start' && rtl) ? 'RIGHT' : a === 'left' || a.includes('-left') || a === 'start' || a === 'end' ? 'LEFT' : rtl ? 'RIGHT' : 'LEFT';
      }
      function isIcon(text, style) { return !!text.trim() && (PRIVATE_USE.test(text) || (ICON_FONT.test(style.fontStack) && [...text.trim()].length <= 40)); }
      /* Icon fonts do not exist in Figma, so their glyphs are embedded as images. */
      function glyphNode(text, cs, b, baseline, name) {
        const scale = 4, pad = Math.ceil(num(cs.fontSize) * 0.25);
        const w = Math.max(1, b.width + pad * 2), h = Math.max(1, b.height + pad * 2);
        const canvas = document.createElement('canvas'); canvas.width = Math.min(4096, Math.ceil(w * scale)); canvas.height = Math.min(4096, Math.ceil(h * scale));
        const ctx = canvas.getContext('2d'); ctx.scale(canvas.width / w, canvas.height / h);
        ctx.font = metrics(cs).font; ctx.fillStyle = cs.webkitTextFillColor && cs.webkitTextFillColor !== 'currentcolor' ? cs.webkitTextFillColor : cs.color; ctx.textBaseline = 'alphabetic';
        if (cs.direction === 'rtl') { ctx.direction = 'rtl'; ctx.textAlign = 'right'; ctx.fillText(text, w - pad, baseline - b.y + pad); } else ctx.fillText(text, pad, baseline - b.y + pad);
        const id = inlineAsset(canvas, w, h);
        return { type: 'frame', name: name || 'icon', x: b.x - pad, y: b.y - pad, width: w, height: h, opacity: 1, clip: false, radii: [0, 0, 0, 0], fills: [{ type: 'image', asset: id, rect: { x: 0, y: 0, width: w, height: h }, mode: 'fill' }], borders: null, shadows: [], children: [], z: 0 };
      }

      /* ---- Text lines as the browser laid them out ---- */
      function linesOf(textNode, pre) {
        const raw = textNode.data; if (!raw) return [];
        const range = textNode.ownerDocument.createRange(); range.selectNodeContents(textNode);
        const rects = [...range.getClientRects()].filter(q => q.width > 0.01 && q.height > 0.01);
        if (!rects.length) return [];
        const drawn = (a, c) => { range.setStart(textNode, a); range.setEnd(textNode, c); for (const q of range.getClientRects()) if (q.width > 0.01 && q.height > 0.01) return q; return null; };
        if (rects.length === 1) {
          let text = pre ? raw : raw.replace(/\s+/g, ' ');
          if (!pre) {
            const lead = /^\s+/.exec(raw), trail = /\s+$/.exec(raw);
            if (lead && !drawn(0, lead[0].length)) text = text.replace(/^ /, '');
            if (trail && trail.index > 0 && !drawn(trail.index, raw.length)) text = text.replace(/ $/, '');
          }
          return [{ text, rect: rects[0] }];
        }
        const lines = []; let line = null, pending = '';
        for (let i = 0; i < raw.length;) {
          const ch = String.fromCodePoint(raw.codePointAt(i)), start = i; i += ch.length;
          const b = drawn(start, i), space = /\s/.test(ch);
          if (!b) { if (!space) { if (line) line.text += ch; else pending += ch; } continue; } // combining marks and ligature parts have no box of their own
          const mid = b.y + b.height / 2;
          if (!line || Math.abs(mid - line.mid) > Math.max(2, b.height * 0.5)) { line = { text: pending, mid, x: b.x, y: b.y, right: b.right, bottom: b.bottom }; pending = ''; lines.push(line); }
          line.text += space && !pre ? ' ' : ch;
          line.x = Math.min(line.x, b.x); line.y = Math.min(line.y, b.y); line.right = Math.max(line.right, b.right); line.bottom = Math.max(line.bottom, b.bottom);
        }
        return lines.map(l => ({ text: l.text.replace(/ {2,}/g, ' '), rect: { x: l.x, y: l.y, width: l.right - l.x, height: l.bottom - l.y } }));
      }
      /* A run of text nodes and plain inline elements becomes one text layer
         with styled segments (for the plugin) and positioned line pieces (for SVG). */
      function textFromRun(run, blockCs) {
        const segments = [], pieces = [], extra = []; let lastSpace = true, key = null;
        for (const part of run) {
          if (part.br) { if (segments.length) { segments[segments.length - 1].text += '\n'; lastSpace = true; } continue; }
          const cs = part.cs, pre = /^(pre|pre-wrap|break-spaces)$/.test(cs.whiteSpace);
          const lines = linesOf(part.node, pre); if (!lines.length) continue;
          const style = textStyle(cs, part.deco), m = metrics(cs);
          if (isIcon(part.node.data, style)) {
            for (const l of lines) if (l.text.trim()) { const b = box(l.rect); extra.push(glyphNode(l.text.trim(), cs, b, b.y + (b.height - (m.ascent + m.descent)) / 2 + m.ascent, 'icon')); }
            continue;
          }
          let text = pre ? part.node.data : part.node.data.replace(/\s+/g, ' ');
          if (!pre && lastSpace) text = text.replace(/^ /, '');
          if (!text) continue;
          text = transformText(text, cs);
          const styleKey = JSON.stringify(style); let index;
          if (key === styleKey && segments.length) { index = segments.length - 1; segments[index].text += text; }
          else { index = segments.length; segments.push({ text, ...style }); key = styleKey; }
          lastSpace = /\s$/.test(text);
          for (const l of lines) {
            if (!l.text.trim()) continue;
            const b = box(l.rect);
            pieces.push({ s: index, text: transformText(l.text, cs), x: b.x, y: b.y, width: b.width, height: b.height, baseline: b.y + (b.height - (m.ascent + m.descent)) / 2 + m.ascent, rtl: cs.direction === 'rtl' });
          }
        }
        const out = [...extra];
        if (pieces.length && segments.length) {
          segments[segments.length - 1].text = segments[segments.length - 1].text.replace(/\s+$/, '');
          const x = Math.min(...pieces.map(p => p.x)), y = Math.min(...pieces.map(p => p.y));
          const right = Math.max(...pieces.map(p => p.x + p.width)), bottom = Math.max(...pieces.map(p => p.y + p.height));
          const mids = []; for (const p of pieces) { const mid = p.y + p.height / 2; if (!mids.some(v => Math.abs(v - mid) < p.height * 0.5)) mids.push(mid); }
          const full = segments.map(s => s.text).join('');
          if (full.trim()) out.push({ type: 'text', name: full.trim().slice(0, 40), x, y, width: right - x, height: bottom - y, align: alignOf(blockCs), lineHeight: px(blockCs.lineHeight), lines: mids.length, segments, pieces, z: 0 });
        }
        return out;
      }
      function simpleText(text, cs, style, x, y, width, lh, name, extra) {
        const m = metrics(cs);
        return { type: 'text', name: (name || text).slice(0, 40), x, y, width, height: lh, align: 'LEFT', lineHeight: null, lines: 1, segments: [{ text, ...style }], pieces: [{ s: 0, text, x, y, width, height: lh, baseline: y + (lh - (m.ascent + m.descent)) / 2 + m.ascent, rtl: false }], z: 0, ...extra };
      }

      /* ---- Box painting ---- */
      function splitTop(value) {
        const parts = []; let depth = 0, current = '';
        for (const ch of value) { if (ch === '(') depth++; else if (ch === ')') depth--; if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; } else current += ch; }
        if (current.trim()) parts.push(current.trim());
        return parts;
      }
      function parseStops(parts, length) {
        const stops = [];
        for (const part of parts) {
          const m = /^(.+?)((?:\s+-?[\d.]+(?:%|px))*)$/.exec(part.trim()); if (!m) continue;
          if (/^-?[\d.]+(%|px)$/.test(m[1].trim())) continue; // colour hint
          const color = S.parseColor(m[1].trim());
          const positions = (m[2].match(/-?[\d.]+(?:%|px)/g) || []).map(p => p.endsWith('%') ? Number.parseFloat(p) / 100 : length ? Number.parseFloat(p) / length : 0);
          if (!positions.length) stops.push({ color, offset: null }); else for (const offset of positions) stops.push({ color, offset });
        }
        if (stops.length < 2) return stops.length ? [{ ...stops[0], offset: 0 }, { ...stops[0], offset: 1 }] : null;
        if (stops[0].offset === null) stops[0].offset = 0;
        if (stops[stops.length - 1].offset === null) stops[stops.length - 1].offset = 1;
        for (let i = 1; i < stops.length; i++) {
          if (stops[i].offset === null) { let j = i; while (stops[j].offset === null) j++; const a = stops[i - 1].offset, step = (stops[j].offset - a) / (j - i + 1); for (let k = i; k < j; k++) stops[k].offset = a + step * (k - i + 1); }
          stops[i].offset = Math.max(stops[i].offset, stops[i - 1].offset);
        }
        return stops.map(s => ({ color: s.color, offset: Math.max(0, Math.min(1, s.offset)) }));
      }
      function linearGradient(layer, w, h) {
        const args = splitTop(layer.slice(layer.indexOf('(') + 1, layer.lastIndexOf(')'))); let dx = 0, dy = 1;
        const first = (args[0] || '').trim(), unit = /^(-?[\d.]+)(deg|grad|rad|turn)$/.exec(first);
        if (unit) { const v = Number.parseFloat(unit[1]), rad = unit[2] === 'deg' ? v * Math.PI / 180 : unit[2] === 'grad' ? v * Math.PI / 200 : unit[2] === 'turn' ? v * 2 * Math.PI : v; dx = Math.sin(rad); dy = -Math.cos(rad); args.shift(); }
        else if (first.startsWith('to ')) {
          const sx = first.includes('right') ? 1 : first.includes('left') ? -1 : 0, sy = first.includes('bottom') ? 1 : first.includes('top') ? -1 : 0;
          if (sx && sy) { const l = Math.hypot(h, w) || 1; dx = sx * h / l; dy = sy * w / l; } else { dx = sx; dy = sy; }
          args.shift();
        }
        const length = Math.abs(w * dx) + Math.abs(h * dy), stops = parseStops(args, length); if (!stops) return null;
        return { type: 'linear', x1: w / 2 - dx * length / 2, y1: h / 2 - dy * length / 2, x2: w / 2 + dx * length / 2, y2: h / 2 + dy * length / 2, stops };
      }
      function radialGradient(layer, w, h) {
        const args = splitTop(layer.slice(layer.indexOf('(') + 1, layer.lastIndexOf(')')));
        let cx = w / 2, cy = h / 2, circle = false, size = 'farthest-corner', explicit = null;
        const first = (args[0] || '').trim();
        if (/^(circle|ellipse|closest|farthest|at\s|-?[\d.]+(px|%))/.test(first)) {
          args.shift();
          const [shape, at] = first.split(/\s*\bat\s+/);
          if (at) {
            const t = at.trim().split(/\s+/), pos = (v, total) => v === 'left' || v === 'top' ? 0 : v === 'right' || v === 'bottom' ? total : v === 'center' ? total / 2 : v.endsWith('%') ? Number.parseFloat(v) / 100 * total : num(v);
            cx = pos(t[0], w); cy = pos(t[1] || 'center', h);
          }
          circle = /circle/.test(shape); const keyword = /(closest|farthest)-(side|corner)/.exec(shape); if (keyword) size = keyword[0];
          const lengths = shape.match(/-?[\d.]+(?:px|%)/g);
          if (lengths) { explicit = lengths.map((v, i) => v.endsWith('%') ? Number.parseFloat(v) / 100 * (i ? h : w) : num(v)); if (explicit.length === 1) circle = true; }
        }
        const nx = Math.min(cx, w - cx), fx = Math.max(cx, w - cx), ny = Math.min(cy, h - cy), fy = Math.max(cy, h - cy); let rx, ry;
        if (explicit) { rx = explicit[0]; ry = explicit[1] ?? explicit[0]; }
        else if (circle) { rx = ry = size === 'closest-side' ? Math.min(nx, ny) : size === 'farthest-side' ? Math.max(fx, fy) : size === 'closest-corner' ? Math.hypot(nx, ny) : Math.hypot(fx, fy); }
        else if (size === 'closest-side') { rx = nx; ry = ny; } else if (size === 'farthest-side') { rx = fx; ry = fy; }
        else if (size === 'closest-corner') { rx = nx * Math.SQRT2; ry = ny * Math.SQRT2; } else { rx = fx * Math.SQRT2; ry = fy * Math.SQRT2; }
        const stops = parseStops(args, rx); if (!stops || !(rx > 0) || !(ry > 0)) return null;
        return { type: 'radial', cx, cy, rx, ry, stops };
      }
      function edges(cs) {
        const side = s => ({ border: num(cs[`border${s}Width`]), padding: num(cs[`padding${s}`]) });
        return { top: side('Top'), right: side('Right'), bottom: side('Bottom'), left: side('Left') };
      }
      function frameFrom(cs, b, name, painted) {
        const node = { type: 'frame', name, x: b.x, y: b.y, width: b.width, height: b.height, opacity: 1, clip: false, radii: [0, 0, 0, 0], fills: [], borders: null, shadows: [], children: [], z: 0 };
        if (!painted || !(b.width > 0) || !(b.height > 0)) return node;
        const limit = Math.min(b.width, b.height) / 2;
        node.radii = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].map(k => { const v = (cs[k] || '0').split(' ')[0]; return Math.max(0, Math.min(limit, v.endsWith('%') ? num(v) / 100 * Math.min(b.width, b.height) : num(v))); });
        const clipText = cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text';
        const color = S.parseColor(cs.backgroundColor);
        // Icons drawn as a coloured box cut out by mask-image: keep the icon shape, tinted.
        const mask = /^url\(\s*["']?(.*?)["']?\s*\)$/.exec(cs.maskImage && cs.maskImage !== 'none' ? cs.maskImage : cs.webkitMaskImage || '');
        if (mask) {
          const id = color.a > 0 ? asset(mask[1].replace(/\\(.)/g, '$1')) : null;
          if (id) node.fills.push({ type: 'image', asset: id, kind: 'background', size: cs.maskSize || cs.webkitMaskSize || 'auto', position: cs.maskPosition || cs.webkitMaskPosition || '0% 0%', area: { x: 0, y: 0, width: b.width, height: b.height }, tint: S.hex(color), vectorOnly: true });
          return node;
        }
        if (color.a > 0 && !clipText) node.fills.push({ type: 'solid', color });
        if (cs.backgroundImage && cs.backgroundImage !== 'none' && !clipText) {
          const layers = splitTop(cs.backgroundImage), sizes = splitTop(cs.backgroundSize || 'auto'), positions = splitTop(cs.backgroundPosition || '0% 0%'), repeats = splitTop(cs.backgroundRepeat || 'repeat');
          const e = edges(cs), origin = cs.backgroundOrigin;
          const area = origin === 'border-box' ? { x: 0, y: 0, width: b.width, height: b.height }
            : origin === 'content-box' ? { x: e.left.border + e.left.padding, y: e.top.border + e.top.padding, width: b.width - e.left.border - e.left.padding - e.right.border - e.right.padding, height: b.height - e.top.border - e.top.padding - e.bottom.border - e.bottom.padding }
            : { x: e.left.border, y: e.top.border, width: b.width - e.left.border - e.right.border, height: b.height - e.top.border - e.bottom.border };
          for (let i = layers.length - 1; i >= 0; i--) {
            const layer = layers[i], size = sizes[i % sizes.length], repeat = repeats[i % repeats.length];
            const url = /^url\(\s*["']?(.*?)["']?\s*\)$/.exec(layer);
            if (url) { const id = asset(url[1].replace(/\\(.)/g, '$1')); if (id) node.fills.push({ type: 'image', asset: id, kind: 'background', size, position: positions[i % positions.length], repeat: !/no-repeat/.test(repeat), area }); continue; }
            const tiled = /px/.test(size) && !/no-repeat/.test(repeat) && size.split(/\s+/).some(v => px(v) !== null && px(v) < Math.min(b.width, b.height) / 2);
            if (tiled || /^(repeating-|conic-)/.test(layer)) { note('Repeating, conic and tiled gradient backgrounds are not reproduced.'); continue; }
            const gradient = layer.startsWith('linear-gradient(') ? linearGradient(layer, b.width, b.height) : layer.startsWith('radial-gradient(') ? radialGradient(layer, b.width, b.height) : null;
            if (gradient) node.fills.push(gradient);
          }
        }
        const borders = ['Top', 'Right', 'Bottom', 'Left'].map(s => ({ width: num(cs[`border${s}Width`]), color: S.parseColor(cs[`border${s}Color`]), style: cs[`border${s}Style`] }));
        if (borders.some(x => x.width > 0 && x.color.a > 0 && x.style !== 'none' && x.style !== 'hidden')) node.borders = borders.map(x => (x.style === 'none' || x.style === 'hidden' || x.color.a === 0 ? { ...x, width: 0 } : x));
        if (cs.boxShadow && cs.boxShadow !== 'none') {
          for (const part of splitTop(cs.boxShadow)) {
            const cm = /(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8})/i.exec(part), n = (part.replace(cm ? cm[0] : '', '').match(/-?[\d.]+px/g) || []).map(num);
            const c = S.parseColor(cm ? cm[0] : cs.color);
            if (c.a > 0 && n.length >= 2 && (n[0] || n[1] || n[2] || n[3])) node.shadows.push({ inset: /\binset\b/.test(part), x: n[0], y: n[1], blur: n[2] || 0, spread: n[3] || 0, color: c });
          }
        }
        return node;
      }
      const painted = node => node.fills.length > 0 || !!node.borders || node.shadows.length > 0;
      function zOf(cs) { if (cs.position === 'static') return 0; if (cs.zIndex === 'auto') return 0.5; const z = Number.parseInt(cs.zIndex, 10) || 0; return z === 0 ? 0.5 : z; }
      function nameOf(el, tag) {
        if (tag === 'img') return (el.getAttribute('alt') || 'image').trim().slice(0, 40) || 'image';
        const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
        return (tag + (el.id ? `#${el.id}` : cls ? `.${cls}` : '')).slice(0, 48);
      }
      function contentBox(cs, b) {
        const e = edges(cs);
        return { x: b.x + e.left.border + e.left.padding, y: b.y + e.top.border + e.top.padding, width: Math.max(0, b.width - e.left.border - e.left.padding - e.right.border - e.right.padding), height: Math.max(0, b.height - e.top.border - e.top.padding - e.bottom.border - e.bottom.padding) };
      }

      /* ---- Form controls, list markers, pseudo-elements ---- */
      function controlContent(el, tag, cs, b, node) {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
          if (cs.appearance !== 'none' && cs.webkitAppearance !== 'none' && b.width > 0) {
            const size = Math.min(b.width, b.height); node.x += (b.width - size) / 2; node.y += (b.height - size) / 2; node.width = node.height = size;
            const on = el.checked, accent = { r: 0, g: 0.459, b: 1, a: 1 }, grey = { r: 0.46, g: 0.46, b: 0.46, a: 1 };
            node.radii = Array(4).fill(type === 'radio' ? Math.min(b.width, b.height) / 2 : 2);
            node.fills = [{ type: 'solid', color: on ? accent : { r: 1, g: 1, b: 1, a: 1 } }];
            node.borders = Array(4).fill({ width: 1, color: on ? accent : grey, style: 'solid' });
          }
          return;
        }
        if (tag === 'input' && ['hidden', 'file', 'range', 'color', 'image'].includes(type)) return;
        let text = tag === 'select' ? ((el.selectedOptions[0] && el.selectedOptions[0].textContent) || '').trim() : type === 'password' ? '•'.repeat(Math.min(el.value.length, 24)) : el.value || '';
        const style = textStyle(cs, '');
        if (!text && el.placeholder) { text = el.placeholder; style.color = S.parseColor(getComputedStyle(el, '::placeholder').color); }
        if (!text) return;
        const c = contentBox(cs, b), lh = lineHeight(cs), multi = tag === 'textarea', button = tag === 'input' && ['submit', 'button', 'reset'].includes(type);
        const lines = multi ? text.split('\n').slice(0, 40) : [text.replace(/\s+/g, ' ')], rtl = cs.direction === 'rtl', align = button ? 'CENTER' : alignOf(cs);
        node.clip = true;
        lines.forEach((line, i) => {
          if (!line) return;
          const width = textWidth(line, cs), x = align === 'CENTER' ? c.x + (c.width - width) / 2 : align === 'RIGHT' ? c.x + c.width - width : c.x;
          const y = multi ? c.y + i * lh : c.y + (c.height - lh) / 2;
          const t = simpleText(transformText(line, cs), cs, style, x, y, width, lh, line, { align }); t.pieces[0].rtl = rtl; node.children.push(t);
        });
      }
      function markerNode(el, cs, b) {
        if (cs.display !== 'list-item' || cs.listStyleType === 'none' || cs.listStyleImage !== 'none' || cs.listStylePosition === 'inside') return null;
        const type = cs.listStyleType; let text = '•';
        if (type === 'circle') text = '◦'; else if (type === 'square') text = '▪';
        else if (type !== 'disc') {
          const parent = el.parentElement; let n = parent && parent.localName === 'ol' ? (Number.parseInt(parent.getAttribute('start'), 10) || 1) : 1;
          for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === 'li') n++;
          if (el.hasAttribute('value')) n = Number.parseInt(el.getAttribute('value'), 10) || n;
          text = /alpha|latin/.test(type) ? String.fromCharCode((type.startsWith('upper') ? 65 : 97) + ((n - 1) % 26)) + '.' : type === 'arabic-indic' ? String(n).replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[d]) + '.' : /decimal|roman/.test(type) ? `${n}.` : '•';
        }
        const ms = getComputedStyle(el, '::marker'), style = textStyle(cs, ''); style.color = S.parseColor(ms.color); style.decoration = 'none';
        const width = textWidth(text, cs), lh = lineHeight(cs), gap = num(cs.fontSize) * (text.length > 1 ? 0.3 : 0.45), e = edges(cs);
        const x = cs.direction === 'rtl' ? b.x + b.width + gap : b.x - gap - width;
        return simpleText(text, cs, style, x, b.y + e.top.border + e.top.padding, width, lh, 'marker');
      }
      function lastRendered(el) {
        for (let n = el.lastChild; n; n = n.previousSibling) {
          if (n.nodeType === 3 && n.data.trim()) { const range = document.createRange(); range.selectNodeContents(n); const q = [...range.getClientRects()].filter(r => r.width > 0); if (q.length) return q[q.length - 1]; }
          else if (n.nodeType === 1) { const r = n.getBoundingClientRect(); if (r.width > 0 || r.height > 0) return r; }
        }
        return null;
      }
      function pseudoNode(el, which, hostCs, r) {
        const view = el.ownerDocument.defaultView, ps = view.getComputedStyle(el, which), content = ps.content;
        if (!content || content === 'none' || content === 'normal' || ps.display === 'none' || ps.visibility !== 'visible' || ps.opacity === '0') return null;
        const strings = content.match(/"((?:[^"\\]|\\.)*)"/g);
        let text = strings ? strings.map(s => s.slice(1, -1).replace(/\\([0-9a-f]{1,6})\s?/gi, (m, h) => String.fromCodePoint(Number.parseInt(h, 16))).replace(/\\(.)/g, '$1')).join('') : '';
        text = transformText(text, ps);
        const image = /url\(\s*["']?(.*?)["']?\s*\)/.exec(content);
        const e = edges(ps), padX = e.left.border + e.left.padding + e.right.border + e.right.padding, padY = e.top.border + e.top.padding + e.bottom.border + e.bottom.padding;
        const borderBox = ps.boxSizing === 'border-box', lh = lineHeight(ps), tw = text ? textWidth(text, ps) : 0;
        let w = px(ps.width), h = px(ps.height);
        w = w === null ? tw + padX : borderBox ? w : w + padX; h = h === null ? (text ? lh : 0) + padY : borderBox ? h : h + padY;
        const m = { l: num(ps.marginLeft), t: num(ps.marginTop), r: num(ps.marginRight), b: num(ps.marginBottom) }, he = edges(hostCs);
        const hc = { x: r.x + he.left.border + he.left.padding, y: r.y + he.top.border + he.top.padding, right: r.right - he.right.border - he.right.padding, bottom: r.bottom - he.bottom.border - he.bottom.padding };
        let x, y;
        if (ps.position === 'absolute' || ps.position === 'fixed') {
          let cb;
          if (ps.position === 'fixed') cb = { x: 0, y: 0, width: view.innerWidth, height: view.innerHeight };
          else { const host = hostCs.position !== 'static' ? el : (el.offsetParent || el.ownerDocument.documentElement), q = host.getBoundingClientRect(); cb = { x: q.x + host.clientLeft, y: q.y + host.clientTop, width: host.clientWidth || q.width, height: host.clientHeight || q.height }; }
          const L = px(ps.left), R = px(ps.right), T = px(ps.top), B = px(ps.bottom);
          x = L !== null ? cb.x + L + m.l : R !== null ? cb.x + cb.width - R - w - m.r : hc.x;
          y = T !== null ? cb.y + T + m.t : B !== null ? cb.y + cb.height - B - h - m.b : hc.y;
          const tm = /^matrix\(([^)]+)\)$/.exec(ps.transform || '');
          if (tm) { const v = tm[1].split(',').map(Number.parseFloat); x += v[4] || 0; y += v[5] || 0; if (v[1] || v[2]) note('Rotated, scaled or skewed elements are placed by their bounding box.'); }
        } else {
          const inline = /^inline/.test(ps.display), rtl = hostCs.direction === 'rtl', last = which === '::after' ? lastRendered(el) : null;
          if (which === '::before' || !last) { x = rtl ? hc.right - w - m.r : hc.x + m.l; y = hc.y + m.t + (inline ? Math.max(0, (lineHeight(hostCs) - h) / 2) : 0); }
          else if (inline) { x = rtl ? last.left - w - m.r : last.right + m.l; y = last.top + (last.height - h) / 2; }
          else { x = hc.x + m.l; y = last.bottom + m.t; }
        }
        if (!(w > 0.5 && h > 0.5)) return null;
        const b = box({ x, y, width: w, height: h });
        const node = frameFrom(ps, b, which, true); node.z = zOf(ps); node.opacity = ps.opacity === '' ? 1 : Number.parseFloat(ps.opacity);
        if (image) { const id = asset(image[1]); if (id) node.fills.push({ type: 'image', asset: id, kind: 'object', fit: 'contain', position: '50% 50%', area: { x: 0, y: 0, width: w, height: h } }); }
        if (text.trim()) {
          const style = textStyle(ps, ''), tx = b.x + e.left.border + e.left.padding, innerH = h - padY, ty = b.y + e.top.border + e.top.padding + (innerH - lh) / 2;
          const mt = metrics(ps), baseline = ty + (lh - (mt.ascent + mt.descent)) / 2 + mt.ascent;
          if (isIcon(text, style)) node.children.push(glyphNode(text.trim(), ps, { x: tx, y: ty, width: tw, height: lh }, baseline, 'icon'));
          else node.children.push(simpleText(text, ps, style, tx, ty, tw, lh, text));
        }
        return painted(node) || node.children.length ? node : null;
      }

      /* ---- DOM walk ---- */
      const inlineCache = new WeakMap();
      function isInline(el) {
        if (inlineCache.has(el)) return inlineCache.get(el);
        const tag = el.localName; let result = false;
        if (tag === 'br') result = true;
        else if (!REPLACED.has(tag) && !SKIP.has(tag) && !el.shadowRoot && tag !== 'slot') {
          const view = el.ownerDocument.defaultView, cs = view.getComputedStyle(el);
          if (cs.display === 'inline' && cs.visibility === 'visible' && cs.opacity === '1' && (cs.position === 'static' || cs.position === 'relative')
            && S.parseColor(cs.backgroundColor).a === 0 && cs.backgroundImage === 'none' && cs.boxShadow === 'none'
            && !['marginLeft', 'marginRight', 'paddingLeft', 'paddingRight'].some(k => Math.abs(num(cs[k])) > 0.5)
            && !['Top', 'Right', 'Bottom', 'Left'].some(s => num(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none')
            && ['::before', '::after'].every(p => { const c = view.getComputedStyle(el, p).content; return !c || c === 'none' || c === 'normal'; })) {
            result = true;
            for (const child of el.children) if (!isInline(child)) { result = false; break; }
          }
        }
        inlineCache.set(el, result); return result;
      }
      function inlineParts(el, deco, out) {
        if (el.localName === 'br') { out.push({ br: true }); return; }
        count++;
        const cs = el.ownerDocument.defaultView.getComputedStyle(el), d = `${deco} ${cs.textDecorationLine}`;
        for (const child of el.childNodes) { if (child.nodeType === 3) out.push({ node: child, cs, deco: d }); else if (child.nodeType === 1) inlineParts(child, d, out); }
      }
      function svgNode(el, cs, b, opacity) {
        let svg; try { svg = S.normalizeSvg(el, note); } catch (_) { note('An SVG graphic could not be read.'); return null; }
        if (!svg.inner) return null;
        const c = contentBox(cs, b);
        return { type: 'svg', name: nameOf(el, 'svg'), x: c.x, y: c.y, width: c.width, height: c.height, opacity, svg: { inner: svg.inner, viewBox: svg.viewBox, stretch: svg.stretch }, z: zOf(cs) };
      }
      async function walk(el, deco) {
        const tag = el.localName;
        if (SKIP.has(tag)) return null;
        const view = el.ownerDocument.defaultView; if (!view) return null;
        const cs = view.getComputedStyle(el);
        if (cs.display === 'none') return null;
        const opacity = cs.opacity === '' ? 1 : Number.parseFloat(cs.opacity);
        if (opacity === 0) return null;
        if (++count % 400 === 0) await sleep(0);
        const r = el.getBoundingClientRect(), b = box(r), visible = cs.visibility === 'visible';
        if (tag === 'svg') return visible && b.width > 0 && b.height > 0 ? svgNode(el, cs, b, opacity) : null;
        if (cs.transform !== 'none' && !/^matrix\(1, 0, 0, 1,/.test(cs.transform)) note('Rotated, scaled or skewed elements are placed by their bounding box.');
        if ((cs.filter && cs.filter !== 'none') || (cs.backdropFilter && cs.backdropFilter !== 'none')) note('CSS filters and backdrop blur are not reproduced.');
        if (cs.maskImage && cs.maskImage !== 'none' && !cs.maskImage.startsWith('url(')) note('Gradient masks are not reproduced.');
        if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') note('Blend modes are not reproduced.');
        const node = frameFrom(cs, b, nameOf(el, tag), visible);
        node.opacity = opacity; node.z = zOf(cs);
        const root = el === el.ownerDocument.documentElement || el === el.ownerDocument.body;
        node.clip = !root && (/hidden|clip|scroll|auto/.test(cs.overflowX) || /hidden|clip|scroll|auto/.test(cs.overflowY));
        const local = area => ({ x: area.x - b.x, y: area.y - b.y, width: area.width, height: area.height });
        if (tag === 'img') {
          const id = visible && b.width > 0 && b.height > 0 ? asset(el.currentSrc || el.src) : null;
          if (id) node.fills.push({ type: 'image', asset: id, kind: 'object', fit: cs.objectFit, position: cs.objectPosition, area: local(contentBox(cs, b)), natural: el.naturalWidth ? [el.naturalWidth, el.naturalHeight] : null });
          return node;
        }
        if (tag === 'canvas' || tag === 'video') {
          if (visible && b.width > 0 && b.height > 0) {
            let id = null;
            try {
              if (tag === 'canvas' && el.width && el.height) { const c = document.createElement('canvas'); c.width = el.width; c.height = el.height; c.getContext('2d').drawImage(el, 0, 0); id = inlineAsset(c, el.width, el.height); }
              else if (tag === 'video' && el.readyState >= 2 && el.videoWidth) { const s = Math.min(1, 1920 / el.videoWidth), c = document.createElement('canvas'); c.width = Math.round(el.videoWidth * s); c.height = Math.round(el.videoHeight * s); c.getContext('2d').drawImage(el, 0, 0, c.width, c.height); id = inlineAsset(c, el.videoWidth, el.videoHeight, 'image/jpeg'); }
            } catch (_) { id = null; }
            if (!id && tag === 'video' && el.poster) id = asset(el.poster);
            if (id) node.fills.push({ type: 'image', asset: id, kind: 'object', fit: tag === 'video' ? cs.objectFit : 'fill', position: cs.objectPosition, area: local(contentBox(cs, b)) });
            else note(tag === 'video' ? 'A video frame could not be captured.' : 'A protected canvas could not be captured.');
          }
          return node;
        }
        if (tag === 'input' || tag === 'textarea' || tag === 'select') { if (visible) controlContent(el, tag, cs, b, node); return node; }
        if (tag === 'iframe' || tag === 'frame') {
          let inner = null; try { inner = el.contentDocument; } catch (_) {}
          if (inner && inner.documentElement) {
            const saved = { x: off.x, y: off.y }, e = edges(cs);
            off.x += r.x + e.left.border + e.left.padding; off.y += r.y + e.top.border + e.top.padding;
            try { const child = await walk(inner.documentElement, ''); if (child) node.children.push(child); } finally { off.x = saved.x; off.y = saved.y; }
            node.clip = true;
          } else note('Content of embedded frames from other sites is not included.');
          return node;
        }
        const d = `${deco} ${cs.textDecorationLine}`;
        if (visible) { const before = pseudoNode(el, '::before', cs, r); if (before) node.children.push(before); }
        const kids = el.shadowRoot ? el.shadowRoot.childNodes : tag === 'slot' ? el.assignedNodes({ flatten: true }) : el.childNodes;
        let run = [];
        const flush = () => { if (run.length) { if (run.some(p => p.node)) node.children.push(...textFromRun(run, cs)); run = []; } };
        for (const kid of kids) {
          if (kid.nodeType === 3) { if (visible) run.push({ node: kid, cs, deco: d }); }
          else if (kid.nodeType === 1) {
            if (visible && isInline(kid)) inlineParts(kid, d, run);
            else { flush(); const child = await walk(kid, d); if (child) node.children.push(child); }
          }
        }
        flush();
        if (visible) {
          const after = pseudoNode(el, '::after', cs, r); if (after) node.children.push(after);
          const marker = markerNode(el, cs, b); if (marker) node.children.unshift(marker);
        }
        if (node.children.some(c => c.z)) node.children = node.children.map((c, i) => [c, i]).sort((a, c) => (a[0].z - c[0].z) || (a[1] - c[1])).map(p => p[0]);
        return node;
      }

      /* ---- Clean up: drop invisible layers and pointless wrappers ---- */
      const intersects = (a, c) => a.x < c.x + c.width && a.x + a.width > c.x && a.y < c.y + c.height && a.y + a.height > c.y;
      let layers = 0;
      function prune(node, clip) {
        delete node.z;
        if (node.type === 'text') { node.pieces = node.pieces.filter(p => intersects(p, clip)); if (!node.pieces.length) return null; layers++; return node; }
        if (node.type === 'svg') { if (!intersects(node, clip)) return null; layers++; return node; }
        let inner = clip;
        if (node.clip) {
          const x = Math.max(clip.x, node.x), y = Math.max(clip.y, node.y);
          inner = { x, y, width: Math.min(clip.x + clip.width, node.x + node.width) - x, height: Math.min(clip.y + clip.height, node.y + node.height) - y };
          if (!(inner.width > 1 && inner.height > 1)) return null; // screen-reader-only and collapsed content
        }
        node.children = node.children.map(child => prune(child, inner)).filter(Boolean);
        const visible = painted(node) && intersects(node, clip);
        if (!node.children.length && !visible) return null;
        if (!painted(node) && !node.clip && node.opacity === 1 && node.children.length === 1) return node.children[0];
        if (!node.children.length) node.clip = false;
        layers++; return node;
      }

      let tree = await walk(selected, '');
      if (tree) tree = prune(tree, { x: 0, y: 0, width: bounds.width, height: bounds.height });
      if (!tree) throw new Error('Nothing visible was found in the selected area.');
      let background = { r: 1, g: 1, b: 1, a: 1 };
      for (let el = mode === 'selector' ? selected.parentElement : docEl; el; el = mode === 'selector' ? el.parentElement : (el === docEl ? document.body : null)) {
        const c = S.parseColor(getComputedStyle(el).backgroundColor); if (c.a > 0.99) { background = c; break; }
      }
      note('Layers use fixed positions. Auto Layout, interactions and responsive rules are not reconstructed.');
      return { format: 'pagecraft', version: 2, title: document.title || 'Untitled page', url: location.href, capturedAt: new Date().toISOString(), width: bounds.width, height: bounds.height, viewport: { width: innerWidth, height: innerHeight }, background, tree, assets, warnings: [...warnings], elementCount: count, layerCount: layers };
    } finally {
      if (mode === 'page') scrollTo({ left: restore.x, top: restore.y, behavior: 'instant' });
    }
  }
  /* Fallback image loader: runs in the page so cookies and blob: URLs work. */
  async function pagecraftFetchImage(url) {
    try {
      const response = await fetch(url, { credentials: 'include' }); if (!response.ok) return null;
      const blob = await response.blob(); if (blob.size > 25e6) return null;
      return await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => resolve(null); reader.readAsDataURL(blob); });
    } catch (_) { return null; }
  }
  scope.captureDocument = captureDocument; scope.pagecraftFetchImage = pagecraftFetchImage;
  if (typeof module !== 'undefined') module.exports = { captureDocument };
})(typeof globalThis !== 'undefined' ? globalThis : this);
