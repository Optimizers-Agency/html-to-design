const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { renderCapture } = require('../extension/render.js');
const transparent = { r:0,g:0,b:0,a:0 };
function frame(children = []) { return { type:'frame',name:'test',x:0,y:0,width:200,height:100,fill:{...transparent},radii:[0,0,0,0],borders:Array.from({length:4},()=>({width:0,color:{...transparent},style:'none'})),children }; }
function capture(tree = frame()) { return { format:'pagecraft',version:1,width:200,height:100,title:'Test <&>',tree,assets:{} }; }
function harness() {
  const all = [], messages = [], page = { selection:[], children:[] };
  function create(type) {
    const n = { type, children:[], fills:[], resize(w,h){assert.ok(w > 0 && h > 0);this.width=w;this.height=h;},appendChild(c){this.children.push(c);},setPluginData(){},remove(){this.removed=true;} };
    all.push(n); return n;
  }
  const figma = { showUI(){},ui:{postMessage:m=>messages.push(m)},listAvailableFontsAsync:async()=>[{fontName:{family:'Inter',style:'Regular'}}],loadFontAsync:async()=>{},createFrame:()=>create('FRAME'),createText:()=>create('TEXT'),createRectangle:()=>create('RECTANGLE'),createNodeFromSvg:()=>create('SVG'),createImage:()=>({hash:'image'}),currentPage:page,viewport:{center:{x:0,y:0},scrollAndZoomIntoView(){}},notify(){} };
  const context = { figma,__html__:'',module:{exports:{}},Uint8Array,setTimeout,console };
  vm.runInNewContext(fs.readFileSync(require.resolve('../figma-plugin/code.js'),'utf8'),context);
  return { api:context.module.exports, figma, all, messages };
}
test('rejects non-captures and invalid geometry before mutating Figma', () => {
  const h = harness(); assert.throws(()=>h.api.validateCapture({}));
  const bad=capture();bad.tree.x=NaN;assert.throws(()=>h.api.validateCapture(bad));
  const invalid=capture();invalid.tree.fill.r=4;assert.throws(()=>h.api.validateCapture(invalid));
  assert.equal(h.all.length,0);
});
test('decodes PNG bytes without browser globals', () => { const h=harness();assert.deepEqual([...h.api.decodeImage('data:image/png;base64,AQIDBA==')],[1,2,3,4]);assert.throws(()=>h.api.decodeImage('https://example.com/a.png')); });
test('imports editable text and a vector into one selected frame', async () => {
  const h=harness(),tree=frame([{type:'text',name:'Hello',text:'Hello',x:4,y:5,width:80,height:20,color:{r:0,g:0,b:0,a:1},fontFamily:'Arial',fontSize:16,fontWeight:400,letterSpacing:0,direction:'ltr'},{type:'svg',name:'Vector',x:90,y:0,width:20,height:20,svg:'<svg xmlns="http://www.w3.org/2000/svg"/>',opacity:1}]);
  await h.api.importCapture(capture(tree));
  assert.equal(h.all.filter(n=>n.type==='TEXT')[0].characters,'Hello');assert.equal(h.all.filter(n=>n.type==='SVG').length,1);assert.equal(h.figma.currentPage.selection.length,1);assert.equal(h.messages.at(-1).type,'done');
});
test('rolls back the frame on an import failure', async () => {
  const h=harness();h.figma.createText=()=>{throw new Error('simulated Figma failure');};
  const data=capture(frame([{type:'text',name:'a',text:'a',x:0,y:0,width:10,height:10,color:{r:0,g:0,b:0,a:1},fontFamily:'Inter',fontSize:10,fontWeight:400,letterSpacing:0}]));
  await assert.rejects(h.api.importCapture(data),/simulated/);assert.equal(h.all[0].removed,true);
});
test('SVG export escapes page text and excludes unembedded remote assets', () => {
  const tree=frame([{type:'text',text:'<script>&"',x:0,y:0,width:50,height:20,fontSize:16,fontWeight:400,fontFamily:'Arial',color:{r:0,g:0,b:0,a:1},letterSpacing:0,direction:'ltr'}]);tree.image='missing';
  const data=capture(tree);data.assets.missing={url:'https://example.com/track'};
  const svg=renderCapture(data);assert.match(svg,/&lt;script&gt;&amp;&quot;/);assert.ok(!svg.includes('https://example.com'));assert.ok(!svg.includes('<script>'));assert.match(svg,/clipPath/);
});
