import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Original synthetic text only. A supplied private note is copied to the
// disposable vault at runtime, never checked into the repository.
export function readingFixture(vault) {
 const paragraph = 'این یک متن آزمایشی فارسی برای بررسی حرکت صفحه است. Reading a mixed direction paragraph with `ObjectName` and **bold text** should keep its position. '.repeat(5);
 const section = n => `## Section ${n}\n\n${Array.from({length:6},(_,i)=>`${n}.${i} ${paragraph}\n`).join('\n')}\n![[scroll-image-${n}.png]]\n\n\`\`\`cpp\n${Array.from({length:45},(_,i)=>`unsigned value_${i} = ${i};`).join('\n')}\n\`\`\`\n\n![[missing-scroll-image.png]]\n\n`;
 const multiline = '![Multiline image caption\nادامهٔ توضیح](tall-scroll.svg)\n\n[Multiline destination](\ntall-scroll.svg)\n\n';
 const text = process.env.NOTEZ_SCROLL_FILE ? readFileSync(process.env.NOTEZ_SCROLL_FILE,'utf8') : '::: {align=justify}\n![[tall-scroll.svg]]\n\n'+Array.from({length:4},(_,i)=>section(i)).join(multiline)+'::: \n';
 writeFileSync(path.join(vault,'Reading.md'),text);
 if(!process.env.NOTEZ_SCROLL_FILE)writeFileSync(path.join(vault,'tall-scroll.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="1200"><rect width="300" height="1200" fill="#6c5ce7"/></svg>');
 if(!process.env.NOTEZ_SCROLL_FILE || process.env.NOTEZ_SCROLL_IMAGES==='1') {
  for(const m of text.matchAll(/!\[\[([^\]\n]+\.png)\]\]/g)) {
   // Never allow a source note to write outside the disposable vault.
   if(path.basename(m[1])===m[1] && (process.env.NOTEZ_SCROLL_IMAGES==='1'||m[1].startsWith('scroll-image-')))writeFileSync(path.join(vault,m[1]),readFileSync('build/icon.png'));
  }
 }
 return text;
}

export async function checkReading({evaluate,rpc,sleep,scratch,vault,original}) {
 const mode=process.env.NOTEZ_READING_MODE==='source'?'source':'live';
 await evaluate(`(async()=>{const {s}=window.test;s.setRightTab('core.outline.pane');await s.openNote('Reading.md');s.setPrefs('editorMode',${JSON.stringify(mode)})})()`);
 if(process.env.NOTEZ_READING_FONT_SIZE)await evaluate(`window.test.s.setPrefs('editorFontSize',${Math.max(10,Math.min(40,Number(process.env.NOTEZ_READING_FONT_SIZE)||16))})`);
 for(const width of (process.env.NOTEZ_READING_WIDTHS?.split(",").map(Number)??[1280,900])) {
  await rpc('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:width===900?1.25:1,mobile:false});
  await evaluate(`(()=>{const v=window.test.s.editorView();v.scrollDOM.scrollTop=0})()`);await sleep(800);
  await evaluate(`(async()=>{const v=window.test.s.editorView();await document.fonts.ready;v.requestMeasure();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const box=v.scrollDOM.getBoundingClientRect();v.posAtCoords({x:(box.left+box.right)/2,y:(box.top+box.bottom)/2},false)})()`);await sleep(300);
  const rows=[];
  const cursorStyle=()=>evaluate(`(()=>{const el=document.querySelector('.cm-activeLine'),s=getComputedStyle(el);return [s.fontSize,s.lineHeight,s.fontFamily]})()`);
  const initialStyle=await cursorStyle();
  for(const direction of [1,-1]) {
   for(let i=0;i<500;i++) {
    const before=await evaluate(`(()=>{const v=window.test.s.editorView(),r=v.scrollDOM.getBoundingClientRect(),x=(r.left+r.right)/2,y=r.top+r.height/2,p=v.posAtCoords({x,y},false),c=v.coordsAtPos(p);return {x,y,p,cy:c?.top,edge:r.top,top:v.scrollDOM.scrollTop,height:v.scrollDOM.scrollHeight,client:v.scrollDOM.clientHeight,line:v.state.doc.lineAt(p).number}})()`);
    if(direction===1 ? before.top>=before.height-before.client-2 : before.top<=1)break;
    const delta=(i%2===0 ? 230 : 400)*direction;
    await rpc('Input.dispatchMouseEvent',{type:'mouseWheel',x:before.x,y:before.y,deltaX:0,deltaY:delta});await sleep(100);
    const after=await evaluate(`(()=>{const v=window.test.s.editorView(),c=v.coordsAtPos(${before.p});return {cy:c?.top,top:v.scrollDOM.scrollTop,height:v.scrollDOM.scrollHeight}})()`);
    const expected=Math.max(-before.top,Math.min(delta,before.height-before.client-before.top));
    const error=after.cy==null||before.cy==null ? null : after.cy-before.cy+expected;
    rows.push({direction,i,before,after,error});
    const expectedY=before.cy==null ? null : before.cy-expected;
    const shouldStayVisible=expectedY!==null && expectedY>before.edge+24 && expectedY<before.edge+before.client-24;
    if(shouldStayVisible && after.cy==null) {
     writeFileSync(path.join(scratch,`reading-${width}.json`),JSON.stringify(rows,null,2));
     assert.fail(`${mode} text on line ${before.line} disappeared at width ${width}`);
    }
    // Compare the SAME text position on screen, not scrollTop: CM adjusts
    // offscreen height estimates as it renders, which legitimately changes it.
    if(error!==null && Math.abs(error)>24) {
     writeFileSync(path.join(scratch,`reading-${width}.json`),JSON.stringify(rows,null,2));
     assert.fail(`${mode} wheel jump at line ${before.line}, width ${width}: text moved ${after.cy-before.cy}px for ${delta}px input`);
    }
    assert.ok(i<499,'scroll must reach the end instead of getting stuck');
   }
   if(direction===-1 && mode==='live' && !process.env.NOTEZ_SCROLL_FILE){const ratio=await evaluate(`(()=>{const i=document.querySelector('.cm-nz-lp-image img[src*="tall-scroll"]');if(!i)return null;const r=i.getBoundingClientRect();return r.width/r.height})()`);assert.ok(ratio!==null&&Math.abs(ratio-.25)<.005,'recreated tall images preserve their aspect ratio');}
   assert.deepEqual(await cursorStyle(),initialStyle,'offscreen cursor line must retain its text metrics');
  }
  writeFileSync(path.join(scratch,`reading-${width}.json`),JSON.stringify(rows,null,2));
  assert.ok(rows.length>20,'exercise multiple viewport rebuilds');
  console.log(`${mode} reading ${width}px: ${rows.length} wheel steps, down/up, no text-anchor jump`);
  // Long RTL paragraphs: a real click, type, then undo at several locations.
  const lines=await evaluate(`(()=>{const d=window.test.s.editorView().state.doc;return Array.from({length:d.lines},(_,i)=>d.line(i+1)).filter(l=>l.text.length>250&&!l.text.includes('![[')).filter((_,i)=>i%7===0).slice(0,10).map(l=>l.number)})()`);
  let edits=0;
  for(const n of lines) {
   const target=await evaluate(`window.test.s.editorView().state.doc.line(${n}).from+20`);
   // Exercise one application jump, including its layout correction. Retrying
   // from the test could conceal a jump that leaves the target offscreen.
   await evaluate(`window.test.s.goToLine(${n},20)`);
   let point=null,lastGeometry=null;
   const deadline=Date.now()+5000;
   while(Date.now()<deadline){
    await sleep(100);
    lastGeometry=await evaluate(`(()=>{const v=window.test.s.editorView(),r=v.scrollDOM.getBoundingClientRect(),c=v.coordsAtPos(${target});return {rect:r.toJSON(),coords:c,viewport:v.viewport,top:v.scrollDOM.scrollTop}})()`);
    const {rect:r,coords:c,viewport}=lastGeometry;
    if(target>=viewport.from&&target<=viewport.to&&c&&c.top>=r.top&&c.bottom<=r.bottom&&c.left>=r.left&&c.left<r.right){point={x:c.left,y:(c.top+c.bottom)/2};break;}
   }
   if(!point)writeFileSync(path.join(scratch,`editing-${width}-${n}.json`),JSON.stringify(lastGeometry,null,2));
   assert.ok(point,`character ${target} on line ${n} must be reachable for editing: ${JSON.stringify(lastGeometry)}`);
   await evaluate(`window.test.s.editorView().dispatch({selection:{anchor:0}})`);await sleep(100);
   const clickGeometry=await evaluate(`(()=>{const v=window.test.s.editorView(),c=v.coordsAtPos(${target}),r=v.scrollDOM.getBoundingClientRect();return {c,r:r.toJSON()}})()`);
   assert.ok(clickGeometry.c&&clickGeometry.c.top>=clickGeometry.r.top&&clickGeometry.c.bottom<=clickGeometry.r.bottom,'target stays visible with caret elsewhere');
   point={x:clickGeometry.c.left,y:(clickGeometry.c.top+clickGeometry.c.bottom)/2};
   edits++;
   await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
   await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});await sleep(100);
   assert.equal(await evaluate(`window.test.s.editorView().state.doc.lineAt(window.test.s.editorView().state.selection.main.head).number`),n,'click must land in the requested paragraph');
   await rpc('Input.insertText',{text:' آزمون'});await sleep(100);
   const caret=await evaluate(`(()=>{const v=window.test.s.editorView(),c=v.coordsAtPos(v.state.selection.main.head),r=v.scrollDOM.getBoundingClientRect();return {visible:!!c&&c.top>=r.top&&c.bottom<=r.bottom,active:window.test.s.state.active}})()`);
   assert.equal(caret.active,'Reading.md');assert.ok(caret.visible,'typing must leave the caret visible');
   await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'z',code:'KeyZ',modifiers:2});await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'z',code:'KeyZ',modifiers:2});
   assert.equal(await evaluate(`window.test.s.editorView().state.doc.toString()`),original,'undo restores exact fixture');
  }
  console.log(`${mode} editing ${width}px: ${edits} click/type/undo cases`);
  assert.ok(edits>=3,'exercise actual clicks and typing');
  const shot=await rpc('Page.captureScreenshot',{format:'png'});writeFileSync(path.join(scratch,`reading-${width}.png`),Buffer.from(shot.data,'base64'));
 }
 if(!process.env.NOTEZ_SCROLL_FILE && mode==='live') {
  await evaluate(`(()=>{const v=window.test.s.editorView(),p=v.state.doc.toString().indexOf('![[missing-scroll-image.png]]');v.dispatch({selection:{anchor:0},effects:v.constructor.scrollIntoView(p,{y:'center'})})})()`);await sleep(300);
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.cm-nz-lp-image.missing')).some(e=>e.textContent.includes('missing-scroll-image.png'))`),'missing asset has a visible placeholder');
  writeFileSync(path.join(vault,'missing-scroll-image.png'),readFileSync('build/icon.png'));
  await evaluate(`window.test.s.setPrefs('editorMode','source')`);await sleep(50);
  await evaluate(`window.test.s.setPrefs('editorMode','live')`);await sleep(500);
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.cm-nz-lp-image img')).some(i=>i.src.includes('missing-scroll-image.png')&&i.complete&&i.naturalWidth>0&&!i.closest('.missing'))`),'a previously missing asset must recover after it is added');
 }
 await evaluate(`window.test.s.saveAll()`);
 assert.equal(readFileSync(path.join(vault,'Reading.md'),'utf8'),original,'reading/edit/undo must preserve the saved source');
}
