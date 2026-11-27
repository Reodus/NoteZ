// Isolated Electron/CDP regression suite. Linux CI: xvfb-run -a npm run test:ui.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { createServer } from 'vite';
import { readingFixture, checkReading } from './reading-cases.mjs';
import { checkScroll } from './scroll-cases.mjs';
import { checkAutoPair, checkEditor } from './editor-cases.mjs';
import { checkEditorModes } from './editor-modes-cases.mjs';
import { checkDocumentThemes } from './theme-cases.mjs';
import { checkTableColumns } from './column-cases.mjs';
import { checkFootnoteComposer } from './footnote-cases.mjs';
import { checkDragMotion } from './drag-motion-cases.mjs';
import { checkWorkspace } from './workspace-cases.mjs';
const readingOnly=process.argv.includes('--reading');

async function checkContentStability({evaluate, until, vault, scratch}) {
 const ui = (code) => evaluate(`(async()=>{const {s,ipc}=window.test;${code}})()`);
 const formattingPath = 'Formatting-CRLF.md';
 const original = '---\r\ntitle: A\r\n---\r\n::: {align=center dir=rtl}\r\nText\r\n:::\r\n\r\n::: {align=right}\r\nEnd\r\n';
 await ui(`await ipc.write(${JSON.stringify(formattingPath)}, ${JSON.stringify(original)});await s.openNote(${JSON.stringify(formattingPath)});`);
 await until(()=>evaluate("!!document.querySelector('.div-warning')"), 'unclosed formatting block warning');
 await ui(`
   const v = s.editorView();
   const { setBlockAttr } = await import('/src/editor/format.ts');
   v.dispatch({selection:{anchor:v.state.doc.toString().indexOf('Text')+1}});
   setBlockAttr(v,'align',null);
   document.querySelector('.div-warning').click();
   await s.saveAll();
 `);
 const formatted = readFileSync(path.join(vault,formattingPath),'utf8');
 assert.equal(formatted, original.replace('align=center dir=rtl','dir=rtl')+':::\r\n');

 await ui(`
   const path = 'Save-race.md';
   await ipc.write(path,'original');
   await s.openNote(path);
   const write = ipc.write;
   let start, release;
   const started = new Promise(resolve => start = resolve);
   const held = new Promise(resolve => release = resolve);
   ipc.write = async (...args) => {
     if(args[0]===path && args[1]==='older autosave') { start(); await held; }
     return write(...args);
   };
   try {
     s.updateContent(path,'older autosave');
     const pending = s.save(path);
     await started;
     s.updateContent(path,'original');
     const closing = s.closeTab(path);
     release();
     await Promise.all([pending,closing]);
   } finally { ipc.write = write; }
 `);
 assert.equal(readFileSync(path.join(vault,'Save-race.md'),'utf8'),'original');

 const capture = await ui(`
   const {captureText} = await import('/src/plugins/daily.tsx');
   const path = 'Capture-race.md';
   await ipc.write(path,'start\\n');
   await s.refreshTree();
   const {captureTarget,captureFormat} = s.prefs;
   s.setPrefs('captureTarget',path);
   s.setPrefs('captureFormat','{{text}}');
   try {
     await Promise.all([captureText('first'),captureText('second')]);
     return await ipc.read(path);
   } finally {
     s.setPrefs('captureTarget',captureTarget);
     s.setPrefs('captureFormat',captureFormat);
   }
 `);
 assert.equal(capture,'start\nfirst\nsecond\n');

 const afterReplace = await ui(`
   const path = 'Replace-race.md';
   const opts = {find:'before',replace:'after',scope:'path:Replace-race'};
   await ipc.write(path,'before');
   const preview = (await ipc.replacePreview(opts)).find(file=>file.path===path);
   if(!preview?.hash) throw Error('Replace preview had no file revision');
   await ipc.write(path,'edited before applying');
   try { await ipc.replaceApply(opts,[path],{[path]:preview.hash}); }
   catch { return await ipc.read(path); }
   throw Error('A stale replace preview should have failed');
 `);
 assert.equal(afterReplace,'edited before applying');

 const sync = await ui(`
   const path = 'Sync-edit.md';
   const {app,dismissToast} = await import('/src/core/app.ts');
   await ipc.write(path,'base');
   await s.openNote(path);
   const resume = await s.pauseNoteSaves();
   let result;
   try {
     s.updateContent(path,'local edit');
     await ipc.write(path,'remote edit');
     await s.reloadFromDisk(path);
     result = [s.state.buffers[path].content,await ipc.read(path)];
   } finally { resume(); }
   const toast = app.toasts().findLast(item=>item.message.includes(path) && item.action);
   toast.action.run();
   dismissToast(toast.id);
   s.dialog().items[0].run();
   s.setDialog(null);
   await s.closeTab(path);
   return [...result,await ipc.read(path)];
 `);
 assert.deepEqual(sync,['local edit','remote edit','local edit']);

 const nextVault = path.join(scratch,'vault-switch');
 mkdirSync(nextVault);
 writeFileSync(path.join(nextVault,'Same.md'),'second vault');
 const switchResult = await ui(`
   const previous = s.root();
   const target = ${JSON.stringify(nextVault)};
   const open = ipc.openVault;
   let ready, release;
   const started = new Promise(resolve=>ready=resolve);
   const held = new Promise(resolve=>release=resolve);
   ipc.openVault = async next => {
     const tree = await open(next);
     ready();
     await held;
     return tree;
   };
   const switching = s.openVault(target);
   let rejected = false;
   let inert;
   try {
     await started;
     inert = document.querySelector('.shell').inert;
     try { await window.notezNative.core('write_note',{path:'Same.md',content:'stale write',vault:previous}); }
     catch { rejected = true; }
   } finally {
     release();
     await switching;
     ipc.openVault = open;
   }
   const result = {inert,rejected,contents:await ipc.read('Same.md')};
   await s.openVault(previous);
   return result;
 `);
 assert.deepEqual(switchResult,{inert:true,rejected:true,contents:'second vault'});
 await ui(`
   await s.openNote('Audit.md');
 `);
 console.log('Formatting, CRLF, save races, capture, stale replace, sync edits and vault switch passed');
}

async function checkMiddleClickTab({evaluate,rpc,until}) {
 const before=await evaluate(`(async()=>{
  const {s}=window.test;
  await s.openNote('Other.md');
  await s.openNote('Audit.md');
  s.editorView().focus();
  document.addEventListener('mouseup', e => {
   window.test.tabReleasePrevented=e.defaultPrevented;
  }, {once:true});
  return s.editorView().state.doc.toString();
 })()`);
 const point=await evaluate(`(()=>{
  const r=document.querySelector('.tab[title="Other.md"] .tab-title').getBoundingClientRect();
  return {x:r.left+r.width/2,y:r.top+r.height/2};
 })()`);
 await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'middle',buttons:4,clickCount:1});
 assert.equal(await evaluate("window.test.s.state.tabs.includes('Other.md')"),true,'the tab stays open until the middle button is released');
 await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'middle',clickCount:1});
 await until(()=>evaluate("!window.test.s.state.tabs.includes('Other.md')"),'middle-click closes the background tab');
 assert.equal(await evaluate('window.test.s.editorView().state.doc.toString()'),before,'middle-clicking a tab must not paste into the focused editor');
 assert.equal(await evaluate('window.test.tabReleasePrevented'),true,'the tab cancels the native middle-button release');
}

const scratch=mkdtempSync(path.join(process.env.RUNNER_TEMP||tmpdir(),'notez-ui-')),vault=path.join(scratch,'vault');
mkdirSync(vault);mkdirSync(path.join(scratch,'second'));
const fixture='---\ntitle: Audit\n---\n\n# English\n\nAlpha paragraph.\n\nBeta destination.\n\n- [ ] English task\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\n# فارسی\n\nسلام دنیا، این یک پاراگراف است.\n\n- [ ] کار فارسی\n\n| نام | مقدار |\n| --- | --- |\n| یک | دو |\n';
writeFileSync(path.join(vault,'Audit.md'),fixture);writeFileSync(path.join(vault,'Other.md'),'Other note. [[Audit]]\n');
for(const name of ['LongA.md','LongB.md','Slow.md'])writeFileSync(path.join(vault,name),Array.from({length:400},(_,i)=>`Paragraph ${i}: long note content for scrolling.\n`).join('\n'));
writeFileSync(path.join(vault,'pixel.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9sAAAAASUVORK5CYII=','base64'));
const readingText=readingOnly?readingFixture(vault):null;
// Vite plugins install this gate before the HTML middleware, so CDP can
// attach to about:blank during a deliberately delayed initial navigation.
const server=await createServer({plugins:[{name:'test-startup-delay',configureServer(server){
 server.middlewares.use((req,res,next)=>{
  if(req.url==='/'&&process.env.NOTEZ_TEST_STARTUP_DELAY)setTimeout(next,Number(process.env.NOTEZ_TEST_STARTUP_DELAY));else next();
 });
}}],server:{host:'127.0.0.1',port:0,strictPort:false},logLevel:'error'});await server.listen();
const child=spawn(electron,['.', '--remote-debugging-port=0',`--user-data-dir=${path.join(scratch,'user-data')}`,'--disable-gpu',...(process.platform==='linux'?['--ozone-platform=x11']:[]),'--disable-background-timer-throttling','--disable-renderer-backgrounding',...(process.env.CI || process.getuid?.()===0?['--no-sandbox']:[]),vault,'Audit.md'],{env:{...process.env,XDG_CONFIG_HOME:path.join(scratch,'config'),NOTEZ_DEV_URL:server.resolvedUrls.local[0]},stdio:['ignore','pipe','pipe']});
let stderr='',exited=false;const exit=new Promise(resolve=>child.once('exit',code=>{exited=true;resolve(code);}));child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',()=>{});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(80);}throw Error('Timed out: '+label+'\n'+stderr.slice(-2000));}
let ws;const pending=new Map();let seq=0;const exceptions=[],layoutWarnings=[];
try {
 await until(()=>/DevTools listening on ws:/.test(stderr),'debugger startup');
 const port=/DevTools listening on ws:\/\/[^:]+:(\d+)/.exec(stderr)[1];
 let target;
 await until(async()=>{const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();target=targets.find(t=>t.type==='page');return !!target;},'page target');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}else if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);else if(m.method==='Runtime.consoleAPICalled'&&['error','warning'].includes(m.params.type)){const message=JSON.stringify(m.params.args.map(a=>a.description??a.value));console.error('renderer:',message);if(/Viewport failed to stabilize|Measure loop restarted/.test(message))layoutWarnings.push(message);}};
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{if(process.env.UI_DEBUG)console.log('CDP',method);const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},25000);pending.set(id,m=>{clearTimeout(timer);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await rpc('Runtime.enable');await rpc('Page.bringToFront');await rpc('Emulation.setFocusEmulationEnabled',{enabled:true});
 const waitForEditor=async(language)=>{
  const origin=new URL(server.resolvedUrls.local[0]).origin;
  await until(async()=>{
   try {
    // about:blank cannot resolve a root-relative import. Wait without
    // importing until the application document has finished navigating.
    const ready=await evaluate(`location.origin===${JSON.stringify(origin)}&&document.readyState==='complete'`);
    if(!ready)return false;
    return await evaluate(`(async()=>{const s=await import('/src/core/store.ts');return !!s.editorView()&&s.state.active==='Audit.md'&&${language?`document.documentElement.lang===${JSON.stringify(language)}`:'true'}})()`);
   } catch(error) {
    // Navigation may replace the context between readiness and import.
    // Application/module errors must still fail immediately.
    if(/Execution context was destroyed|Cannot find context with specified id|Inspected target navigated/.test(String(error)))return false;
    throw error;
   }
  },'application editor ready',60000);
 };
 await waitForEditor();
 const testLanguage = process.env.NOTEZ_TEST_LANGUAGE === 'fa' ? 'fa' : 'en';
 if(await evaluate('document.documentElement.lang') !== testLanguage){
  await evaluate(`(()=>{const p=JSON.parse(localStorage.getItem('notez.prefs.v1')||'{}');localStorage.setItem('notez.prefs.v1',JSON.stringify({...p,uiLanguage:${JSON.stringify(testLanguage)}}))})()`);
  await rpc('Page.reload');
  await waitForEditor(testLanguage);
 }
 const initializeTests = () => evaluate(`(async()=>{const s=await import('/src/core/store.ts'),c=await import('/src/core/comments.ts'),{ipc}=await import('/src/core/ipc.ts');window.test={s,c,ipc};window.testErrors=[];window.addEventListener('error',e=>window.testErrors.push(e.message));s.setPrefs('checkUpdates',false);s.setPrefs('snapshotDaily',false);s.setPrefs('updateLinks','always');s.setPrefs('confirmDelete',false);s.setPrefs('deleteToTrash',false);await c.loadComments(s.state.active)})()`);
 await initializeTests();
 if(readingOnly){
  await checkReading({evaluate,rpc,sleep,until,scratch,vault,original:readingText});
  assert.deepEqual(await evaluate('window.testErrors'),[]);assert.equal(exceptions.length,0,JSON.stringify(exceptions));assert.deepEqual(layoutWarnings,[],'editor geometry must stabilize');
  console.log('Reading artifacts: '+scratch);
 } else if (process.argv.includes('--editor-modes')) {
  await checkEditorModes({evaluate,rpc,until,vault,scratch});
  assert.deepEqual(exceptions, []);
 } else {
 await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:850,deviceScaleFactor:1,mobile:false});
 await until(()=>evaluate("innerWidth===1280&&!window.test.s.compactWorkspace()"),'desktop workspace width');
 await checkContentStability({evaluate,until,vault,scratch});
 await checkWorkspace({evaluate,rpc,until,vault,scratch,reload:async()=>{
  await rpc('Page.reload');await waitForEditor();await initializeTests();
 }});
 await sleep(150);
 await checkMiddleClickTab({evaluate,rpc,until});
 await checkAutoPair({evaluate,rpc,until});
 await checkEditor({evaluate,rpc,sleep});
 await checkEditorModes({evaluate,rpc,until,vault,scratch});
 await checkScroll(evaluate,sleep);
 assert.deepEqual(layoutWarnings,[],'Source and Live scroll restores must stabilize');
 await checkDocumentThemes({evaluate,rpc,until,vault});
 await checkTableColumns({evaluate,rpc,until,sleep});
 await checkFootnoteComposer({evaluate,rpc,until,sleep});
 await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:850,deviceScaleFactor:1,mobile:false});
 await until(()=>evaluate("innerWidth===1280&&!window.test.s.compactWorkspace()"),'desktop width for sidebar resizing');
 await checkDragMotion({evaluate,rpc,until,sleep,vault});
 const before=readFileSync(path.join(vault,'Audit.md'),'utf8');
 await evaluate(`(async()=>{const {s,c}=window.test,v=s.editorView();const a=v.state.doc.toString().indexOf('Alpha');v.dispatch({selection:{anchor:a,head:a+5}});await c.addComment();const id=c.comments[s.state.active][0].id;window.test.id=id;const input=document.querySelector('.comment-body');input.value='Review فارسی';input.dispatchEvent(new Event('input',{bubbles:true}));await c.flushComments();s.setRightTab('preview');document.addEventListener('mousemove',e=>window.lastMouse={x:e.clientX,y:e.clientY,target:e.target.className})})()`);
 assert.equal(readFileSync(path.join(vault,'Audit.md'),'utf8'),before,'comments must not edit source');
 const pointOf=async text=>{await evaluate(`(()=>{const v=window.test.s.editorView(),p=v.state.doc.toString().indexOf(${JSON.stringify(text)});v.dispatch({selection:{anchor:p},scrollIntoView:true})})()`);await sleep(120);return evaluate(`(()=>{const v=window.test.s.editorView(),r=v.coordsAtPos(v.state.doc.toString().indexOf(${JSON.stringify(text)}));return {x:r.left+4,y:(r.top+r.bottom)/2}})()`);};
 const hover=async text=>{const pos=await pointOf(text);if(process.env.UI_DEBUG)console.log('hover',text,pos);await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',...pos});await sleep(1200);const settled=await evaluate(`(()=>{const v=window.test.s.editorView(),r=v.coordsAtPos(v.state.doc.toString().indexOf(${JSON.stringify(text)}));return {x:r.left+4,y:(r.top+r.bottom)/2}})()`);await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:settled.x+1,y:settled.y});await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',...settled});await sleep(160);return evaluate(`(()=>{const h=document.querySelector('.cm-nz-handle.visible');if(!h)throw Error('Missing handle '+JSON.stringify({mouse:window.lastMouse,hit:document.elementFromPoint(${pos.x},${pos.y})?.className,html:document.querySelector('.cm-nz-handle')?.outerHTML,editor:document.querySelector('.cm-editor')?.getBoundingClientRect().toJSON(),scroll:document.querySelector('.cm-scroller')?.getBoundingClientRect().toJSON()}));const r=h.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,left:r.left,right:r.right}})()`);};
 const grip=await hover('Alpha');
 const target=await evaluate(`(()=>{const v=window.test.s.editorView(),r=v.coordsAtPos(v.state.doc.toString().indexOf('Beta destination.'));return {x:r.left+5,y:(r.top+r.bottom)/2}})()`);
 await rpc('Input.dispatchMouseEvent',{type:'mousePressed',x:grip.x,y:grip.y,button:'left',buttons:1,clickCount:1});
 await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:target.x,y:target.y+12,button:'left',buttons:1});
 await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:target.x,y:target.y+12,button:'left',clickCount:1});
 assert.equal(await evaluate(`(()=>{const {s,c,id}=window.test;const text=s.editorView().state.doc.toString(),a=c.comments[s.state.active].find(x=>x.id===id);return text.indexOf('Alpha')>text.indexOf('Beta')&&!a.orphaned&&a.quote==='Alpha'})()`),true,'pointer move must carry comments');
 await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'z',code:'KeyZ',modifiers:2});
 await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'z',code:'KeyZ',modifiers:2});
 await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'z',code:'KeyZ',modifiers:10});
 await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'z',code:'KeyZ',modifiers:10});
 // Both document modes, both directions, and a narrower editor must have usable grips.
 for(const width of [1280,900])for(const mode of ['live','source']){
  await rpc('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});
  await evaluate(`window.test.s.setPrefs('editorMode',${JSON.stringify(mode)})`);await sleep(180);
  for(const text of ['Alpha','سلام دنیا']){
   await evaluate(`(()=>{const v=window.test.s.editorView(),p=v.state.doc.toString().indexOf(${JSON.stringify(text)});v.dispatch({selection:{anchor:p},scrollIntoView:true})})()`);await sleep(150);
   const h=await hover(text);assert.ok(h.left>=0&&h.right<=width,'handle inside viewport');
  }
 }
 await evaluate(`window.test.s.setPrefs('editorMode','live')`);await sleep(180);
 // Rendered table widgets ignore CodeMirror input; hover must still expose
 // a grip on the interface gutter without covering cells.
 for(const n of [0,1]) {
  await evaluate(`(()=>{const v=window.test.s.editorView();v.dispatch({selection:{anchor:0}});const table=document.querySelectorAll('.nz-edit-table')[${n}];table.scrollIntoView({block:'center'})})()`);await sleep(300);
  const rect=await evaluate(`(()=>{const r=document.querySelectorAll('.nz-edit-table')[${n}].getBoundingClientRect();return {left:r.left,right:r.right,top:r.top}})()`);
  await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.left+15,y:rect.top+15});await sleep(300);
  const h=await evaluate(`(()=>{const h=document.querySelector('.cm-nz-handle.visible');if(!h)throw Error('No rendered table handle');const r=h.getBoundingClientRect(),editor=h.closest('.cm-editor').getBoundingClientRect();return {left:r.left,right:r.right,gutter:document.documentElement.dir==='rtl'?editor.right-r.right:r.left-editor.left,rtl:document.documentElement.dir==='rtl'}})()`);
  assert.ok(h.rtl?h.left>=rect.right:h.right<=rect.left,`table ${n} grip overlaps widget: ${JSON.stringify({rect,h})}`);
  assert.ok(h.gutter>=0&&h.gutter<=5,'grip uses the same fixed gutter for both table directions');
  const shot=await rpc('Page.captureScreenshot',{format:'png'});writeFileSync(path.join(scratch,`table-${n}.png`),Buffer.from(shot.data,'base64'));
 }
 // Escape cancels an active pointer drag and removes its global cursor state.
 const cancelGrip=await hover('Alpha');
 const scrollBefore=await evaluate(`({top:window.test.s.editorView().scrollDOM.scrollTop,text:window.test.s.editorView().state.doc.toString(),bottom:window.test.s.editorView().scrollDOM.getBoundingClientRect().bottom})`);
 await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:cancelGrip.x,y:cancelGrip.y,buttons:0});
 await rpc('Input.dispatchMouseEvent',{type:'mousePressed',x:cancelGrip.x,y:cancelGrip.y,button:'left',clickCount:1});
 await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:cancelGrip.x+30,y:scrollBefore.bottom-4,buttons:1});
 await until(()=>evaluate("!!document.querySelector('.nz-drag-float')"),'editor block follows the pointer');
 await sleep(250);assert.ok(await evaluate(`window.test.s.editorView().scrollDOM.scrollTop`)>scrollBefore.top,'drag autoscroll');
 await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
 await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:cancelGrip.x+30,y:cancelGrip.y+30,button:'left',clickCount:1});
 assert.equal(await evaluate(`document.body.classList.contains('nz-dragging-block')`),false);
 await until(()=>evaluate("!document.querySelector('.nz-drag-float')"),'cancel clears the floating editor block');
 assert.equal(await evaluate(`window.test.s.editorView().state.doc.toString()`),scrollBefore.text,'cancel must retain document');
 await evaluate(`(async()=>{const {s,ipc}=window.test;await s.saveAll();await ipc.createFolder('folder');await s.renameEntry('Audit.md','Renamed.md');await s.moveEntry('Renamed.md','folder');await s.renameEntry('folder','archive');await s.saveAll();await s.openNote('Other.md');const tabs=document.querySelectorAll('.tab'),dataTransfer=new DataTransfer(),other=document.querySelector('.tab[title="Other.md"]');other.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));tabs[0].dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer}));tabs[0].dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));if(s.state.tabs[0]!=='Other.md')throw Error('Tab reorder failed');await s.openNote('archive/Renamed.md');const section=await ipc.noteSection('Other.md','Renamed');if(section?.path!=='archive/Renamed.md')throw Error('Renamed link no longer resolves')})()`);
 assert.ok(existsSync(path.join(vault,'.notez/comments/archive/Renamed.md.json')),'sidecar follows file/folder');
 // Real render/export, history and encrypted folder sync use only the scratch vault.
 await evaluate(`(async()=>{const {s,c,ipc}=window.test,p=s.state.active,text=s.state.buffers[p].content;const {injectComments}=await import('/src/core/commentPdf.ts');await ipc.exportPdf(p,injectComments(p,text,c.comments[p]),[],${JSON.stringify(path.join(scratch,'audit.pdf'))});await ipc.exportHtml(p,text,[],${JSON.stringify(path.join(scratch,'audit.html'))});await ipc.exportDocx(p,text,[],${JSON.stringify(path.join(scratch,'audit.docx'))});const hits=await ipc.search('Alpha');if(!hits.length)throw Error('Search failed');await ipc.historyKeep(p,'before-restore');const versions=await ipc.historyList(p);if(!versions.length)throw Error('No history');const version=versions[0];await ipc.historyRestore(p,version.h);await s.reloadFromDisk(p);await ipc.snapshotCreate('smoke');await s.deleteEntry('Other.md');const deleted=(await ipc.historyDeleted()).find(x=>x.path==='Other.md');if(!deleted)throw Error('Deleted note not recoverable');await ipc.historyRestore('Other.md',deleted.h);await s.refreshTree();if(!(await ipc.read('Other.md')).includes('Renamed'))throw Error('Restore lost links');await s.saveAll();await ipc.syncRun({kind:'folder',url:${JSON.stringify(path.join(scratch,'remote'))},user:'',password:'',bucket:'',region:'',prefix:''},'test-only-passphrase')})()`);
 assert.ok(readFileSync(path.join(scratch,'audit.pdf')).subarray(0,4).equals(Buffer.from('%PDF')));
 assert.ok(!readFileSync(path.join(scratch,'audit.html'),'utf8').includes('Review فارسی'));
 // Failed attachment imports must preserve the selection. A successful
 // import remains attached to its original note if the user changes tabs.
 await evaluate(`(async()=>{const {s,ipc}=window.test,v=s.editorView(),p=s.state.active;const original=ipc.saveAttachment,before=s.state.buffers[p].content;const a=before.indexOf('Alpha');v.dispatch({selection:{anchor:a,head:a+5}});const paste=()=>{const data=new DataTransfer();data.items.add(new File(['hello'],'attachment.txt',{type:'text/plain'}));v.contentDOM.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}))};ipc.saveAttachment=async()=>{throw Error('injected import failure')};paste();await s.saveAll();if(s.state.buffers[p].content!==before)throw Error('Failed paste deleted source');ipc.saveAttachment=async(...args)=>{await new Promise(r=>setTimeout(r,80));return original(...args)};paste();await s.openNote('Other.md');await s.saveAll();ipc.saveAttachment=original;if(!s.state.buffers[p].content.includes('attachment.txt')||s.state.buffers['Other.md'].content.includes('attachment.txt'))throw Error('Attachment inserted into wrong note');await s.openNote(p)})()`);
 // File-tree drags reject unrelated payloads and move files to the requested folder.
 await evaluate(`(async()=>{const {s,ipc}=window.test;await ipc.createFolder('drag-target');await s.refreshTree();const row=document.querySelector('.tree-item[data-path="Other.md"]'),target=document.querySelector('.tree-item[data-path="drag-target"]');const unrelated=new DataTransfer();unrelated.setData('text/plain','text');const event=new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:unrelated});target.dispatchEvent(event);if(event.defaultPrevented)throw Error('Tree accepts unrelated drag');const data=new DataTransfer();row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data}));target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));row.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:data}))})()`);
 await until(()=>existsSync(path.join(vault,'drag-target/Other.md')),'file tree drag move');
 // Failure must retain buffers, tabs and the vault through all close/switch paths.
 await evaluate(`(async()=>{const {s,ipc}=window.test;window.test.write=ipc.write;ipc.write=async()=>{throw Error('injected disk full')};const v=s.editorView();v.dispatch({changes:{from:v.state.doc.length,insert:'\\nUNSAVED-MARKER'}});const root=s.root(),path=s.state.active;for(const action of [()=>s.closeTab(path),()=>s.closeVault(),()=>s.openVault(${JSON.stringify(path.join(scratch,'second'))})]){let rejected=false;try{await action()}catch{rejected=true}if(!rejected||s.root()!==root||!s.state.buffers[path]?.content.includes('UNSAVED-MARKER'))throw Error('Save failure lost buffer')}})()`);
 ws.send(JSON.stringify({id:++seq,method:'Browser.close'}));await sleep(500);
 assert.equal(exited,false,'failed save must prevent native window close');
 await evaluate(`window.test.ipc.write=window.test.write`);
 assert.deepEqual(await evaluate(`window.testErrors`),[],'no uncaught renderer errors');
 const screenshot=await rpc('Page.captureScreenshot',{format:'png'});writeFileSync(path.join(scratch,'audit.png'),Buffer.from(screenshot.data,'base64'));
 // A successful native close must persist even a just-typed edit.
 ws.send(JSON.stringify({id:++seq,method:'Browser.close'}));await until(()=>exited,'successful saved exit');
 assert.ok(readFileSync(path.join(vault,'archive/Renamed.md'),'utf8').includes('UNSAVED-MARKER'));
 assert.equal(exceptions.length,0,JSON.stringify(exceptions));
 assert.deepEqual(layoutWarnings,[],'editor geometry must stabilize throughout the smoke suite');
 console.log('Electron smoke passed: Source/Live scroll and tabs, footnotes, themes, block/table grips, LTR/RTL, comments, file drag, renames, attachments, exports, history, sync, failed saves and native close.');
 console.log('Scratch artifacts: '+scratch);
 }
} catch(error) {
 writeFileSync(path.join(scratch,'failure.txt'),String(error.stack??error)+'\nElectron stderr:\n'+stderr+'\nRenderer exceptions:\n'+JSON.stringify(exceptions,null,2));
 console.error(error);
 if(process.env.GITHUB_ACTIONS==='true') {
  const message=String(error.message??error).replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A');
  console.error(`::error title=Electron regression::${message}`);
 }
 if(ws?.readyState===1){const id=++seq;await Promise.race([sleep(3000),new Promise(resolve=>{pending.set(id,m=>{if(m.result?.data)writeFileSync(path.join(scratch,'failure.png'),Buffer.from(m.result.data,'base64'));resolve();});ws.send(JSON.stringify({id,method:'Page.captureScreenshot',params:{format:'png'}}));})]);}
 console.error('Failed artifacts: '+scratch);throw error;
} finally {
 ws?.close();if(!exited){child.kill('SIGTERM');await Promise.race([exit,sleep(1000)]);if(!exited)child.kill('SIGKILL');}await server.close();
}
