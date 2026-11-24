import assert from 'node:assert/strict';

const wait = 'ms => new Promise(resolve => setTimeout(resolve, ms))';
const visibleLine = `v => {
  const r = v.scrollDOM.getBoundingClientRect();
  const pos = v.posAtCoords({x: r.left + r.width / 2, y: r.top + 35}, false);
  const line = v.state.doc.lineAt(pos);
  return line.text || v.state.doc.line(Math.min(v.state.doc.lines, line.number + 1)).text;
}`;

export async function checkScroll(evaluate, sleep) {
  for (const mode of ['source', 'live']) {
    const result = await evaluate(`(async()=>{
      const {s,ipc}=window.test,wait=${wait},visible=${visibleLine};
      s.setPrefs('editorMode',${JSON.stringify(mode)});
      await s.openNote('LongA.md');await wait(200);
      const v=s.editorView();
      v.scrollDOM.scrollTop=1800;await wait(150);
      const before=v.scrollDOM.scrollTop,lineBefore=visible(v);
      await s.openNote('LongB.md');await wait(100);v.scrollDOM.scrollTop=500;await wait(80);
      await s.openNote('LongA.md');await wait(200);
      const after=v.scrollDOM.scrollTop,lineAfter=visible(v);

      await s.openNote('LongB.md');await s.openNote('LongA.md');
      v.scrollDOM.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:360}));
      v.scrollDOM.scrollTop=360;await wait(150);
      const manualScrollTop=v.scrollDOM.scrollTop;

      // A jump issued while the destination viewport is being restored wins.
      await s.openNote('LongB.md');await s.openNote('LongA.md');s.goToLine(101);await wait(180);
      const jumpLine=v.state.doc.lineAt(v.state.selection.main.head).number;
      const scrollAfterJump=v.scrollDOM.scrollTop;
      const jumpRect=v.coordsAtPos(v.state.selection.main.head);
      const viewportRect=v.scrollDOM.getBoundingClientRect();
      const jumpVisible=!!jumpRect&&jumpRect.top>=viewportRect.top&&jumpRect.bottom<=viewportRect.bottom;
      await s.openNote('LongA.md',{line:150});await s.openNote('LongB.md');await wait(120);
      const unexpectedLine=v.state.doc.lineAt(v.state.selection.main.head).number;

      await s.openNote('LongA.md');await wait(150);v.scrollDOM.scrollTop=2200;await wait(150);
      const remountBefore=visible(v);
      await s.openNote('pixel.png');await wait(100);await s.openNote('LongA.md');await wait(200);
      const remountAfter=visible(s.editorView());

      const original=s.state.buffers['LongA.md'].content;
      const editBefore=visible(s.editorView());
      await s.openNote('LongB.md');
      await ipc.write('LongA.md','Inserted above\\n\\n'+original);await s.reloadFromDisk('LongA.md');
      await s.openNote('LongA.md');await wait(200);
      const editAfter=visible(s.editorView());
      // Restore the fixture for the next mode, after closing the mapped state.
      await s.closeTab('LongA.md');await ipc.write('LongA.md',original);
      await s.closeTab('LongB.md');await s.closeTab('pixel.png');
      return {before,after,lineBefore,lineAfter,manualScrollTop,jumpLine,scrollAfterJump,jumpVisible,unexpectedLine,remountBefore,remountAfter,editBefore,editAfter};
    })()`);
    console.log('Scroll regression', mode, result);
    assert.ok(Math.abs(result.after - result.before) < 5, mode + ': tab return preserves the viewport');
    assert.equal(result.lineAfter, result.lineBefore, mode + ': tab return preserves visible text');
    assert.ok(result.manualScrollTop > 0 && result.manualScrollTop < result.before / 2, mode + ': user scroll takes priority');
    assert.equal(result.jumpLine, 101);
    assert.ok(result.jumpVisible && result.scrollAfterJump > result.before, mode + ': explicit line jump brings its target into view');
    assert.equal(result.unexpectedLine, 1, 'a delayed jump must never affect another note');
    assert.equal(result.remountAfter, result.remountBefore, mode + ': image remount preserves visible text');
    assert.equal(result.editAfter, result.editBefore, mode + ': hidden disk edit preserves visible text');
  }

  // A slower old read must not steal the newly selected note.
  const active = await evaluate(`(async()=>{
    const {s,ipc}=window.test,read=ipc.read;
    await s.openNote('LongB.md');
    ipc.read=async p=>{if(p==='Slow.md')await new Promise(r=>setTimeout(r,120));return read(p)};
    try{
      const first=s.openNote('Slow.md');
      document.querySelector('.tab[title="LongB.md"]').click();
      await first;return s.state.active;
    }finally{ipc.read=read}
  })()`);
  assert.equal(active, 'LongB.md', 'older note reads must not steal navigation');
  await evaluate(`(async()=>{
    const {s}=window.test;await s.closeTab('LongB.md');await s.closeTab('Slow.md');
    await s.openNote('Audit.md');s.setPrefs('editorMode','live');
  })()`);
  await sleep(150);
}
