import assert from 'node:assert/strict';

export async function checkFootnoteComposer({ evaluate, rpc, until, sleep }) {
  const markdown = '# Footnotes\n\n'
    + Array.from({ length: 45 }, (_, i) => `Paragraph ${i}: ${i === 14 ? 'Target phrase فارسی' : 'English و فارسی'} in this note.\n\n`).join('')
    + 'Existing reference[^7].\n\n[^7]: Existing note.\n';
  const typst = '= Footnotes\n\nTarget phrase in Typst.\n';
  const body = 'توضیح فارسی and English\nAnother line.';
  const draft = 'document.querySelector(".nz-footnote-compose textarea")';
  const composerClosed = () => evaluate(`!${draft}`);
  const editor = 'window.test.s.editorView()';
  const content = () => evaluate(`${editor}.state.doc.toString()`);
  const scrollTop = () => evaluate(`${editor}.scrollDOM.scrollTop`);
  const text = (english) => `(await import('/src/core/i18n.ts')).t(${JSON.stringify(english)})`;
  const menuItem = (selector, label) => `((label)=>[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>(b.querySelector('.menu-label')??b).textContent.trim()===label))(${text(label)})`;
  const modifier = process.platform === 'darwin' ? 4 : 2;
  const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    const options = { key, code, windowsVirtualKeyCode, modifiers };
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', ...options, ...(key === 'Enter' && !(modifiers & 6) ? { text: '\r' } : {}) });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', ...options });
  };

  const open = async (method) => {
    if (method === 'toolbar') {
      await evaluate(`(async()=>{
        const title=${text('Insert…')};
        const button=()=>[...document.querySelectorAll('.pop-trigger')].find(el=>el.title===title&&!el.closest('.tb-hidden'));
        if(!button())document.querySelector('.tb-more').click();
        button().click();
        (${menuItem('.menu .menu-item', 'Footnote')}).click();
        document.querySelector('.tb-more.open')?.click();
      })()`);
    } else if (method === 'context menu') {
      await evaluate(`(()=>{
        const v=${editor},r=v.coordsAtPos(v.state.selection.main.to,-1);
        const clientX=r.left,clientY=(r.top+r.bottom)/2;
        document.elementFromPoint(clientX,clientY).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX,clientY}));
      })()`);
      const insertItem = menuItem('.context-menu .menu-item', 'Insert');
      await until(() => evaluate(`(async()=>!!(${insertItem}))()`), 'footnote context menu');
      await evaluate(`(async()=>{(${insertItem}).click()})()`);
      await evaluate(`(async()=>{(${menuItem('.context-menu .menu-item', 'Footnote')}).click()})()`);
    } else {
      await rpc('Input.insertText', { text: ' /footnote' });
      await until(() => evaluate(`(async()=>{
        const label=${text('Footnote')};
        return document.querySelector('.cm-tooltip-autocomplete [aria-selected=true]')?.textContent.includes(label);
      })()`), 'slash footnote suggestion');
      await sleep(100); // CodeMirror delays keyboard acceptance after showing the menu.
      await key('Enter', 'Enter', 13);
    }
    await until(() => evaluate(`document.activeElement===${draft}`), method + ' focuses the footnote draft');
  };
  const selectTarget = async (select = false) => {
    await evaluate(`(()=>{
      const v=${editor},target='Target phrase',pos=v.state.doc.toString().indexOf(target)+target.length;
      v.dispatch({selection:{anchor:${select ? 'pos-target.length' : 'pos'},head:pos}});
      v.scrollDOM.scrollTop=Math.max(0,v.lineBlockAt(pos).top-170);
      v.focus();
    })()`);
    await sleep(130);
  };
  const enterBody = async () => {
    const [first, second] = body.split('\n');
    await rpc('Input.insertText', { text: first });
    await key('Enter', 'Enter', 13, 8);
    await rpc('Input.insertText', { text: second });
    assert.equal(await evaluate(`${draft}.value`), body, 'Shift+Enter inserts a line break in the draft');
    assert.equal(await evaluate(`getComputedStyle(${draft}).direction`), 'rtl');
  };
  const assertInViewport = async () => {
    assert.ok(await evaluate(`(()=>{
      const r=${draft}.closest('.nz-footnote-compose').getBoundingClientRect(),s=${editor}.scrollDOM.getBoundingClientRect();
      return r.left >= s.left && r.right <= s.right && r.top >= s.top && r.bottom <= s.bottom;
    })()`), 'footnote editor fits inside the editor pane');
  };
  const undo = () => key('z', 'KeyZ', 90, modifier);

  await rpc('Emulation.setDeviceMetricsOverride', { width: 1240, height: 850, deviceScaleFactor: 1, mobile: false });
  await evaluate(`(async()=>{
    const {s,ipc}=window.test;await ipc.write('Footnotes.md',${JSON.stringify(markdown)});
    await ipc.write('Footnotes.typ',${JSON.stringify(typst)});
    s.setPrefs('layout','editor');await s.openNote('Footnotes.md');
  })()`);

  for (const mode of ['source', 'live']) {
    await evaluate(`window.test.s.setPrefs('editorMode',${JSON.stringify(mode)})`);
    for (const method of ['toolbar', 'context menu', 'slash']) {
      await selectTarget(method === 'toolbar');
      const before = await scrollTop();
      await open(method);
      const pending = await content();
      assert.equal(pending, method === 'slash' ? markdown.replace('Target phrase', 'Target phrase /footnote') : markdown);
      await assertInViewport();
      assert.equal(await evaluate("document.querySelectorAll('.nz-footnote-compose button').length"), 0);
      await key('Enter', 'Enter', 13);
      assert.equal(await composerClosed(), false, 'an empty draft stays open');
      await enterBody();
      assert.equal(await content(), pending, 'draft does not edit the document');
      await key('Enter', 'Enter', 13);
      assert.ok(await composerClosed());
      await sleep(130);
      const result = await content();
      assert.match(result, /Target phrase ?\[\^1\] فارسی/);
      assert.match(result, /Existing reference\[\^2\]/);
      assert.match(result, /\[\^1\]: توضیح فارسی and English\n {4}Another line\.\n\[\^2\]: Existing note\./);
      if (mode === 'source' && method === 'toolbar') {
        const generated = await evaluate(`window.test.ipc.generatedTypst('Footnotes.md', ${JSON.stringify(result)}, [])`);
        assert.match(generated, /#footnote\[[^\]]*توضیح فارسی and English[^\]]*Another line\./);
      }
      assert.ok(Math.abs(await scrollTop() - before) <= 3, 'submitting a footnote preserves the reading position');
      assert.ok(await evaluate(`(()=>{
        const v=${editor},p=v.state.selection.main.head;
        return v.hasFocus&&v.state.sliceDoc(p-4,p)==='[^1]';
      })()`), 'focus returns after the reference');
      await undo();
      assert.equal(await content(), pending, 'one Undo restores the document before footnote insertion');
      if (method === 'slash') await undo();
      assert.equal(await content(), markdown);
    }
  }

  for (const dismissal of ['Escape', 'outside pointer', 'tab switch']) {
    await selectTarget();
    await open(dismissal === 'Escape' ? 'slash' : 'toolbar');
    await rpc('Input.insertText', { text: 'Discard this draft' });
    if (dismissal === 'Escape') await key('Escape', 'Escape', 27);
    if (dismissal === 'outside pointer') await evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
    if (dismissal === 'tab switch') await evaluate("window.test.s.openNote('Audit.md')");
    assert.ok(await composerClosed(), dismissal + ' dismisses the draft');
    if (dismissal === 'tab switch') await evaluate("window.test.s.openNote('Footnotes.md')");
    if (dismissal === 'Escape') {
      assert.equal(await content(), markdown.replace('Target phrase', 'Target phrase /footnote'));
      await undo();
    }
    assert.equal(await content(), markdown);
  }

  await rpc('Emulation.setDeviceMetricsOverride', { width: 620, height: 850, deviceScaleFactor: 1, mobile: false });
  await evaluate("window.test.s.openNote('Footnotes.typ')");
  await selectTarget();
  await open('slash');
  await assertInViewport();
  await enterBody();
  await key('Enter', 'Enter', 13);
  const result = await content();
  assert.equal(result, typst.replace('Target phrase', `Target phrase #footnote[${body}]`));
  const preview = await evaluate(`window.test.ipc.renderPreview('Footnotes.typ',${JSON.stringify(result)},[])`);
  assert.deepEqual(preview.diagnostics.filter(({severity})=>severity==='error'), []);
  assert.ok(preview.pages.some(page=>page?.includes('<svg')), 'Typst footnote renders a page');
  await undo();
  assert.equal(await content(), typst.replace('Target phrase', 'Target phrase /footnote'));

  await evaluate(`(async()=>{
    const {s}=window.test;await s.closeTab('Footnotes.typ');await s.closeTab('Footnotes.md');
    await s.openNote('Audit.md');s.setPrefs('layout','split');s.setRightTab('preview');
  })()`);
  await rpc('Emulation.setDeviceMetricsOverride', { width: 947, height: 850, deviceScaleFactor: 1, mobile: false });
  await sleep(150);
  console.log('Footnotes: toolbar, context menu and slash in Source and Live; mixed text, numbering, Undo, dismissal and Typst preview');
}
