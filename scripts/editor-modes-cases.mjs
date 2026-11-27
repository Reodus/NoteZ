import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export async function checkEditorModes({ evaluate, rpc, until, vault, scratch }) {
  const initialTabs = await evaluate('window.test.s.state.tabs.slice()');
  const asset = 'عکس تیم.png';
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNYVf4OAAPeAhDhAzbvAAAAAElFTkSuQmCC', 'base64');
  writeFileSync(path.join(vault, asset), pixel);
  const caption = `![Caption](${asset})`;
  const tableProse = 'متن بعد از جدول';
  const suffix = '\n\n**Following paragraph** [[Other]]\n\n| Image |\n| --- |\n' +
    `| ![](${asset} "Table title") |\n${tableProse} با \`t\`.\n\n` +
    `![](<${asset}>) ![](عکس%20تیم.png)\n\n` +
    '`![Code](ignored image.png)`\n\nآخرین پاراگراف\n';
  const original = `# Images\n\n${caption}${suffix}`;
  const open = async (file, text) => {
    writeFileSync(path.join(vault, file), text);
    await evaluate(`window.test.s.openNote(${JSON.stringify(file)})`);
  };
  const prefs = (mode) => evaluate(`window.test.s.setPrefs('editorMode', ${JSON.stringify(mode)})`);
  const editorText = () => evaluate('window.test.s.editorView().state.doc.toString()');
  const imageCount = () => evaluate(`[...document.querySelectorAll('.editor img')].filter(i => i.complete && i.naturalWidth > 0).length`);
  const key = async (name, code, windowsVirtualKeyCode, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) await rpc('Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode, modifiers });
  };
  const mod = process.platform === 'darwin' ? 4 : 2;
  await evaluate(`window.test.s.setWorkspaceLayout('editor')`);
  await prefs('live');
  await open('EditorModes.md', original);
  await until(async () => (await imageCount()) === 4, 'mixed-language filename in body and table');
  assert.equal(await editorText(), original);
  const checkTableProse = async () => {
    const result = await evaluate(`(() => {
      const table = document.querySelector(".editor table");
      return {
        rows: table?.tBodies[0]?.rows.length,
        prose: [...document.querySelectorAll(".editor .cm-line")]
          .some(line => line.textContent.includes(${JSON.stringify(tableProse)})),
        insideTable: table?.textContent.includes(${JSON.stringify(tableProse)}),
      };
    })()`);
    assert.deepEqual(result, { rows: 1, prose: true, insideTable: false });
  };
  await checkTableProse();
  const afterProse = original.indexOf(tableProse) + tableProse.length;
  await evaluate(`(()=>{
    const v=window.test.s.editorView();
    v.dispatch({selection:{anchor:${afterProse}}});
    v.focus();
  })()`);
  await rpc('Input.insertText', { text: ' ادامه' });
  assert.equal(await editorText(), original.slice(0, afterProse) + ' ادامه' + original.slice(afterProse));
  await checkTableProse();
  await key('z', 'KeyZ', 90, mod);
  assert.equal(await editorText(), original);

  await evaluate(`document.querySelector('.cm-nz-lp-image .cm-nz-img-btn.edit').click()`);
  assert.equal(await evaluate('window.test.s.editorView().state.selection.main.head'), original.indexOf('Caption') + 'Caption'.length);
  const captionEdit = original.indexOf('Caption') + 'Caption'.length;
  await key('Backspace', 'Backspace', 8);
  assert.equal(await editorText(), original.slice(0, captionEdit - 1) + original.slice(captionEdit), 'Backspace changes only the preceding caption character');
  assert.ok(await evaluate(`window.test.s.editorView().contentDOM.textContent.includes('Following paragraph')`));
  await key('z', 'KeyZ', 90, mod);
  assert.equal(await editorText(), original);

  const close = original.indexOf(caption) + caption.length - 1;
  await evaluate(`window.test.s.editorView().dispatch({selection:{anchor:${close + 1}}})`);
  await key('Backspace', 'Backspace', 8);
  assert.equal(await editorText(), original.slice(0, close) + original.slice(close + 1));
  assert.ok(await evaluate(`window.test.s.editorView().contentDOM.textContent.includes('Following paragraph')`), 'incomplete image leaves following text visible');
  await rpc('Input.insertText', { text: ')' });
  assert.equal(await editorText(), original);

  // Newlines inside a valid CommonMark image cannot become an inline
  // CodeMirror replacement. Leaving the image must keep the suffix visible.
  const firstImage = original.indexOf('Caption');
  const multiline = original.replace('Caption', 'Cap\ntion').replace(`(${asset})`, '(<pixel.png>)');
  await evaluate(`(()=>{
    const v=window.test.s.editorView();
    v.dispatch({changes:{from:${firstImage}, to:${close + 1}, insert:${JSON.stringify(multiline.slice(firstImage, multiline.indexOf(suffix)))}}});
    v.dispatch({selection:{anchor:0}});
  })()`);
  assert.equal(await editorText(), multiline);
  assert.ok(await evaluate(`window.test.s.editorView().contentDOM.textContent.includes('Following paragraph')`));
  await key('z', 'KeyZ', 90, mod);
  assert.equal(await editorText(), original);
  await evaluate(`window.test.s.saveAll()`);
  assert.equal(readFileSync(path.join(vault, 'EditorModes.md'), 'utf8'), original);
  await evaluate(`(async()=>{const {s}=window.test;await s.closeTab('EditorModes.md');await s.openNote('EditorModes.md')})()`);
  assert.equal(await editorText(), original);

  await prefs('read');
  await until(() => evaluate(`!!document.querySelector('.cm-nz-read .nz-read-table')`), 'read-only table');
  await until(async () => (await imageCount()) === 4, 'images in formatted reading view');
  await checkTableProse();
  const read = await evaluate(`(()=>{
    const v=window.test.s.editorView();
    const start = v.state.doc.toString().indexOf('Following paragraph');
    v.dispatch({selection:{anchor:start,head:start+'Following paragraph'.length}});
    v.focus();
    return {readOnly:v.state.readOnly,editable:v.contentDOM.isContentEditable,
      selected:v.state.sliceDoc(start,v.state.selection.main.head),
      controls:!!document.querySelector('.editor .cm-nz-handle, .editor .nz-column-grip, .editor .cm-nz-img-btn.edit'),
      formatted:!v.contentDOM.textContent.includes('**Following paragraph**')};
  })()`);
  assert.deepEqual(read, { readOnly: true, editable: false, selected: 'Following paragraph', controls: false, formatted: true });
  await key('Backspace', 'Backspace', 8);
  await key('b', 'KeyB', 66, mod);
  await rpc('Input.insertText', { text: 'Blocked' });
  assert.equal(await editorText(), original);
  await evaluate(`(()=>{window.getSelection().removeAllRanges(); document.querySelector('.cm-nz-lp-link[data-target="Other"]').click()})()`);
  await until(() => evaluate(`window.test.s.state.active === 'Other.md'`), 'reading link navigation');
  await evaluate(`window.test.s.openNote('EditorModes.md')`);
  await until(() => evaluate('window.test.s.editorView()?.hasFocus'), 'reading view regained keyboard focus');
  await key('M', 'KeyM', 77, mod | 8);
  await until(() => evaluate(`window.test.s.prefs.editorMode==='live'`), 'keyboard returns from Read only to Live');
  assert.equal(await editorText(), original);

  const updated = original + '\nFrom disk\n';
  writeFileSync(path.join(vault, 'EditorModes.md'), updated);
  await prefs('read');
  await evaluate(`window.test.s.reloadFromDisk('EditorModes.md')`);
  assert.equal(await editorText(), updated);
  assert.equal(await evaluate(`window.test.s.isDirty('EditorModes.md')`), false);

  const outputs = Object.fromEntries(['html', 'docx', 'pdf', 'md'].map(ext => [ext, path.join(scratch, `spaced.${ext}`)]));
  const result = await evaluate(`(async()=>{
    const {ipc}=window.test, p='EditorModes.md', text=${JSON.stringify(original)}, outputs=${JSON.stringify(outputs)};
    const preview=await ipc.renderPreview(p,text,[]);
    return {pages:preview.pages.length, errors:preview.diagnostics.filter(d=>d.severity==='error'),
      html:await ipc.exportHtml(p,text,[],outputs.html),docx:await ipc.exportDocx(p,text,[],outputs.docx),
      pdf:await ipc.exportPdf(p,text,[],outputs.pdf).catch(error=>({error})),md:await ipc.exportMarkdown(p,text,[],outputs.md)};
  })()`);
  assert.ok(result.pages > 0 && !result.errors.length, JSON.stringify(result.errors));
  assert.ok(!result.pdf?.error, JSON.stringify(result.pdf?.error));
  for (const ext of ['html', 'docx', 'md']) assert.ok(!result[ext].some(w => /missing file/i.test(w)), JSON.stringify(result[ext]));
  const html = readFileSync(outputs.html, 'utf8');
  assert.ok(html.includes('data:image/png;base64,'));
  assert.ok(html.indexOf('</table>') >= 0 && html.indexOf(tableProse) > html.indexOf('</table>'),
    'HTML export keeps the paragraph after the table');
  assert.ok(readFileSync(outputs.docx).includes(Buffer.from('word/media/')));
  assert.ok(readFileSync(outputs.pdf).subarray(0, 5).equals(Buffer.from('%PDF-')));
  const markdown = readFileSync(outputs.md, 'utf8');
  assert.ok(markdown.includes('عکس%20تیم.png "Table title"'));
  assert.ok(markdown.includes(` |\n\n${tableProse}`), 'portable Markdown separates the prose for other Markdown readers');
  assert.ok(readFileSync(path.join(scratch, 'spaced_files', asset)).equals(pixel));

  const renamed = 'عکس تازه.png';
  await evaluate(`window.test.s.renameEntry(${JSON.stringify(asset)}, ${JSON.stringify(renamed)})`);
  const afterRename = readFileSync(path.join(vault, 'EditorModes.md'), 'utf8');
  assert.equal(afterRename, updated.replaceAll(asset, renamed).replaceAll('عکس%20تیم.png', 'عکس%20تازه.png'));
  await open('TypstRead.typ', '= First page\n#pagebreak()\n= Second page\n#pagebreak()\n= Last page\n');
  await until(() => evaluate(`!window.test.s.editorView() && document.querySelectorAll('.preview-scroll .page').length === 3`), 'rendered Typst Read only');
  await evaluate(`document.querySelector('.preview-scroll').focus()`);
  await key('M', 'KeyM', 77, mod | 8);
  await until(() => evaluate(`window.test.s.prefs.editorMode==='source' && !!window.test.s.editorView()`), 'keyboard returns to Typst Source');

  await open('PreviewScroll.md', Array.from({ length: 9 }, (_, i) => `## Page ${i + 1}\n\nA paragraph.\n\n<!-- pagebreak -->\n\n`).join(''));
  await evaluate(`window.test.s.setWorkspaceLayout('preview')`);
  await until(() => evaluate(`document.querySelectorAll('.preview-scroll .page').length >= 9`), 'long full-width preview');
  for (const width of [1280, 720]) {
    await rpc('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    const point = await evaluate(`(()=>{
      const el = document.querySelector('.preview-scroll');
      el.scrollTop = 0;
      const box = el.getBoundingClientRect();
      return {x:box.left+box.width/2,y:box.top+box.height/2};
    })()`);
    await rpc('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 380 });
    await until(() => evaluate(`document.querySelector('.preview-scroll').scrollTop > 0`), 'preview receives wheel scrolling');
    const scroll = await evaluate(`(()=>{
      const el = document.querySelector('.preview-scroll');
      el.scrollTop = el.scrollHeight;
      const last = el.lastElementChild.getBoundingClientRect(), box=el.getBoundingClientRect();
      return el.scrollTop > 0 && last.bottom <= box.bottom + 1 && box.bottom <= innerHeight;
    })()`);
    assert.ok(scroll, `preview scrolls to the last page at ${width}px`);
  }
  await open('PreviewDiagnostic.typ', '= Title\n\n#missing_variable\n');
  await until(() => evaluate(`!!document.querySelector('.preview-pane .diag.link')`), 'source-linked preview diagnostic');
  await evaluate(`document.querySelector('.preview-pane .diag.link').click()`);
  await until(() => evaluate(`(()=>{
    const v=window.test.s.editorView();
    return v?.state.doc.lineAt(v.state.selection.main.head).number === 3;
  })()`), 'diagnostic opens the editor at the error line');

  await rpc('Emulation.setDeviceMetricsOverride', { width: 1280, height: 850, deviceScaleFactor: 1, mobile: false });
  await evaluate(`(async()=>{const {s}=window.test;s.setWorkspaceLayout('editor');s.setPrefs('editorMode','live');await s.openNote('Audit.md');for(const tab of [...s.state.tabs])if(!${JSON.stringify(initialTabs)}.includes(tab))await s.closeTab(tab)})()`);
  console.log('Editor modes: image captions, spaced paths, exports and rename, formatted reading, paginated preview scrolling');
}
