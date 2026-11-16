/* Opens the capture panel in its own small window so the page being captured
   stays visible (hidden tabs do not lazy-load images or run scroll effects). */
chrome.action.onClicked.addListener(async tab => {
  if (!tab.id) return;
  const width = 440, height = 780;
  let left, top;
  try { const win = await chrome.windows.get(tab.windowId); left = Math.max(0, (win.left || 0) + (win.width || 1200) - width - 24); top = Math.max(0, (win.top || 0) + 80); } catch (_) {}
  await chrome.windows.create({ url: chrome.runtime.getURL(`capture.html?tab=${tab.id}`), type: 'popup', width, height, left, top });
});
