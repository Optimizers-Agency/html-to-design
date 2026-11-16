# Pagecraft Local

A self-contained Chrome extension and Figma importer for capturing webpages as editable design layers. No account, subscription, server, credits, or capture/import quota. This is an independent implementation, not a modified or unlocked copy of html.to.design. It does not use that product's proprietary formats or services.

## Install the Chrome extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `extension` folder in this project.
4. Pin **Pagecraft Local — Web to Design** from the extensions menu.
5. Visit a webpage and click its extension icon. A separate capture studio opens.
6. Choose **Full page**, **Current viewport**, or **CSS selector**, then click **Capture page**.
7. Download a **Figma capture** for editable text, or **SVG** for a portable design export.

No build step or npm install is required. If Chrome cannot load an extension from the Y: drive, copy the `extension` folder to a local drive and load that copy.

## Install the Figma importer

Use the Figma desktop app. Open a design file, then use **Plugins → Development → Import plugin from manifest…** and select `figma-plugin/manifest.json`. Run **Pagecraft Local Import** from the Development menu and select your `.pagecraft.json` file. The plugin creates a frame containing editable text, nested frames, border shapes, embedded images and SVG vectors. You can undo the import in Figma.

If your Figma version asks for a plugin ID, create a new local development plugin in Figma and copy the generated `id` into this project's Figma manifest. Plugin IDs are assigned by Figma; this project does not invent a published plugin ID.

Alternatively, drag an exported SVG directly onto a Figma canvas. Figma may outline text when importing SVG; the companion importer preserves text nodes. **Copy SVG markup** copies source text, not Figma's proprietary clipboard representation.

## Capture behavior

- Captures the current rendered layout at the source tab's current viewport width. Resize that browser window to capture another breakpoint.
- Full page includes the currently loaded document. Scroll the source page first to load lazy content. Virtualized lists export only mounted content, and collapsed or internally scrolled content is not expanded.
- Viewport capture clips the document to the current scroll position. CSS selector capture exports the first matching visible element.
- Text is split into browser-measured visual lines; mixed styles remain separate layers. Font matching uses installed Figma fonts with a fallback. Install the original fonts for better fidelity, especially for Arabic and other scripts.
- Images are embedded locally. **Enable images from other domains** requests optional HTTP/HTTPS access for CDN resources. Requests do not explicitly send cookies; inaccessible/authenticated images may be missing. Existing page-readable pixels are used where possible. Embedded images are resized to at most 4096 pixels on each side for Figma compatibility.
- Capture files contain visible text, source URLs and embedded images. Native form values are omitted. Treat files captured from private pages as private.
- The extension has no analytics or vendor backend. The Figma plugin has network access disabled. Once imported, layers belong to your Figma document and follow Figma's own storage behavior.

## Fidelity limits

This is a useful first version, not full parity with html.to.design. It captures measured fixed positions, not Auto Layout, components, CSS rules or interactions. Gradients, box shadows, filters, pseudo-elements, iframe content, video, closed shadow roots and native form rendering are not reconstructed. Rotations, stacking contexts, complex clipping, image positioning and CSS borders can differ. SVG references to external symbols may not resolve. Browser-native and Figma text metrics can differ. The capture studio reports known omissions.

Chrome blocks injection on internal pages, the Chrome Web Store and some protected pages. For local HTML files, enable **Allow access to file URLs** in the extension's details. Very large pages remain subject to browser memory, Chrome message transport and Figma dimension limits; there is no metered usage quota. Figma import rejects dimensions beyond 100,000 pixels with an error.

## Development and checks

`npm test` runs capture validation, image decoding, SVG escaping, editable import and rollback checks with a Figma API mock. `tests/fixture.html` is a manual/browser fixture covering wrapped and RTL text, SVG, embedded images, clipping, hidden elements and private form values. These checks do not replace a real Figma desktop import.

With Playwright available, `node tests/browser.cjs` exercises capture logic in isolated headless Chrome and tests the studio preview/download with its Chrome injection API bridged to the fixture. `node tests/extension.cjs` separately loads the production extension in isolated Chromium and checks its service worker, CSP and missing-source handling. Set `PLAYWRIGHT_MODULE` to the installed Playwright package path if needed, and `CHROMIUM_EXECUTABLE` for the extension test's Chromium binary. No personal browser profile is used.

Files are plain JavaScript, HTML and CSS. Reload the extension in `chrome://extensions` after editing it; reopen the capture studio. No remote code or runtime packages are required.

## Reference research

The original installed extension's manifest and public feature descriptions were inspected for the high-level capture/import workflow. Its executable bundles, assets, branding, license checks and backend were not reused.

- https://chromewebstore.google.com/detail/htmltodesign/ldnheaepmnmbjjjahokphckbpgciiaed
- https://developer.chrome.com/docs/extensions/reference/api/scripting
- https://developers.figma.com/docs/plugins/manifest/
- https://developers.figma.com/docs/plugins/api/TextNode/
- https://developers.figma.com/docs/plugins/api/properties/figma-createimage/
