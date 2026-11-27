import assert from 'node:assert/strict';

export async function checkAutoPair({evaluate,rpc,until}) {
 const ui=code=>evaluate(`(async()=>{const {s,ipc}=window.test;${code}})()`);
 const reset=(doc,anchor=doc.length,head=anchor)=>ui(`const v=s.editorView();v.dispatch({changes:{from:0,to:v.state.doc.length,insert:${JSON.stringify(doc)}},selection:{anchor:${anchor},head:${head}}});v.focus();`);
 const read=()=>ui('const {state}=s.editorView(),{anchor,head}=state.selection.main;return {doc:state.doc.toString(),anchor,head};');
 const type=async(text,count=1)=>{
  for(let i=0;i<count;i++)await rpc('Input.insertText',{text});
 };
 const key=async(key,windowsVirtualKeyCode,modifiers=0)=>{
  const params={key,code:key==='z'?'KeyZ':key,windowsVirtualKeyCode,modifiers};
  await rpc('Input.dispatchKeyEvent',{type:'keyDown',...params});
  await rpc('Input.dispatchKeyEvent',{type:'keyUp',...params});
 };
 const expect=async(doc,anchor=doc.length,head=anchor)=>assert.deepEqual(await read(),{doc,anchor,head});
 const tick='`';
 await ui(`await ipc.write('Delimiters.md','');await s.openNote('Delimiters.md');s.setPrefs('autoPair',true);`);
 await reset('');await type(tick);await expect('``',1);
 await key('z',90,process.platform==='darwin'?4:2);await expect('');
 for(const mode of ['source','live']) {
  await ui(`s.setPrefs('editorMode',${JSON.stringify(mode)});`);
  await reset('');await type(tick);await expect('``',1);
  await key('Backspace',8);await expect('');
  await type(tick,3);await expect('```\n\n```\n',4);
  await type('$');await type(tick);await expect('```\n$`\n```\n',6);
  await reset('```\n``');await type(tick);await expect('```\n```\n',7);
  await reset('> - ');await type(tick,3);await expect('> - ```\n>   \n>   ```\n',12);
  await reset('');await type('~',3);await expect('~~~\n\n~~~\n',4);
  await reset('سلام x',6,0);await type(tick);await expect('`سلام x`',7,1);
  await type(tick);await expect('``سلام x``',8,2);
  await reset('سلام `x`',0,8);await type(tick);await expect('`` سلام `x` ``',3,11);
  await reset('> alpha\n> بتا',2,13);await type(tick);await expect('> ```\n> alpha\n> بتا\n> ```\n',8,19);
  await reset('before alpha\nbeta after',7,17);await type(tick);await expect('before \n```\nalpha\nbeta\n```\n after',12,22);
  await reset('`x`',2);await type(tick);await expect('`x`',3);
  await reset('``x``',3);await type(tick);await expect('``x``',5);
  await reset('\\');await type(tick);await expect('\\`');
  await reset('');await type('$');await expect('$$\n',1);
  await type('$');await expect('$$\n\n$$\n',3);
  await reset('x',0,1);await type('$');await expect('$x$',1,2);
  await reset('x',0,1);await type('*',2);await expect('**x**',2,3);
  await reset('US');await type('$');await expect('US$');
 }
 await ui(`s.setPrefs('autoPair',false);`);
 await reset('');await type(tick,3);await expect('```\n',3);
 await ui(`s.setPrefs('autoPair',true);await s.closeTab('Delimiters.md');await ipc.write('Delimiters.typ','');await s.openNote('Delimiters.typ');`);
 await until(()=>ui('return !!s.editorView()&&s.state.active.endsWith(".typ");'),'Typst editor ready');
 await reset('');await type(tick,3);await expect('```');
 await ui(`await s.closeTab('Delimiters.typ');await s.openNote('Audit.md');`);
 console.log('Auto-close: inline code, fences, RTL and multiline selection, math, literal code, settings and Typst');
}

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
 const geometry=await evaluate(`(()=>{const h=document.querySelector('.cm-nz-handle.visible'),preview=document.querySelector('.cm-nz-lp-image.preview'),line=preview?.closest('.cm-line');return {handle:h?.getBoundingClientRect().toJSON(),line:line?.getBoundingClientRect().toJSON(),height:window.test.s.editorView().defaultLineHeight,editor:window.test.s.editorView().dom.getBoundingClientRect().toJSON(),rtl:document.documentElement.dir==='rtl',source:line?.querySelector('.cm-nz-ltr-run')?.getBoundingClientRect().toJSON()}})()`);
 assert.ok(geometry.handle&&geometry.line,JSON.stringify(geometry));
 assert.ok(geometry.handle.top>=geometry.line.top-1&&geometry.handle.bottom<=geometry.line.top+geometry.height+2,'image source grip aligns with text row: '+JSON.stringify(geometry));
 assert.ok(Math.abs(geometry.rtl?geometry.editor.right-geometry.handle.right:geometry.handle.left-geometry.editor.left)<=5,'image grip stays in the interface gutter: '+JSON.stringify(geometry));
 await evaluate(`(async()=>{const {s}=window.test;await s.closeTab('Editor.md');await s.openNote('Audit.md')})()`);
 console.log('Editor regressions: title Enter, mixed bidi row end, image source grip');
}
