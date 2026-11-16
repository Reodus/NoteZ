import assert from 'node:assert/strict';
/** Use the live editor; keep cursor at the top while scrolling, like a reader. */
export async function checkScroll(evaluate, sleep) {
 const result=await evaluate(`(async()=>{
  const {s}=window.test;
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  s.setPrefs('editorMode','source');await s.openNote('LongA.md');await wait(200);
  s.editorView().scrollDOM.scrollTop=1800;await wait(150);
  const before=s.editorView().scrollDOM.scrollTop;
  await s.openNote('LongB.md');await wait(100);s.editorView().scrollDOM.scrollTop=500;await wait(80);
  await s.openNote('LongA.md');await wait(200);
  const after=s.editorView().scrollDOM.scrollTop;
  await s.openNote('LongA.md',{line:101});await s.openNote('LongB.md');await wait(120);
  const unexpectedLine=s.editorView().state.doc.lineAt(s.editorView().state.selection.main.head).number;
  return {before,after,unexpectedLine};
 })()`);
 console.log('Scroll regression:',result);
 assert.ok(Math.abs(result.after-result.before)<5,'switching tabs must preserve the reader viewport');
 assert.equal(result.unexpectedLine,1,'a delayed jump must never affect another note');
 // Remounting the editor for an image tab must keep the same viewport,
 // including in Live mode with the cursor still outside the visible area.
 for(const mode of ['source','live']) {
  const remount=await evaluate(`(async()=>{const {s}=window.test;const wait=ms=>new Promise(r=>setTimeout(r,ms));s.setPrefs('editorMode',${JSON.stringify(mode)});await s.openNote('LongA.md');await wait(150);s.editorView().scrollDOM.scrollTop=2200;await wait(150);const visible=()=>{const v=s.editorView(),r=v.scrollDOM.getBoundingClientRect(),p=v.posAtCoords({x:r.left+120,y:r.top+35},false);const line=v.state.doc.lineAt(p);return line.text||v.state.doc.line(Math.min(v.state.doc.lines,line.number+1)).text};const before=s.editorView().scrollDOM.scrollTop,lineBefore=visible();await s.openNote('pixel.png');await wait(100);await s.openNote('LongA.md');await wait(200);return {before,after:s.editorView().scrollDOM.scrollTop,lineBefore,lineAfter:visible()}})()`);
  console.log('Scroll remount',mode,remount);
  assert.equal(remount.lineAfter,remount.lineBefore,`image remount loses ${mode} visible text`);
 }
 // An external edit in a hidden tab should map its saved anchor, not reset
 // its cursor/history and send the reader to the beginning of the note.
 const hidden=await evaluate(`(async()=>{const {s,ipc}=window.test;const wait=ms=>new Promise(r=>setTimeout(r,ms));s.setPrefs('editorMode','source');await s.openNote('LongA.md');await wait(150);s.editorView().scrollDOM.scrollTop=1800;await wait(150);const visible=()=>{const v=s.editorView(),r=v.scrollDOM.getBoundingClientRect(),p=v.posAtCoords({x:r.left+120,y:r.top+35},false);const line=v.state.doc.lineAt(p);return line.text||v.state.doc.line(Math.min(v.state.doc.lines,line.number+1)).text};const before=visible(),original=s.state.buffers['LongA.md'].content;await s.openNote('LongB.md');await ipc.write('LongA.md','Inserted above\\n\\n'+original);await s.reloadFromDisk('LongA.md');await s.openNote('LongA.md');await wait(200);return {before,after:visible()}})()`);
 assert.equal(hidden.after,hidden.before,'hidden disk edit must preserve visible text');
 // A slower old read must not steal the newly selected note.
 const active=await evaluate(`(async()=>{const {s,ipc}=window.test;const read=ipc.read;ipc.read=async p=>{if(p==='Slow.md')await new Promise(r=>setTimeout(r,120));return read(p)};try{const first=s.openNote('Slow.md');document.querySelector('.tab[title="LongB.md"]').click();await first;return s.state.active}finally{ipc.read=read}})()`);
 assert.equal(active,'LongB.md','older note reads must not steal navigation');
 await evaluate(`(async()=>{const {s}=window.test;await s.closeTab('LongA.md');await s.closeTab('LongB.md');await s.closeTab('Slow.md');await s.closeTab('pixel.png');await s.openNote('Audit.md');s.setPrefs('editorMode','live')})()`);await sleep(150);
}
