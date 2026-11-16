const $ = id => document.getElementById(id);
let capture = null, svg = null, previewURL = null;
const tabId = Number(new URL(location.href).searchParams.get('tab'));
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
$('mode').addEventListener('change', () => { $('selector-field').hidden = $('mode').value !== 'selector'; });
$('images').addEventListener('click', async () => {
  try {
    const granted = await chrome.permissions.request({ origins: ['http://*/*','https://*/*'] });
    status(granted ? 'Image access enabled. Capture again to embed images from other domains.' : 'Permission not granted. Same-origin images will still be captured where available.');
  } catch (error) { status(error.message, true); }
});
async function embedAsset(asset) {
  if (asset.data) return;
  if (!/^(https?:|data:image\/|blob:)/i.test(asset.url)) throw new Error('Unsupported image URL');
  const response = await fetch(asset.url, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Image returned HTTP ${response.status}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image(); image.src = url; await image.decode();
    const scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    asset.data = canvas.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}
$('capture').addEventListener('click', async () => {
  $('capture').disabled = true; ['json','svg','copy'].forEach(id => $(id).disabled = true);
  try {
    if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('Open a webpage, then click the Pagecraft extension icon.');
    status('Reading page layout and text… Keep this capture tab open.');
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: captureDocument, args: [{ mode: $('mode').value, selector: $('selector').value }] });
    capture = results[0]?.result;
    if (!capture || capture.format !== 'pagecraft') throw new Error('The page did not return a capture. Check the selector, then try again.');
    const assets = Object.values(capture.assets); let processed = 0;
    await Promise.all(Array.from({ length: Math.min(4, assets.length) }, async (_, worker) => {
      for (let i = worker; i < assets.length; i += 4) {
        try { await embedAsset(assets[i]); }
        catch (_) { capture.warnings.push(`Image could not be embedded: ${assets[i].url.slice(0,160)}. Enable image access, or check that the image is loaded.`); }
        status(`Embedding images… ${++processed}/${assets.length}`);
      }
    }));
    svg = renderCapture(capture);
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const preview = document.createElement('img'); preview.src = previewURL; preview.alt = `Capture of ${capture.title}`;
    $('stage').replaceChildren(preview); $('title').textContent = capture.title;
    $('dimensions').textContent = `${Math.round(capture.width)} × ${Math.round(capture.height)} PX`;
    $('warnings').replaceChildren(...capture.warnings.map(message => { const li = document.createElement('li'); li.textContent = message; return li; }));
    $('warnings-panel').hidden = !capture.warnings.length; $('warnings-title').textContent = `Capture notes (${capture.warnings.length})`;
    status(`Captured ${capture.elementCount.toLocaleString()} elements. Ready to export.`);
    ['json','svg','copy'].forEach(id => $(id).disabled = false);
  } catch (error) {
    status(`${error.message} Chrome internal pages, the Web Store, and some protected pages cannot be captured. For file:// pages, enable file access in the extension settings.`, true);
  } finally { $('capture').disabled = false; }
});
function download(content, extension, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = `${(capture.title || 'capture').replace(/[^\p{L}\p{N} _-]/gu,'').slice(0,90) || 'capture'}.${extension}`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
$('json').addEventListener('click', () => download(JSON.stringify(capture), 'pagecraft.json', 'application/json'));
$('svg').addEventListener('click', () => download(svg, 'svg', 'image/svg+xml'));
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(svg); status('SVG markup copied. For Figma, download the SVG or use the importer.'); }
  catch (_) { status('Clipboard access unavailable. Download the SVG instead.', true); }
});
