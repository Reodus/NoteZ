import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export async function checkDragMotion({ evaluate, rpc, until, sleep, vault }) {
  const ui = (expression) => evaluate(`(async()=>{${expression}})()`);
  const selector = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const tab = (path) => `.tab[title="${path}"]`;
  const mark = (path) => `.bookmark-item[title="${path}"]`;
  const file = (path) => `.tree-item[data-path="${path}"]`;
  const card = (path) => `.base-card[data-card-path="${path}"]`;
  const group = (name) => `.base-column[data-group="${name}"]`;
  const activeMotion = () => evaluate(`document.getAnimations().some(a=>a.playState==='running'&&['nz-drag-float','tab','bookmark-item','base-card','tree-item'].some(c=>a.effect?.target?.classList?.contains(c)))`);
  const projected = () => evaluate("!!document.querySelector('.nz-drag-projection')");
  const assertCarried = (sourceSelector) => ui(`
    const copy=${selector('.nz-drag-carry > ' + sourceSelector)};
    const source=window.motionTest.source;
    const origin=source.getBoundingClientRect(),carried=copy?.getBoundingClientRect();
    if(!carried||!source.classList.contains('nz-drag-projected')||
       Math.hypot(carried.left-origin.left,carried.top-origin.top)<8)
      throw Error('The complete item must follow the pointer before drop');
  `);
  const center = (sel) => evaluate(`(()=>{const b=${selector(sel)}.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
  const begin = (from, to) => ui(`
    const source=${selector(from)},target=${selector(to)},dataTransfer=new DataTransfer();
    const event=(el,type)=>{const r=el.getBoundingClientRect();return new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer,clientX:r.x+r.width/2+(type==='drop'?14:0),clientY:r.y+r.height/2+(type==='drop'?5:0)})};
    window.motionTest={source,target,event};
    source.dispatchEvent(event(source,'dragstart'));target.dispatchEvent(event(target,'dragover'));
  `);
  const finish = (drop = true) => ui(`
    const {source,target,event}=window.motionTest;
    if(${drop})target.dispatchEvent(event(target,'drop'));
    source.dispatchEvent(event(source,'dragend'));
    delete window.motionTest;
  `);
  const mouse = (type, point, pressed = false) => rpc('Input.dispatchMouseEvent', {
    type, ...point, ...(type === 'mouseMoved' ? { buttons: pressed ? 1 : 0 } : { button: 'left', clickCount: 1 }),
  });
  const md = (title, status) => `---\ntitle: ${title}\nstatus: ${status}\n---\n\nSample motion content.\n`;
  const base = 'filters: file.basename.startsWith("Motion")\nviews:\n  - type: board\n    name: Motion\n    groupBy: { property: status, direction: ASC }\n    order: [file.name, status]\n';
  await ui(`
    const {s,ipc}=window.test;
    await ipc.write('MotionA.md',${JSON.stringify(md('A', 'Now'))});
    await ipc.write('MotionB.md',${JSON.stringify(md('B', 'Next'))});
    await ipc.write('MotionFail.md',${JSON.stringify(md('Fail', 'Next'))});
    await ipc.write('Motion.base',${JSON.stringify(base)});
    await ipc.createFolder('MotionTarget');await ipc.createFolder('MotionBlocked');
    await s.refreshTree();await s.openNote('MotionA.md');await s.openNote('MotionB.md');
  `);

  let order = await evaluate('window.test.s.state.tabs.slice()');
  await begin(tab('MotionB.md'), tab('MotionA.md'));
  assert.ok(await projected(), 'adjacent tabs open a visual gap');
  await assertCarried(tab('MotionB.md'));
  assert.deepEqual(await evaluate('window.test.s.state.tabs.slice()'), order);
  await finish(false);
  assert.equal(await projected(), false);
  assert.deepEqual(await evaluate('window.test.s.state.tabs.slice()'), order);
  await sleep(200);
  await begin(tab('MotionB.md'), tab('MotionA.md'));
  await finish();
  await until(activeMotion, 'tab settles in its destination');
  order = await evaluate('window.test.s.state.tabs.slice()');
  assert.ok(order.indexOf('MotionB.md') < order.indexOf('MotionA.md'));
  await sleep(200);

  for (const reduced of ['setting', 'media query']) {
    if (reduced === 'setting') await ui("window.test.s.setPrefs('animations',false)");
    else await rpc('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await begin(tab('MotionB.md'), tab('MotionA.md'));
    assert.equal(await projected(), false);
    assert.equal(await evaluate("!!document.querySelector('.nz-drag-carry')"), false);
    await finish();
    await sleep(30);
    assert.equal(await activeMotion(), false);
    const next = await evaluate('window.test.s.state.tabs.slice()');
    assert.notDeepEqual(next, order, reduced + ' still reorders tabs');
    order = next;
    if (reduced === 'setting') await ui("window.test.s.setPrefs('animations',true)");
    else await rpc('Emulation.setEmulatedMedia', { features: [] });
  }
  await ui(`
    const b=await import('/src/core/bookmarks.ts');
    b.toggleBookmark({type:'file',path:'MotionA.md'});
    b.toggleBookmark({type:'file',path:'MotionB.md'});
    b.addGroup('Motion group');
    window.test.s.setSidebarTab('bookmarks');
  `);
  await begin(mark('MotionB.md'), mark('MotionA.md'));
  assert.ok(await projected(), 'bookmarks open a visual gap');
  await assertCarried(mark('MotionB.md'));
  await finish();
  await until(activeMotion, 'bookmark settles');
  await sleep(200);
  await ui(`${selector(mark('Motion group'))}.click()`);
  await begin(mark('MotionA.md'), mark('Motion group'));
  await finish();
  assert.ok(await ui("const {bookmarks}=await import('/src/core/bookmarks.ts');return bookmarks().find(b=>b.title==='Motion group').items.some(b=>b.path==='MotionA.md')"));
  assert.equal(await evaluate(`!!${selector(mark('MotionA.md'))}`), false, 'a collapsed destination stays collapsed');
  await sleep(200);
  await ui("window.test.s.setSidebarTab('files')");

  await ui("const {ipc}=window.test;window.test.motionRename=ipc.rename;ipc.rename=async()=>{throw Error('Injected move failure')}");
  await begin(file('MotionFail.md'), file('MotionBlocked'));
  assert.ok(await evaluate(`${selector(file('MotionBlocked'))}.classList.contains('drag-over')`));
  await finish();
  await sleep(200);
  assert.ok(existsSync(join(vault, 'MotionFail.md')));
  assert.equal(await activeMotion(), false);
  await ui('window.test.ipc.rename=window.test.motionRename');
  await ui(`
    await window.test.ipc.write('MotionTarget/Zed.md','Another file');
    await window.test.s.refreshTree();
    ${selector(file('MotionTarget'))}.click();
  `);
  await until(() => evaluate(`!!${selector(file('MotionTarget/Zed.md'))}`), 'expanded destination folder');
  await begin(file('MotionB.md'), file('MotionTarget'));
  await assertCarried(file('MotionB.md'));
  assert.ok(await projected(), 'an expanded folder opens a gap before the file is moved');
  assert.ok(existsSync(join(vault, 'MotionB.md')));
  await finish();
  await until(() => existsSync(join(vault, 'MotionTarget/MotionB.md')), 'confirmed file move');
  await until(activeMotion, 'file placement animates after success');
  await sleep(200);

  await ui("await window.test.s.openNote('Motion.base')");
  await until(() => evaluate(`!!${selector(card('MotionA.md'))}&&!!${selector(group('Next'))}`), 'board cards');
  await ui(`
    const {ipc}=window.test;
    window.test.motionWrite=ipc.write;
    ipc.write=async(path,...args)=>{if(path==='MotionFail.md')throw Error('Injected board write failure');return window.test.motionWrite(path,...args)};
  `);
  await begin(card('MotionFail.md'), group('Now'));
  assert.ok(await evaluate(`${selector(group('Now'))}.classList.contains('over')`));
  await finish();
  await sleep(240);
  assert.equal(await evaluate(`${selector(card('MotionFail.md'))}.closest('.base-column').dataset.group`), 'Next');
  assert.equal(await activeMotion(), false);
  await ui('window.test.ipc.write=window.test.motionWrite');
  await begin(card('MotionA.md'), group('Next'));
  await assertCarried(card('MotionA.md'));
  assert.equal(await evaluate(`document.querySelector('.base-board ${card('MotionA.md')}').closest('.base-column').dataset.group`), 'Now');
  await finish();
  await until(() => evaluate(`${selector(card('MotionA.md'))}.closest('.base-column').dataset.group==='Next'`), 'confirmed board move');
  await until(activeMotion, 'board card placement animates after success');
  await sleep(200);

  const originalWidth = await evaluate('window.test.s.prefs.sidebarWidth');
  const resize = '.sidebar > .resizer';
  const edge = await center(resize);
  const sign = await evaluate("document.documentElement.dir==='rtl'?-1:1");
  assert.ok(await evaluate(`document.elementFromPoint(${edge.x},${edge.y})?.matches('.sidebar > .resizer')`), 'sidebar resize handle is reachable');
  await mouse('mousePressed', edge);
  assert.ok(await evaluate("!!document.querySelector('.nz-resize-active')"), 'pressing the sidebar edge activates resizing');
  const resizeTo = { x: edge.x + sign * 42, y: edge.y };
  await mouse('mouseMoved', resizeTo, true);
  await sleep(140);
  const resizedWidth = await evaluate('window.test.s.prefs.sidebarWidth');
  assert.ok(Math.abs(resizedWidth - originalWidth - 42) <= 2, `resize follows pointer (width ${originalWidth} → ${resizedWidth})`);
  await mouse('mouseReleased', resizeTo);
  assert.equal(await evaluate("!!document.querySelector('.nz-resize-active')"), false);
  await ui(`window.test.s.setPrefs('sidebarWidth',${originalWidth})`);

  const blocks = 'Alpha block.\n\nBeta block.\n\nGamma block.\n';
  await ui(`
    const {s,ipc}=window.test;await ipc.write('BlockMotion.md',${JSON.stringify(blocks)});
    await s.openNote('BlockMotion.md');
  `);
  const pointAt = (text, bottom = false) => evaluate(`(()=>{
    const v=window.test.s.editorView(),p=v.state.doc.toString().indexOf(${JSON.stringify(text)});
    const r=v.coordsAtPos(p);
    return {x:r.left+5,y:${bottom ? 'r.bottom-1' : '(r.top+r.bottom)/2'}};
  })()`);
  await sleep(200);
  await mouse('mouseMoved', await pointAt('Alpha block'));
  await until(() => evaluate("!!document.querySelector('.cm-nz-handle.visible')"), 'block grip');
  const blockGrip = await center('.cm-nz-handle.visible');
  const blockEnd = await pointAt('Gamma block', true);
  await mouse('mousePressed', blockGrip);
  await mouse('mouseMoved', blockEnd, true);
  await until(() => evaluate("document.querySelector('.nz-drag-carry .cm-line')?.textContent.includes('Alpha block')"), 'rendered block before release');
  assert.equal(await evaluate("window.test.s.state.buffers['BlockMotion.md'].content"), blocks);
  await mouse('mouseReleased', blockEnd);
  await until(() => evaluate(`window.test.s.state.buffers['BlockMotion.md'].content.indexOf('Alpha block') > window.test.s.state.buffers['BlockMotion.md'].content.indexOf('Gamma block')`), 'block lands after the final paragraph');
  await until(() => evaluate("!document.querySelector('.nz-drag-float')"), 'floating block settles and clears');
  const modifier = process.platform === 'darwin' ? 4 : 2;
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: modifier, windowsVirtualKeyCode: 90 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: modifier, windowsVirtualKeyCode: 90 });
  assert.equal(await evaluate("window.test.s.state.buffers['BlockMotion.md'].content"), blocks);

  await ui(`
    const ed=document.querySelector('.cm-editor'),dataTransfer=new DataTransfer();
    dataTransfer.items.add(new File(['text'],'motion.txt'));
    ed.dispatchEvent(new DragEvent('dragover',{bubbles:true,dataTransfer}));
    if(!ed.classList.contains('nz-attachment-target'))throw Error('No valid attachment target feedback');
    ed.dispatchEvent(new DragEvent('dragleave',{bubbles:true,relatedTarget:document.body,dataTransfer}));
    if(ed.classList.contains('nz-attachment-target'))throw Error('Attachment target feedback leaked');
  `);

  await ui(`
    const {s,ipc}=window.test;
    await ipc.exportPdf('Audit.md','# First\\n\\n<!-- pagebreak -->\\n\\n# Second',[],${JSON.stringify(join(vault, 'Motion.pdf'))});
    await s.openNote('Motion.pdf');
  `);
  await until(() => evaluate("!!document.querySelector('.nz-pdf-scroll .page')"), 'PDF viewer pages');
  await sleep(240);
  await ui(`
    const {t}=await import('/src/core/i18n.ts');
    [...document.querySelectorAll('.nz-pdf-bar button')].find(b=>b.title===t('Pan page')).click();
  `);
  const page = '.nz-pdf-scroll';
  const start = await center(page);
  await mouse('mousePressed', start);
  const panTo = { x: start.x, y: start.y - 90 };
  await mouse('mouseMoved', panTo, true);
  await until(() => evaluate(`${selector(page)}.scrollTop>60`), 'PDF pans by pointer movement');
  await mouse('mouseReleased', panTo);
  assert.equal(await evaluate("!!document.querySelector('.nz-pdf-panning')"), false);
  await sleep(240);

  await ui(`
    const {setGraphOpen}=await import('/src/ui/GraphView.tsx');
    setGraphOpen(true);
    const original=CanvasRenderingContext2D.prototype.translate;
    CanvasRenderingContext2D.prototype.translate=function(x,y){if(this.canvas.closest('.graph-canvas'))window.motionGraphPoint={x,y};return original.call(this,x,y)};
    window.restoreGraphMotion=()=>CanvasRenderingContext2D.prototype.translate=original;
  `);
  await until(() => evaluate('!!window.motionGraphPoint'), 'graph canvas view');
  const corner = await evaluate(`(()=>{const r=document.querySelector('.graph-canvas canvas').getBoundingClientRect();return {x:r.left+30,y:r.top+40}})()`);
  const graphBefore = await evaluate('window.motionGraphPoint');
  await mouse('mousePressed', corner);
  const graphTo = { x: corner.x + 45, y: corner.y + 32 };
  await mouse('mouseMoved', graphTo, true);
  await until(() => evaluate(`Math.abs(window.motionGraphPoint.x-${graphBefore.x + 45})<2`), 'graph pans by pointer movement');
  await mouse('mouseReleased', graphTo);
  await ui(`
    window.restoreGraphMotion();
    const {setGraphOpen}=await import('/src/ui/GraphView.tsx');setGraphOpen(false);
    const {s}=window.test;
    for(const path of ['MotionA.md','MotionTarget/MotionB.md','Motion.base','Motion.pdf','BlockMotion.md'])await s.closeTab(path);
    await s.openNote('Audit.md');
  `);
  console.log('Drag motion: tab and bookmark projections, vault and board transactions, reduced motion, resize, PDF and graph pan');
}
