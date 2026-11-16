const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { captureDocument } = require('../extension/serialize.js');
const { renderCapture } = require('../extension/render.js');
const root = path.resolve(__dirname,'..');
(async () => {
  const server = http.createServer(async (req,res) => {
    try {
      const target=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
      if (!target.startsWith(root+path.sep)) {res.writeHead(403);res.end();return;}
      res.setHeader('Content-Type',target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':'text/html');
      res.end(await fs.readFile(target));
    } catch (_) {res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true,channel:'chrome'});
    const context=await browser.newContext({viewport:{width:1280,height:800},acceptDownloads:true});
    const page=await context.newPage(); const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(base+'/tests/fixture.html');
    const full=await page.evaluate(captureDocument,{mode:'page'});
    const flatten=n=>[n,...(n.children||[]).flatMap(flatten)]; const nodes=flatten(full.tree);
    assert.ok(full.height>1200);assert.ok(nodes.some(n=>n.type==='svg'));assert.ok(nodes.some(n=>n.type==='text'&&n.direction==='rtl'));
    assert.ok(nodes.filter(n=>n.type==='text').length>12);assert.ok(nodes.some(n=>n.clip));
    assert.ok(!JSON.stringify(full).includes('SHOULD NOT EXPORT'));assert.ok(!JSON.stringify(full).includes('PRIVATE FORM VALUE'));
    assert.ok(Object.values(full.assets).some(a=>a.data&&a.data.startsWith('data:image/png')));
    await page.evaluate(()=>scrollTo(0,600));
    const viewport=await page.evaluate(captureDocument,{mode:'viewport'});assert.equal(viewport.height,800);assert.ok(viewport.tree.y<0);
    const selection=await page.evaluate(captureDocument,{mode:'selector',selector:'.card'});assert.equal(selection.tree.x,0);assert.equal(selection.tree.y,0);assert.ok(selection.width<600);
    await assert.rejects(page.evaluate(captureDocument,{mode:'selector',selector:'.does-not-exist'}),/No element/);
    const pluginContext={figma:{showUI(){},ui:{}},__html__:'',module:{exports:{}},Uint8Array};
    vm.runInNewContext(await fs.readFile(path.join(root,'figma-plugin/code.js'),'utf8'),pluginContext);
    assert.ok(pluginContext.module.exports.validateCapture(full)>20);
    const exported=renderCapture(full);assert.ok(exported.includes('&amp;'));
    await fs.mkdir(path.join(root,'test-results'),{recursive:true});
    await fs.writeFile(path.join(root,'test-results/fixture.pagecraft.json'),JSON.stringify(full));
    await fs.writeFile(path.join(root,'test-results/fixture.svg'),exported);
    const studio=await context.newPage(); const errors=[];studio.on('pageerror',e=>errors.push(e.message));
    await studio.exposeFunction('captureFixture',async options=>[{result:await page.evaluate(captureDocument,options)}]);
    await studio.addInitScript(()=>{window.chrome={scripting:{executeScript:args=>window.captureFixture(args.args[0])},permissions:{request:async()=>false}};});
    await studio.goto(base+'/extension/capture.html?tab=1');await studio.getByRole('button',{name:/Capture page/}).click();
    await studio.waitForFunction(()=>document.getElementById('status').textContent.includes('Ready to export'));
    await studio.locator('#stage img').evaluate(img=>img.decode());
    const downloadPromise=studio.waitForEvent('download');await studio.locator('#json').click();const download=await downloadPromise;
    const downloaded=JSON.parse(await fs.readFile(await download.path(),'utf8'));assert.equal(downloaded.format,'pagecraft');
    await studio.screenshot({path:path.join(root,'test-results/studio.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({status:'passed',browser:'Chrome headless, isolated profile',elements:full.elementCount,layers:nodes.length,images:Object.keys(full.assets).length,dimensions:[full.width,full.height],checks:['full page','viewport after scroll','selector','missing selector','RTL text','wrapped text','hidden/form content omitted','embedded image','SVG','clipping','Figma schema validation','studio capture + preview','JSON download','no page errors']},null,2));
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
