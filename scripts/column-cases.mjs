import assert from 'node:assert/strict';

export async function checkTableColumns({ evaluate, rpc, until, sleep }) {
  const ltr = '## English\n\n| Alpha | Beta | Gamma |\n| :---- | :--: | ----: |\n| same | other | same |\n';
  const rtl = '## فارسی\n\n| نخست | دوم | سوم |\n| ---: | :--- | :---: |\n| یک | دو | سه |\n';
  const wideColumn = (c) => `Column${c}WithoutInterwordWrapping`;
  const wide = ['# Wide', '', `| ${Array.from({length: 6}, (_, c) => wideColumn(c)).join(' | ')} |`,
    '| --- | --- | --- | --- | --- | --- |', '| 0 | 1 | 2 | 3 | 4 | 5 |', ''].join('\n');
  const content = () => evaluate('window.test.s.state.buffers[window.test.s.state.active].content');
  const mouse = (type, point) => rpc('Input.dispatchMouseEvent', {
    type, ...point, ...(type === 'mouseMoved' ? { buttons: 1 } : { button: 'left', clickCount: 1 }),
  });
  const key = async (key, code, modifiers = 0) => {
    const windowsVirtualKeyCode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : { Enter: 13, Escape: 27, ArrowDown: 40 }[key];
    const fields = { key, code, modifiers, windowsVirtualKeyCode };
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', ...fields, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', ...fields });
  };
  const info = (n) => evaluate(`(()=>{
    const table=document.querySelectorAll('.nz-edit-table table')[${n}];
    const a=table.closest('.nz-edit-table').querySelector('.nz-column-grip').getBoundingClientRect();
    const cells=[...table.tHead.rows[0].cells], b=cells.at(-1).getBoundingClientRect(), rtl=table.dir==='rtl';
    const middle=cells[1].getBoundingClientRect();
    return { rtl, start:{x:(a.left+a.right)/2,y:(a.top+a.bottom)/2},
      mid:{x:(middle.left+middle.right)/2,y:(middle.top+middle.bottom)/2},
      end:{x:rtl?b.left+5:b.right-5,y:(b.top+b.bottom)/2} };
  })()`);
  const results = (n) => evaluate(`(()=>{
    const table=document.querySelectorAll('.nz-edit-table table')[${n}];
    return [...table.rows].map(row=>[...row.cells].map(cell=>[cell.lastElementChild.dataset.raw,cell.style.textAlign]));
  })()`);
  const classGone = () => evaluate(`!document.querySelector('.nz-dragging-column, .nz-column-drop:not([hidden])')`);
  const move = async (start, end) => {
    await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start });
    await mouse('mousePressed', start);
    await mouse('mouseMoved', end);
  };
  const modifier = process.platform === 'darwin' ? 4 : 2;
  const history = async (redo = false) => {
    await evaluate('window.test.s.editorView().focus()');
    if (redo && process.platform !== 'darwin') await key('y', 'KeyY', modifier);
    else await key(redo ? 'Z' : 'z', 'KeyZ', modifier | (redo ? 8 : 0));
  };

  await evaluate(`(async()=>{const {s,ipc}=window.test;
    await ipc.write('Columns.md',${JSON.stringify(ltr + '\n' + rtl)});
    await ipc.write('WideColumns.md',${JSON.stringify(wide)});
    s.setPrefs('layout','editor');s.setPrefs('editorMode','live');await s.openNote('Columns.md');
  })()`);
  await until(() => evaluate(`document.querySelectorAll('.nz-edit-table').length===2`), 'column grips rendered');
  await evaluate(`(async()=>{const {s,c}=window.test,v=s.editorView(),pos=v.state.doc.toString().indexOf('same');
    await c.loadComments('Columns.md');v.dispatch({selection:{anchor:pos,head:pos+4}});await c.addComment();
    v.dispatch({selection:{anchor:0}});s.setPrefs('layout','editor');v.focus();
  })()`);
  await sleep(150);
  const gripsAligned = () => evaluate(`[...document.querySelectorAll('.nz-edit-table')].every(wrap => {
    const headers=[...wrap.querySelectorAll('thead th')];
    const grips=[...wrap.querySelectorAll('.nz-column-rail .nz-column-grip')];
    return grips.length===headers.length&&grips.every((grip,i)=>{
      const g=grip.getBoundingClientRect(),h=headers[i].getBoundingClientRect();
      return !grip.closest('th')&&g.bottom<=h.top+1&&Math.abs(g.x+g.width/2-h.x-h.width/2)<2;
    });
  })`);
  await until(gripsAligned, 'grips line up above both LTR and RTL tables');
  await evaluate("document.querySelector('.nz-edit-table th .nz-cell').style.minWidth='180px'");
  await until(gripsAligned, 'grips adjust when a header width changes');
  await evaluate("document.querySelector('.nz-edit-table th .nz-cell').style.minWidth=''");
  await until(gripsAligned, 'grips adjust after restoring the width');
  const initial = await content();
  const normalized = (original) => original.map(([a,b,c]) => [b,c,a]);
  const anchor = () => evaluate(`window.test.c.comments['Columns.md'][0].from.ch`);
  const firstAnchor = await anchor();
  for (const n of [0, 1]) {
    const before = await results(n);
    const { start, mid, end, rtl } = await info(n);
    assert.equal(rtl, n === 1, 'table direction is independent of UI language');
    const cellXs = () => evaluate(`[...document.querySelectorAll('.nz-edit-table table')[${n}].rows].map(row=>[...row.cells].map(c=>c.getBoundingClientRect().x))`);
    const hover = () => evaluate(`[...document.querySelectorAll('.nz-edit-table')[${n}].querySelectorAll('.nz-column-grip')].filter(b=>getComputedStyle(b).opacity==='1').map(b=>Number(b.dataset.column))`);
    await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', ...mid });
    assert.deepEqual(await hover(), [1], 'only the column under the pointer shows its grip');
    await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start });
    assert.deepEqual(await hover(), [0], 'moving into the grip row reveals only the matching grip');
    const beforeDrag = await cellXs();
    await mouse('mousePressed', start);
    await mouse('mouseMoved', { ...mid, x: mid.x + (rtl ? -8 : 8) });
    const direction = rtl ? -1 : 1;
    await until(async () => (await cellXs()).every((row, i) =>
      direction * (row[0] - beforeDrag[i][0]) > 10 && direction * (row[1] - beforeDrag[i][1]) < -10),
      'header and body cells visibly cross their neighbor while the pointer is down');
    assert.equal(await content(), initial, 'visual movement has not changed the document');
    assert.deepEqual(await hover(), [0], 'only the carried column shows its grip during a drag');
    const crossed = await cellXs();
    await mouse('mouseMoved', end);
    await until(async () => (await cellXs()).every((row, i) => direction * (row[0] - crossed[i][0]) > 10),
      'the same full column keeps moving before it is dropped');
    await mouse('mouseReleased', end);
    assert.deepEqual(await results(n), normalized(before), 'insert header, data and alignments together');
    assert.ok(await classGone());
    if (n === 0) {
      const line = (await content()).split('\n').find(line => line.includes('same'));
      assert.equal(await anchor(), line.lastIndexOf('same'), 'anchor follows the moved copy of duplicate text');
    }
    const reordered = await content();
    await history();
    assert.equal(await content(), initial, 'Undo reverts only the column move');
    assert.equal(await anchor(), firstAnchor);
    await history(true);
    assert.equal(await content(), reordered);
    await history();
  }

  const { start, end } = await info(0);
  for (const cancel of ['outside', 'original', 'Escape', 'tab switch']) {
    const destination = cancel === 'outside' ? { x: end.x, y: start.y - 45 } : end;
    await move(start, destination);
    if (cancel === 'Escape') await key('Escape', 'Escape');
    if (cancel === 'tab switch') await evaluate("window.test.s.openNote('WideColumns.md')");
    await mouse('mouseReleased', cancel === 'original' ? start : destination);
    if (cancel === 'tab switch') await evaluate("window.test.s.openNote('Columns.md')");
    assert.equal(await content(), initial, cancel + ' leaves the note unchanged');
    assert.ok(await classGone(), cancel + ' clears the drag indicator');
  }
  const beforeMenu = await results(0);
  const label = await evaluate(`(async()=>{
    const {s}=window.test;
    await s.openNote('WideColumns.md');
    await s.openNote('Columns.md');
    const grip=document.querySelector('.nz-column-grip');
    grip.focus({preventScroll:true});
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    if(document.activeElement!==grip) throw Error('Opening the tab must not steal focus from its column grip');
    return grip.getAttribute('aria-label');
  })()`);
  assert.equal(label, await evaluate('document.documentElement.lang') === 'fa' ? 'جابه‌جایی ستون ۱' : 'Move column 1');
  await key('Enter', 'Enter');
  await until(() => evaluate(`document.activeElement?.matches('.context-menu')`), 'column grip keyboard menu');
  await key('ArrowDown', 'ArrowDown');
  await key('Enter', 'Enter');
  assert.deepEqual(await results(0), beforeMenu.map(([a,b,c]) => [b,a,c]), 'keyboard menu moves the column one slot');
  await history();

  await rpc('Emulation.setDeviceMetricsOverride', {width: 680, height: 850, deviceScaleFactor: 1, mobile: false});
  await evaluate("window.test.s.openNote('WideColumns.md')");
  await until(() => evaluate(`(()=>{const s=document.querySelector('.nz-table-scroll');return s&&s.scrollWidth>s.clientWidth})()`), 'wide table overflows at narrow width');
  await until(gripsAligned, 'wide table grips are positioned before dragging');
  const wideStart = (await info(0)).start;
  const right = await evaluate(`document.querySelector('.nz-table-scroll').getBoundingClientRect().right`);
  await move(wideStart, {x: right - 4, y: wideStart.y});
  await until(() => evaluate(`document.querySelector('.nz-table-scroll').scrollLeft>100`), 'column drag autoscrolls the table');
  await until(() => evaluate(`(()=>{
    const wrap=document.querySelector('.nz-edit-table');
    const header=wrap.querySelector('th.nz-column-carried').getBoundingClientRect();
    const grip=wrap.querySelector('.nz-column-grip.dragging').getBoundingClientRect();
    return Math.abs(header.left+header.width/2-grip.left-grip.width/2)<2;
  })()`), 'dragged grip stays aligned with its moving column after horizontal scrolling');
  await key('Escape', 'Escape');
  await mouse('mouseReleased', {x: right - 4, y: wideStart.y});
  assert.equal(await content(), wide);
  await until(gripsAligned, 'stationary grips realign after cancelling the drag');
  await rpc('Emulation.clearDeviceMetricsOverride');

  await evaluate(`(async()=>{const {s}=window.test;await s.closeTab('WideColumns.md');await s.closeTab('Columns.md');
    await s.openNote('Audit.md');s.setPrefs('layout','split');s.setRightTab('preview');
  })()`);
  console.log('Live table columns: LTR/RTL movement before drop, per-column grips, duplicate anchors, Undo/Redo, cancellation, keyboard and autoscroll');
}
