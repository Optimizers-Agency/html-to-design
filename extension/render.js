/* Turns a capture into an SVG written the way Figma itself writes SVG, so that
   Figma's importer rebuilds real layers: editable text, image fills, gradients,
   drop shadows and named groups. Verified against figma.createNodeFromSvg. */
(function (scope) {
  const S = scope.PagecraftShared || (typeof require !== 'undefined' ? require('./shared.js') : null);
  const esc = value => String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const n = v => Math.round(v * 100) / 100;
  const HARD = '<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>';
  const NEUTRAL = /^[\s\d.,:;!?()\[\]{}«»"'\-–—/\\%+*=<>|#@&،؛؟٪]/;

  function renderCapture(data, options = {}) {
    const systemFont = options.systemFont === undefined ? 'Inter' : options.systemFont;
    const defs = [], images = new Set(); let sequence = 0;
    const paintAttr = (c, name = 'fill') => `${name}="${S.hex(c)}"${c.a < 1 ? ` ${name}-opacity="${n(c.a)}"` : ''}`;
    function shape(x, y, w, h, radii, attrs) {
      const r = radii.map(v => Math.max(0, Math.min(v, w / 2, h / 2)));
      if (r.every(v => Math.abs(v - r[0]) < 0.01)) return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"${r[0] ? ` rx="${n(r[0])}"` : ''} ${attrs}/>`;
      const [tl, tr, br, bl] = r, arc = (rad, ex, ey) => rad ? `A${n(rad)} ${n(rad)} 0 0 1 ${n(ex)} ${n(ey)}` : `L${n(ex)} ${n(ey)}`;
      return `<path d="M${n(x + tl)} ${n(y)}H${n(x + w - tr)}${arc(tr, x + w, y + tr)}V${n(y + h - br)}${arc(br, x + w - br, y + h)}H${n(x + bl)}${arc(bl, x, y + h - bl)}V${n(y + tl)}${arc(tl, x + tl, y)}Z" ${attrs}/>`;
    }
    const stops = list => list.map(s => `<stop offset="${n(s.offset)}" stop-color="${S.hex(s.color)}"${s.color.a < 1 ? ` stop-opacity="${n(s.color.a)}"` : ''}/>`).join('');
    function shadowFilter(node) {
      const id = `shadow${++sequence}`, outer = node.shadows.filter(s => !s.inset).reverse(), inner = node.shadows.filter(s => s.inset).reverse();
      let pad = 0; for (const s of outer) pad = Math.max(pad, Math.abs(s.x) + s.blur + Math.max(0, s.spread), Math.abs(s.y) + s.blur + Math.max(0, s.spread));
      const matrix = c => `<feColorMatrix type="matrix" values="0 0 0 0 ${n(c.r)} 0 0 0 0 ${n(c.g)} 0 0 0 0 ${n(c.b)} 0 0 0 ${n(c.a)} 0"/>`;
      let body = '<feFlood flood-opacity="0" result="BackgroundImageFix"/>', previous = 'BackgroundImageFix', index = 0;
      for (const s of outer) {
        const result = `effect${++index}_dropShadow`;
        body += `${HARD}<feOffset dx="${n(s.x)}" dy="${n(s.y)}"/><feGaussianBlur stdDeviation="${n(s.blur / 2)}"/>${matrix(s.color)}<feBlend mode="normal" in2="${previous}" result="${result}"/>`;
        previous = result;
      }
      body += `<feBlend mode="normal" in="SourceGraphic" in2="${previous}" result="shape"/>`; previous = 'shape';
      for (const s of inner) {
        const result = `effect${++index}_innerShadow`;
        body += `${HARD}<feOffset dx="${n(s.x)}" dy="${n(s.y)}"/><feGaussianBlur stdDeviation="${n(s.blur / 2)}"/><feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>${matrix(s.color)}<feBlend mode="normal" in2="${previous}" result="${result}"/>`;
        previous = result;
      }
      defs.push(`<filter id="${id}" x="${n(node.x - pad)}" y="${n(node.y - pad)}" width="${n(node.width + pad * 2)}" height="${n(node.height + pad * 2)}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">${body}</filter>`);
      return id;
    }
    function clipFor(node) {
      const id = `clip${++sequence}`;
      defs.push(`<clipPath id="${id}">${shape(node.x, node.y, node.width, node.height, node.radii, '')}</clipPath>`);
      return id;
    }
    function styleAttrs(s, value) {
      // Inter has no Arabic or Hebrew glyphs; use fonts Figma always ships instead.
      const family = s.system && systemFont ? (/[\u0600-\u06FF\u0750-\u077F]/.test(value) ? 'Noto Sans Arabic' : /[\u0590-\u05FF]/.test(value) ? 'Noto Sans Hebrew' : systemFont) : s.fontFamily;
      return `font-family="${esc(family)}" font-size="${n(s.fontSize)}" font-weight="${s.fontWeight}"${s.italic ? ' font-style="italic"' : ''}${s.letterSpacing ? ` letter-spacing="${n(s.letterSpacing)}"` : ''}${s.decoration && s.decoration !== 'none' ? ` text-decoration="${s.decoration}"` : ''} ${paintAttr(s.color)}`;
    }
    function text(node) {
      // Pieces that share a line become one editable text layer with styled spans.
      const lines = [];
      for (const p of node.pieces) {
        const mid = p.y + p.height / 2, last = lines[lines.length - 1], prev = last && last.pieces[last.pieces.length - 1];
        // In a right-to-left line the next piece continues to the left of the previous one.
        const joins = prev && last.rtl === p.rtl && Math.abs(last.mid - mid) < p.height * 0.5 && Math.abs(p.rtl ? p.x + p.width - prev.x : p.x - (prev.x + prev.width)) < 2;
        if (joins) last.pieces.push(p); else lines.push({ mid, rtl: p.rtl, pieces: [p] });
      }
      return lines.map(line => {
        const seg = p => node.segments[p.s] || node.segments[0];
        if (line.pieces.length > 1) {
          const sorted = line.pieces, first = sorted[0], x = line.rtl ? Math.max(...sorted.map(p => p.x + p.width)) : first.x;
          return `<text x="${n(x)}" y="${n(first.baseline)}"${line.rtl ? ' text-anchor="end"' : ''} ${styleAttrs(seg(first), first.text)} xml:space="preserve">${sorted.map(p => `<tspan ${styleAttrs(seg(p), p.text)}>${esc(p.text)}</tspan>`).join('')}</text>`;
        }
        const p = line.pieces[0]; let value = p.text;
        if (p.rtl && /[\u0590-\u08FF]/.test(value)) { if (NEUTRAL.test(value)) value = '\u200F' + value; if (NEUTRAL.test(value.slice(-1))) value += '\u200F'; }
        return `<text x="${n(p.rtl ? p.x + p.width : p.x)}" y="${n(p.baseline)}"${p.rtl ? ' text-anchor="end"' : ''} ${styleAttrs(seg(p), value)} xml:space="preserve">${esc(value)}</text>`;
      }).join('');
    }
    /* Only mask when something really sticks out of a clipping box; masks clutter Figma layers. */
    function extent(node) {
      if (node.type !== 'frame') return node.type === 'text' ? node.pieces.reduce((e, p) => [Math.min(e[0], p.x), Math.min(e[1], p.y), Math.max(e[2], p.x + p.width), Math.max(e[3], p.y + p.height)], [Infinity, Infinity, -Infinity, -Infinity]) : [node.x, node.y, node.x + node.width, node.y + node.height];
      let e = [node.x, node.y, node.x + node.width, node.y + node.height];
      if (!node.clip) for (const child of node.children) { const c = extent(child); e = [Math.min(e[0], c[0]), Math.min(e[1], c[1]), Math.max(e[2], c[2]), Math.max(e[3], c[3])]; }
      return e;
    }
    function needsClip(node) {
      if (!node.clip) return false;
      return node.children.some(child => { const c = extent(child); return c[0] < node.x - 0.5 || c[1] < node.y - 0.5 || c[2] > node.x + node.width + 0.5 || c[3] > node.y + node.height + 0.5; });
    }
    function frame(node) {
      const parts = [], { x, y, width: w, height: h } = node, sized = w > 0 && h > 0;
      let filter = sized && node.shadows.length ? ` filter="url(#${shadowFilter(node)})"` : '';
      if (sized) for (const fill of node.fills) {
        if (fill.type === 'solid') parts.push(shape(x, y, w, h, node.radii, paintAttr(fill.color) + filter));
        else if (fill.type === 'linear') {
          const id = `paint${++sequence}`;
          defs.push(`<linearGradient id="${id}" x1="${n(x + fill.x1)}" y1="${n(y + fill.y1)}" x2="${n(x + fill.x2)}" y2="${n(y + fill.y2)}" gradientUnits="userSpaceOnUse">${stops(fill.stops)}</linearGradient>`);
          parts.push(shape(x, y, w, h, node.radii, `fill="url(#${id})"${filter}`));
        } else if (fill.type === 'radial') {
          const id = `paint${++sequence}`;
          defs.push(`<radialGradient id="${id}" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(${n(x + fill.cx)} ${n(y + fill.cy)}) scale(${n(fill.rx)} ${n(fill.ry)})">${stops(fill.stops)}</radialGradient>`);
          parts.push(shape(x, y, w, h, node.radii, `fill="url(#${id})"${filter}`));
        } else if (fill.type === 'image' && !fill.missing && fill.rect) {
          const asset = data.assets[fill.asset], r = fill.rect;
          if (asset.svg) {
            const inner = fill.tint ? asset.svg.inner.replace(/(fill|stroke)="#[0-9a-f]{6}"/gi, `$1="${fill.tint}"`) : asset.svg.inner;
            const vector = `<g transform="${S.svgTransform(asset.svg, x + r.x, y + r.y, r.width, r.height)}">${inner}</g>`;
            parts.push(fill.mode === 'fit' ? vector : `<g clip-path="url(#${clipFor(node)})">${vector}</g>`);
          } else if (asset.data && asset.pw && asset.ph) {
            if (!images.has(fill.asset)) { images.add(fill.asset); defs.push(`<image id="image_${fill.asset}" width="${asset.pw}" height="${asset.ph}" preserveAspectRatio="none" xlink:href="${esc(asset.data)}"/>`); }
            const id = `pattern${++sequence}`, m = [r.width / asset.pw / w, r.height / asset.ph / h, r.x / w, r.y / h].map(v => Math.round(v * 1e7) / 1e7);
            defs.push(`<pattern id="${id}" patternContentUnits="objectBoundingBox" width="1" height="1"><use xlink:href="#image_${fill.asset}" transform="matrix(${m[0]} 0 0 ${m[1]} ${m[2]} ${m[3]})"/></pattern>`);
            parts.push(shape(x, y, w, h, node.radii, `fill="url(#${id})"${filter}`));
          } else continue;
        } else continue;
        filter = '';
      }
      const b = node.borders;
      if (sized && b) {
        const same = b.every(s => s.width === b[0].width && s.style === b[0].style && S.hex(s.color) === S.hex(b[0].color) && s.color.a === b[0].color.a);
        if (same && b[0].width > 0) {
          const bw = Math.min(b[0].width, w / 2, h / 2), dash = b[0].style === 'dashed' ? ` stroke-dasharray="${n(bw * 3)} ${n(bw * 2)}"` : b[0].style === 'dotted' ? ` stroke-dasharray="${n(bw)} ${n(bw)}"` : '';
          parts.push(shape(x + bw / 2, y + bw / 2, w - bw, h - bw, node.radii.map(r => Math.max(0, r - bw / 2)), `fill="none" ${paintAttr(b[0].color, 'stroke')} stroke-width="${n(bw)}"${dash}`));
        } else {
          const rounded = node.radii.some(r => r > 0.5) ? ` clip-path="url(#${clipFor(node)})"` : '';
          b.forEach((s, i) => {
            if (!(s.width > 0)) return;
            const bw = Math.min(s.width, i % 2 ? w : h), rect = [[x, y, w, bw], [x + w - bw, y, bw, h], [x, y + h - bw, w, bw], [x, y, bw, h]][i];
            parts.push(`<rect x="${n(rect[0])}" y="${n(rect[1])}" width="${n(rect[2])}" height="${n(rect[3])}" ${paintAttr(s.color)}${rounded}/>`);
          });
        }
      }
      const children = node.children.map(render).join('');
      if (children) parts.push(sized && needsClip(node) ? `<g clip-path="url(#${clipFor(node)})">${children}</g>` : children);
      if (!parts.length) return '';
      const id = ` id="${esc(node.name || 'layer')}"`, opacity = node.opacity < 1 ? ` opacity="${n(node.opacity)}"` : '';
      if (parts.length === 1 && !children && !opacity) return parts[0].replace(/^<(\w+)/, `<$1${id}`);
      return `<g${id}${opacity}>${parts.join('')}</g>`;
    }
    function render(node) {
      if (node.type === 'text') return text(node);
      if (node.type === 'svg') return `<g id="${esc(node.name || 'vector')}"${node.opacity < 1 ? ` opacity="${n(node.opacity)}"` : ''} transform="${S.svgTransform(node.svg, node.x, node.y, node.width, node.height)}">${node.svg.inner}</g>`;
      return frame(node);
    }
    const body = render(data.tree), W = n(data.width), H = n(data.height);
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect id="Background" width="${W}" height="${H}" fill="${S.hex(data.background || { r: 1, g: 1, b: 1 })}"/>${body}<defs>${defs.join('')}</defs></svg>`;
  }
  scope.renderCapture = renderCapture;
  if (typeof module !== 'undefined') module.exports = { renderCapture };
})(typeof globalThis !== 'undefined' ? globalThis : this);
