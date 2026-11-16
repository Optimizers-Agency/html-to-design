// Loads the production manifest in isolated Chromium. Successful page capture is
// tested in browser.cjs; activeTab still needs a real toolbar invocation by a user.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
(async()=>{
  const extension=path.resolve(__dirname,'../extension');
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'pagecraft-extension-'));
  const executablePath=process.env.CHROMIUM_EXECUTABLE || path.join(process.env.LOCALAPPDATA,'ms-playwright/chromium-1217/chrome-win64/chrome.exe');
  let context;
  try {
    context=await chromium.launchPersistentContext(profile,{executablePath,headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker',{timeout:15000});
    const manifest=await worker.evaluate(()=>chrome.runtime.getManifest());
    assert.equal(manifest.name,'Pagecraft Local — Web to Design');assert.deepEqual(manifest.permissions,['activeTab','scripting']);
    const id=new URL(worker.url()).host;
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`chrome-extension://${id}/capture.html`);
    await page.getByRole('button',{name:/Capture page/}).click();
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('click the Pagecraft extension icon'));
    assert.equal(await page.locator('#json').isDisabled(),true);assert.deepEqual(errors,[]);
    console.log('PASS: production manifest loads, service worker runs, capture UI passes Chrome CSP, missing source tab is handled.');
  } finally {if(context)await context.close(); /* Temporary isolated profile retained for diagnostics. */}
})().catch(error=>{console.error(error);process.exitCode=1;});
