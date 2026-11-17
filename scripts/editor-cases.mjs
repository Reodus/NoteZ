import assert from 'node:assert/strict';

export async function checkEditor({evaluate,rpc,sleep}) {
 const click=async p=>{
  await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',buttons:1,clickCount:1});
  await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});
  await sleep(100);
 };
 await evaluate(`(async()=>{const {s,ipc}=window.test;await ipc.write('تصویر.svg','<svg xmlns="http://www.w3.org/2000/svg" width="100" height="500"><rect width="100" height="500" fill="purple"/></svg>');await ipc.write('Editor.md','---\\ntitle: Before\\n---\\n\\nسلام دنیا EnglishWord\\n\\n![[تصویر.svg]]\\n');await s.openNote('Editor.md');s.setPrefs('editorMode','live')})()`);await sleep(200);
 await evaluate(`(()=>{const t=document.querySelector('.cm-nz-lp-doc-title');t.focus();t.textContent='A longer title'})()`);
 await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter'});
 await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter'});await sleep(150);
 assert.ok(await evaluate(`(()=>{const v=window.test.s.editorView();return v.hasFocus&&v.state.doc.lineAt(v.state.selection.main.head).number===4&&v.state.doc.toString().includes('title: A longer title')})()`),'Enter commits title and focuses body');
 for(const mode of ['live','source']) {
  await evaluate(`window.test.s.setPrefs('editorMode',${JSON.stringify(mode)})`);await sleep(150);
  const point=await evaluate(`(()=>{const v=window.test.s.editorView(),l=v.state.doc.line(5),p=l.from+l.text.indexOf('EnglishWord'),c=v.coordsAtPos(p,1);return {x:c.left-8,y:(c.top+c.bottom)/2}})()`);
  await click(point);
  const selection=await evaluate(`(()=>{const v=window.test.s.editorView();return {head:v.state.selection.main.head,end:v.state.doc.line(5).to}})()`);
  assert.equal(selection.head,selection.end,mode+': click past LTR word at RTL row end');
 }
 await evaluate(`(()=>{const v=window.test.s.editorView();window.test.s.setPrefs('editorMode','live');const p=v.state.doc.toString().indexOf('تصویر');v.dispatch({selection:{anchor:p},scrollIntoView:true})})()`);await sleep(500);
 const point=await evaluate(`(()=>{const v=window.test.s.editorView(),c=v.coordsAtPos(v.state.selection.main.head);return {x:c.left,y:c.top+5}})()`);
 await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await sleep(300);
 const geometry=await evaluate(`(()=>{const h=document.querySelector('.cm-nz-handle.visible'),preview=document.querySelector('.cm-nz-lp-image.preview'),line=preview?.closest('.cm-line');return {handle:h?.getBoundingClientRect().toJSON(),line:line?.getBoundingClientRect().toJSON(),height:window.test.s.editorView().defaultLineHeight,rtl:line&&getComputedStyle(line).direction==='rtl',source:line?.querySelector('.cm-nz-ltr-run')?.getBoundingClientRect().toJSON()}})()`);
 assert.ok(geometry.handle&&geometry.line,JSON.stringify(geometry));
 assert.ok(geometry.handle.top>=geometry.line.top-1&&geometry.handle.bottom<=geometry.line.top+geometry.height+2,'image source grip aligns with text row: '+JSON.stringify(geometry));
 assert.ok(geometry.rtl?geometry.handle.left>=geometry.source.right:geometry.handle.right<=geometry.source.left,'image source grip stays outside path: '+JSON.stringify(geometry));
 await evaluate(`(async()=>{const {s}=window.test;await s.closeTab('Editor.md');await s.openNote('Audit.md')})()`);
 console.log('Editor regressions: title Enter, mixed bidi row end, image source grip');
}
