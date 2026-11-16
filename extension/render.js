(function (scope) {
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' })[ch]);
  const rgb = c => `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
  function renderCapture(data) {
    let sequence = 0; const definitions = [];
    function render(node) {
      const { width: w, height: h } = node;
      const transform = `translate(${node.x} ${node.y})`;
      if (node.type === 'text') return `<text x="${node.direction === 'rtl' ? w : 0}" y="${Math.min(h * .81, node.fontSize)}" transform="${transform}" fill="${rgb(node.color)}" fill-opacity="${node.color.a}" font-family="${escape(node.fontFamily)}" font-size="${node.fontSize}" font-weight="${node.fontWeight}" font-style="${node.italic ? 'italic' : 'normal'}" letter-spacing="${node.letterSpacing}" direction="${node.direction}" unicode-bidi="plaintext" text-decoration="${escape(node.decoration || 'none')}" xml:space="preserve">${escape(node.text)}</text>`;
      if (node.type === 'svg') return `<image transform="${transform}" width="${w}" height="${h}" opacity="${node.opacity}" href="data:image/svg+xml,${escape(encodeURIComponent(node.svg))}"/>`;
      const radii = (node.radii || [0,0,0,0]).map(r => Math.min(r, w / 2, h / 2));
      const [tl,tr,br,bl] = radii;
      const shape = `M ${tl} 0 H ${w-tr} Q ${w} 0 ${w} ${tr} V ${h-br} Q ${w} ${h} ${w-br} ${h} H ${bl} Q 0 ${h} 0 ${h-bl} V ${tl} Q 0 0 ${tl} 0 Z`;
      const id = `clip-${++sequence}`; definitions.push(`<clipPath id="${id}"><path d="${shape}"/></clipPath>`);
      let content = node.fill && node.fill.a ? `<path d="${shape}" fill="${rgb(node.fill)}" fill-opacity="${node.fill.a}"/>` : '';
      const img = data.assets[node.image];
      if (img && img.data) content += `<image width="${w}" height="${h}" href="${escape(img.data)}" preserveAspectRatio="${node.imageFit === 'FIT' ? 'xMidYMid meet' : 'xMidYMid slice'}" clip-path="url(#${id})"/>`;
      const borders = node.borders || [];
      const uniformBorder = borders.length === 4 && borders.every(b => JSON.stringify(b) === JSON.stringify(borders[0]));
      if (uniformBorder && borders[0].width && borders[0].style !== 'none' && borders[0].color.a) {
        const b = borders[0];
        content += `<path d="${shape}" fill="none" stroke="${rgb(b.color)}" stroke-opacity="${b.color.a}" stroke-width="${b.width * 2}" clip-path="url(#${id})"/>`;
      }
      (uniformBorder ? [] : borders).forEach((b,i) => {
        if (!b.width || b.style === 'none' || !b.color.a) return;
        const points = [[0,b.width/2,w,b.width/2],[w-b.width/2,0,w-b.width/2,h],[0,h-b.width/2,w,h-b.width/2],[b.width/2,0,b.width/2,h]][i];
        content += `<line x1="${points[0]}" y1="${points[1]}" x2="${points[2]}" y2="${points[3]}" stroke="${rgb(b.color)}" stroke-opacity="${b.color.a}" stroke-width="${b.width}"${b.style === 'dashed' || b.style === 'dotted' ? ` stroke-dasharray="${b.width * (b.style === 'dotted' ? 1 : 3)} ${b.width * 2}"` : ''} clip-path="url(#${id})"/>`;
      });
      const children = (node.children || []).map(render).join('');
      content += node.clip ? `<g clip-path="url(#${id})">${children}</g>` : children;
      return `<g transform="${transform}" opacity="${node.opacity ?? 1}">${content}</g>`;
    }
    const body = render(data.tree);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${data.width}" height="${data.height}" viewBox="0 0 ${data.width} ${data.height}"><title>${escape(data.title)}</title><defs>${definitions.join('')}</defs><rect width="100%" height="100%" fill="white"/>${body}</svg>`;
  }
  scope.renderCapture = renderCapture;
  if (typeof module !== 'undefined') module.exports = { renderCapture };
})(typeof globalThis !== 'undefined' ? globalThis : this);
