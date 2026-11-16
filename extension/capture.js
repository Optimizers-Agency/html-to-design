const $ = id => document.getElementById(id);
const tabId = Number(new URL(location.href).searchParams.get('tab'));
let capture = null, svg = null, previewURL = null;
const buttons = ['capture', 'copy', 'svg', 'json'];
const HEAVY = 6e6; // above this, Figma tends to import the SVG as one flat image
function status(message, kind = '') { $('status').textContent = message; $('status').className = kind; }
function busy(on) { buttons.forEach(id => { $(id).disabled = on; }); }
const fileName = () => (capture.title || 'capture').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 80) || 'capture';
const size = text => text.length < 1048576 ? `${Math.max(1, Math.round(text.length / 1024))} KB` : `${(text.length / 1048576).toFixed(1)} MB`;
const budget = () => Number($('quality').value) || 3.5e6;

$('mode').addEventListener('change', () => { $('selector-field').hidden = $('mode').value !== 'selector'; });
$('inter').addEventListener('change', () => { if (capture) show(); });
$('quality').addEventListener('change', async () => {
  if (!capture) return;
  busy(true); status('Re-encoding images…');
  try { await PagecraftImages.encodeAssets(capture, budget()); PagecraftImages.finalizeCapture(capture); show(); }
  catch (error) { status((error && error.message) || String(error), 'error'); }
  finally { busy(false); }
});
if (chrome.tabs) chrome.tabs.get(tabId).then(tab => { if (tab && tab.title) $('source').textContent = tab.title; }).catch(() => {});

function show() {
  svg = renderCapture(capture, { systemFont: $('inter').checked ? 'Inter' : null });
  if (previewURL) URL.revokeObjectURL(previewURL);
  // The preview keeps the page's own fonts; the export may swap system fonts for Inter.
  previewURL = URL.createObjectURL(new Blob([renderCapture(capture, { systemFont: null })], { type: 'image/svg+xml' }));
  const preview = document.createElement('img'); preview.src = previewURL; preview.alt = `Preview of ${capture.title}`;
  $('stage').replaceChildren(preview);
  const images = capture.imageSummary || { total: 0, embedded: 0, missing: 0 };
  $('dimensions').textContent = `${Math.round(capture.width)} × ${Math.round(capture.height)} px · ${size(svg)}`;
  $('counts').textContent = `${capture.layerCount.toLocaleString()} layers · ${images.embedded}/${images.total} images`;
  const notes = [...capture.warnings];
  for (const asset of Object.values(capture.assets)) if (!asset.data && !asset.svg) notes.unshift(`Image not embedded (${asset.error || 'unavailable'}): ${asset.url.slice(0, 120)}`);
  $('warnings').replaceChildren(...notes.map(message => { const li = document.createElement('li'); li.textContent = message; return li; }));
  $('warnings-panel').hidden = !notes.length; $('warnings-title').textContent = `Capture notes (${notes.length})`;
  $('result').hidden = false;
  if (svg.length > HEAVY) status(`Captured, but the file is ${size(svg)}. Figma may import a file this heavy as one flat image. Set Images to Compact, or capture the page in parts.`, 'error');
  else if (images.missing) status(`Captured, but ${images.missing} image${images.missing === 1 ? '' : 's'} could not be downloaded (see notes).`, 'error');
  else status('Captured. Press Copy for Figma, then paste on the canvas.', 'ok');
}

$('capture').addEventListener('click', async () => {
  busy(true); capture = null;
  try {
    if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('Open a webpage, then click the Layerlift toolbar icon.');
    status('Reading the page… keep it visible and do not switch tabs.');
    await chrome.scripting.executeScript({ target: { tabId }, files: ['shared.js', 'serialize.js'] });
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: options => captureDocument(options), args: [{ mode: $('mode').value, selector: $('selector').value.trim() }] });
    const result = results && results[0] && results[0].result;
    if (!result || result.format !== 'pagecraft') throw new Error('The page did not return a capture.');
    capture = result;
    await PagecraftImages.resolveAssets(capture, tabId, (done, total) => status(`Embedding images… ${done}/${total}`), budget());
    show();
  } catch (error) {
    const message = (error && error.message) || String(error);
    status(/Cannot access|chrome:\/\/|extensions gallery|No tab with id|Frame with ID/i.test(message)
      ? 'This page cannot be captured. Chrome blocks extensions on its own pages and the Web Store; if the tab was closed, click the toolbar icon again on the page you want. For local files, enable “Allow access to file URLs” in the extension settings.'
      : message, 'error');
  } finally { busy(false); if (!capture) ['copy', 'svg', 'json'].forEach(id => { $(id).disabled = true; }); }
});

function download(content, extension, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = `${fileName()}.${extension}`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
$('svg').addEventListener('click', () => { download(svg, 'svg', 'image/svg+xml'); status('SVG saved. Drag the file onto the Figma canvas.', 'ok'); });
$('json').addEventListener('click', () => { download(JSON.stringify(capture), 'layerlift.json', 'application/json'); status('Saved. Open it with the Layerlift Import plugin in Figma desktop — Figma cannot open this file by drag-and-drop.', 'ok'); });
$('copy').addEventListener('click', async () => {
  try {
    window.focus(); await navigator.clipboard.writeText(svg);
    status(svg.length > HEAVY ? `Copied (${size(svg)}). This is heavy — if Figma pastes one flat image, set Images to Compact or capture in parts.` : 'Copied. Click the Figma canvas and press Ctrl+V.', 'ok');
  } catch (_) { status('Clipboard was blocked. Use Download .svg and drag the file onto the Figma canvas.', 'error'); }
});
