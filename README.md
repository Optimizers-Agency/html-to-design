# Layerlift by Optimizers

A self-contained Chrome extension that turns any webpage into editable Figma layers. No account, server, credits or quota. Independent implementation; it does not use html.to.design's code, formats or services.

## Install

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `extension` folder. (If Chrome refuses the Y: drive, copy the folder to a local disk first.)
2. Pin **Layerlift by Optimizers — Web to Figma**.
3. If you had version 1 installed, press the reload icon on the extension card. Version 2 asks for access to all sites so it can download images from any CDN.

## Use

1. Open the page you want, at the browser width you want (resize the window, or use DevTools device mode for mobile).
2. Click the Layerlift toolbar icon. A small capture window opens next to the page. Keep the page itself visible.
3. Press **Capture page** (full page, visible area, or one element by CSS selector).
4. Press **Copy for Figma**, click on the Figma canvas, press **Ctrl+V**.

That is the whole workflow. It works in Figma in the browser and in the desktop app, with no plugin.

### The three ways into Figma

| Route | When | What you get |
| --- | --- | --- |
| **Copy for Figma** then Ctrl+V | Default | Named groups, editable text (one layer per line, mixed styles kept), image fills, vectors, gradients, drop shadows |
| **Download .svg**, drag onto the canvas | Very large pages where the clipboard is slow | Same as above |
| **Download for plugin** (`.layerlift.json`) | You want paragraphs as single wrapping text boxes and real frames | Needs the bundled plugin, Figma desktop app only |

**Figma cannot open `.layerlift.json` by drag-and-drop or File → Import** — that produces "File format not recognized". The file only opens through the plugin: in Figma desktop choose **Plugins → Development → Import plugin from manifest…**, pick `figma-plugin/manifest.json`, run **Layerlift Import**, and choose the file. (html.to.design works the same way: its `.h2d` files also only open through its plugin.)

### If Figma shows one flat image instead of layers

That happens when the SVG is too heavy. A long page with every photo embedded at its original resolution reached 17 MB and came in as a single picture. Images are now embedded at the size they are displayed (the **Compact** setting keeps a full page to a few megabytes), and the panel warns when a capture is over 6 MB. If it still happens, capture the page in parts with **Visible area only** or **One element**.

The panel follows the Optimizers brand: dark by default, with a light mode behind the sun/moon button (remembered between sessions).

## What is captured

- Layout exactly as rendered: boxes, backgrounds, per-corner radii, borders, opacity, clipping, z-order.
- Text as real text with font, weight, size, colour, letter spacing, underline, `text-transform`. Right-to-left text (Arabic, Hebrew) keeps its diacritics and right alignment.
- Images: `<img>` with `object-fit`/`object-position`, CSS background images with size and position, `<canvas>`, video frames or posters. Originals are embedded as PNG/JPEG; WebP/AVIF are converted. SVG image files stay vector.
- Inline SVG icons as vectors, including `<use>` sprites, `currentColor`, CSS-styled paths and shared gradients. Icons made with CSS `mask-image` and icon fonts (Font Awesome, Material Icons…) are kept too.
- Linear and radial gradients, drop and inner shadows.
- `::before` / `::after` content, list bullets and numbers, form field values and placeholders (passwords are masked).
- Lazy-loaded content: the page is scrolled top to bottom first and running animations are finished. Same-origin iframes and open shadow DOM are included.
- Hidden, off-screen and screen-reader-only content is left out, and empty wrapper elements are collapsed, so the layer list stays short.

## Fonts

Figma can only use fonts it has: Google Fonts, plus your installed fonts in the desktop app (or with Figma's font helper in the browser). The **Use Inter for system fonts** checkbox (on by default) replaces Arial, Segoe UI, Helvetica and similar with Inter, and Arabic/Hebrew system text with Noto Sans Arabic/Hebrew, so nothing is reported missing. Web fonts keep their real names. Substituted fonts have different widths, so lines can be slightly longer or shorter than on the page; turn the checkbox off if the designer has the original fonts.

## Limits

- Layers are absolutely positioned. Auto Layout, components and responsive behaviour are not reconstructed.
- Not reproduced: CSS filters and backdrop blur, blend modes, conic/repeating gradients, tiled backgrounds, shadow spread, gradient text (uses the first colour), cross-origin iframes, closed shadow DOM.
- Rotated or skewed elements are placed by their bounding box. Pseudo-elements that are flex or grid items are positioned by estimate.
- Virtualised lists only export what is mounted. Chrome's own pages and the Web Store cannot be captured; for `file://` pages enable **Allow access to file URLs** on the extension.
- Captures contain the page's visible text and images. Treat captures of private pages as private.

## Development

Plain JavaScript, no build step. Reload the extension after editing.

- `extension/serialize.js` reads the page; `shared.js` normalises SVG; `images.js` downloads and places images; `render.js` writes the Figma-flavoured SVG; `capture.js` is the panel.
- `npm test` — unit tests for the SVG exporter, image placement and the Figma plugin (with a Plugin API mock).
- `node tests/browser.cjs [url] [width]` — captures the fixture (or any URL) in real Chrome, asserts on the result, and writes the page screenshot, the SVG and its rendering to `test-results/` for comparison.
- `node tests/extension.cjs` — loads the unpacked extension in an isolated Chromium profile and drives capture, preview, copy and downloads.

The browser tests need `playwright-core`; set `PLAYWRIGHT_MODULE` to its path, and `CHROMIUM_EXECUTABLE` to a Chromium build for the extension test (branded Chrome no longer accepts `--load-extension`).

The SVG dialect in `render.js` (pattern image fills, Figma's own filter chain for shadows, `text-anchor` for RTL, `id` as layer name) was checked against Figma's real importer via `figma.createNodeFromSvg`. Change it with care.
