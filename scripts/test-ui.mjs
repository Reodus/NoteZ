// Isolated Electron/CDP regression suite. Linux CI: xvfb-run -a npm run test:ui.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { createServer } from 'vite';
import { checkScroll } from './scroll-cases.mjs';
const scratch=mkdtempSync(path.join(tmpdir(),'notez-ui-')),vault=path.join(scratch,'vault');
mkdirSync(vault);mkdirSync(path.join(scratch,'second'));
const fixture='---\ntitle: Audit\n---\n\n# English\n\nAlpha paragraph.\n\nBeta destination.\n\n- [ ] English task\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\n# فارسی\n\nسلام دنیا، این یک پاراگراف است.\n\n- [ ] کار فارسی\n\n| نام | مقدار |\n| --- | --- |\n| یک | دو |\n';
writeFileSync(path.join(vault,'Audit.md'),fixture);writeFileSync(path.join(vault,'Other.md'),'Other note. [[Audit]]\n');
for(const name of ['LongA.md','LongB.md','Slow.md'])writeFileSync(path.join(vault,name),Array.from({length:400},(_,i)=>`Paragraph ${i}: long note content for scrolling.\n`).join('\n'));
writeFileSync(path.join(vault,'pixel.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9sAAAAASUVORK5CYII=','base64'));
const server=await createServer({server:{host:'127.0.0.1',port:0,strictPort:false},logLevel:'error'});await server.listen();
const child=spawn(electron,['.', '--remote-debugging-port=0','--disable-gpu','--ozone-platform=x11','--disable-background-timer-throttling','--disable-renderer-backgrounding',...(process.env.CI || process.getuid?.()===0?['--no-sandbox']:[]),vault,'Audit.md'],{env:{...process.env,XDG_CONFIG_HOME:path.join(scratch,'config'),NOTEZ_DEV_URL:server.resolvedUrls.local[0]},stdio:['ignore','pipe','pipe']});
let stderr='',exited=false;const exit=new Promise(resolve=>child.once('exit',code=>{exited=true;resolve(code);}));child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',()=>{});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(80);}throw Error('Timed out: '+label+'\n'+stderr.slice(-2000));}
let ws;const pending=new Map();let seq=0;const exceptions=[];
try {
 await until(()=>/DevTools listening on ws:/.test(stderr),'debugger startup');
 const port=/DevTools listening on ws:\/\/[^:]+:(\d+)/.exec(stderr)[1];
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}else if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);else if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')console.error('renderer:',JSON.stringify(m.params.args.map(a=>a.description??a.value)));};
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{if(process.env.UI_DEBUG)console.log('CDP',method);const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},25000);pending.set(id,m=>{clearTimeout(timer);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await rpc('Runtime.enable');await rpc('Page.bringToFront');await rpc('Emulation.setFocusEmulationEnabled',{enabled:true});
 await until(()=>evaluate(`(async()=>{const s=await import('/src/core/store.ts');return !!s.editorView() && s.state.active==='Audit.md'})()`),'editor ready');
 if(process.env.NOTEZ_TEST_LANGUAGE==='fa'){
  await evaluate(`(()=>{const p=JSON.parse(localStorage.getItem('notez.prefs.v1')||'{}');localStorage.setItem('notez.prefs.v1',JSON.stringify({...p,uiLanguage:'fa'}))})()`);await rpc('Page.reload');
  await until(()=>evaluate(`(async()=>{const s=await import('/src/core/store.ts');return document.documentElement.lang==='fa'&&!!s.editorView()&&s.state.active==='Audit.md'})()`),'Persian UI ready');
 }
 await evaluate(`(async()=>{const s=await import('/src/core/store.ts'),c=await import('/src/core/comments.ts'),{ipc}=await import('/src/core/ipc.ts');window.test={s,c,ipc};window.testErrors=[];window.addEventListener('error',e=>window.testErrors.push(e.message));s.setPrefs('checkUpdates',false);s.setPrefs('snapshotDaily',false);s.setPrefs('updateLinks','always');s.setPrefs('confirmDelete',false);s.setPrefs('deleteToTrash',false);await c.loadComments(s.state.active)})()`);
 await checkScroll(evaluate,sleep);
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
 // a grip on the actual LTR/RTL edge without covering cells.
 for(const n of [0,1]) {
  await evaluate(`(()=>{const v=window.test.s.editorView();v.dispatch({selection:{anchor:0}});const table=document.querySelectorAll('.nz-edit-table')[${n}];table.scrollIntoView({block:'center'})})()`);await sleep(300);
  const rect=await evaluate(`(()=>{const r=document.querySelectorAll('.nz-edit-table')[${n}].getBoundingClientRect();return {left:r.left,right:r.right,top:r.top}})()`);
  await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.left+15,y:rect.top+15});await sleep(300);
  const h=await evaluate(`(()=>{const h=document.querySelector('.cm-nz-handle.visible');if(!h)throw Error('No rendered table handle');const r=h.getBoundingClientRect();return {left:r.left,right:r.right}})()`);
  assert.ok(n===0?h.right<=rect.left:h.left>=rect.right,`table ${n} grip overlaps widget: ${JSON.stringify({rect,h})}`);
  const shot=await rpc('Page.captureScreenshot',{format:'png'});writeFileSync(path.join(scratch,`table-${n}.png`),Buffer.from(shot.data,'base64'));
 }
 // Escape cancels an active pointer drag and removes its global cursor state.
 const cancelGrip=await hover('Alpha');
 const scrollBefore=await evaluate(`({top:window.test.s.editorView().scrollDOM.scrollTop,text:window.test.s.editorView().state.doc.toString(),bottom:window.test.s.editorView().scrollDOM.getBoundingClientRect().bottom})`);
 await rpc('Input.dispatchMouseEvent',{type:'mousePressed',x:cancelGrip.x,y:cancelGrip.y,button:'left',clickCount:1});
 await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:cancelGrip.x+30,y:scrollBefore.bottom-4,buttons:1});
 await sleep(250);assert.ok(await evaluate(`window.test.s.editorView().scrollDOM.scrollTop`)>scrollBefore.top,'drag autoscroll');
 await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
 await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:cancelGrip.x+30,y:cancelGrip.y+30,button:'left',clickCount:1});
 assert.equal(await evaluate(`document.body.classList.contains('nz-dragging-block')`),false);
 assert.equal(await evaluate(`window.test.s.editorView().state.doc.toString()`),scrollBefore.text,'cancel must retain document');
 await evaluate(`(async()=>{const {s,ipc}=window.test;await s.saveAll();await ipc.createFolder('folder');await s.renameEntry('Audit.md','Renamed.md');await s.moveEntry('Renamed.md','folder');await s.renameEntry('folder','archive');await s.saveAll();await s.openNote('Other.md');const tabs=document.querySelectorAll('.tab'),dataTransfer=new DataTransfer();tabs[1].dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));tabs[0].dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer}));tabs[0].dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));if(s.state.tabs[0]!=='Other.md')throw Error('Tab reorder failed');await s.openNote('archive/Renamed.md');const section=await ipc.noteSection('Other.md','Renamed');if(section?.path!=='archive/Renamed.md')throw Error('Renamed link no longer resolves')})()`);
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
 console.log('Electron smoke passed: block/table grips, pointer drag/autoscroll/cancel, LTR/RTL modes and widths, comments, tabs, file drag, renames, attachments, exports, history, sync, failed saves and native close.');
 console.log('Scratch artifacts: '+scratch);
} catch(error) {
 console.error(error);
 if(ws?.readyState===1){const id=++seq;await Promise.race([sleep(3000),new Promise(resolve=>{pending.set(id,m=>{if(m.result?.data)writeFileSync(path.join(scratch,'failure.png'),Buffer.from(m.result.data,'base64'));resolve();});ws.send(JSON.stringify({id,method:'Page.captureScreenshot',params:{format:'png'}}));})]);}
 console.error('Failed artifacts: '+scratch);throw error;
} finally {
 ws?.close();if(!exited){child.kill('SIGTERM');await Promise.race([exit,sleep(1000)]);if(!exited)child.kill('SIGKILL');}await server.close();
}
