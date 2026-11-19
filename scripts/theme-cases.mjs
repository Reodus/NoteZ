import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function checkDocumentThemes({ evaluate, rpc, until, vault }) {
  const markdown = '---\ntitle: Theme test\n# Keep this comment\nlang: en\n---\n\n# Paper\n\nMixed English و فارسی.\n';
  const typst = '= Paper\n\nMixed English و فارسی.\n';
  const status = `[...document.querySelectorAll('.sb-item')].some(el => el.textContent.includes(NAME))`;
  const page = `document.querySelector('.preview-pane .page img')`;
  const selectCard = async (name) => {
    const card = `[...document.querySelectorAll('.theme-card')].find(el => el.querySelector('.theme-name')?.textContent.trim().startsWith(${JSON.stringify(name)}))`;
    await evaluate(`(async()=>{const { app }=await import('/src/core/app.ts');app.commands.run('doc.themes')})()`);
    await until(() => evaluate(`!!(${card})`), name + ' theme card');
    await evaluate(`(${card}).click()`);
  };
  const choose = async (name) => {
    await selectCard(name);
    await until(() => evaluate(`!document.querySelector('.theme-grid') && ${status.replace('NAME', JSON.stringify(name))}`), name + ' theme status');
  };
  const pageFor = async (name, previous = '') => {
    await until(() => evaluate(`(async()=>{const {preview}=await import('/src/core/render.ts');const p=preview(),img=${page};return p.path===${JSON.stringify(name)}&&!p.busy&&!!img?.naturalWidth&&img.src!==${JSON.stringify(previous)}})()`), 'fresh preview of ' + name);
    return evaluate(`${page}.src`);
  };
  const svg = (url) => evaluate(`fetch(${JSON.stringify(url)}).then(response=>response.text())`);
  const reopen = (name) => evaluate(`(async()=>{const {s}=window.test;await s.closeTab(${JSON.stringify(name)});await s.openNote(${JSON.stringify(name)})})()`);
  const content = (name) => evaluate(`window.test.s.state.buffers[${JSON.stringify(name)}].content`);

  await evaluate(`(async()=>{const {s,ipc}=window.test;
    await ipc.write('Themes.md',${JSON.stringify(markdown)});await ipc.write('Themes.typ',${JSON.stringify(typst)});
    s.setRightTab('preview');s.setPrefs('layout','preview');await s.openNote('Themes.md');
  })()`);
  assert.equal(await evaluate('window.test.s.editorView()===null'), true);
  for (const [name, original] of [['Themes.md', markdown], ['Themes.typ', typst]]) {
    await evaluate(`window.test.s.openNote(${JSON.stringify(name)})`);
    const before = await pageFor(name);
    const originalSvg = await svg(before);
    await choose('Academic');
    const changed = await pageFor(name, before);
    assert.notEqual(await svg(changed), originalSvg, 'Academic must change the rendered SVG');
    const themed = await content(name);
    if (name.endsWith('.typ')) assert.equal(themed, '// theme: academic\n' + original);
    else {
      assert.match(themed, /\ntheme: academic\n/);
      assert.equal(themed.replace(/^theme: academic\n/m, ''), original);
    }
    await until(() => readFileSync(join(vault, name), 'utf8') === themed, name + ' autosave');
    await reopen(name);
    assert.equal(await content(name), themed);
    const current = await pageFor(name);
    await choose('Default');
    assert.equal(await svg(await pageFor(name, current)), originalSvg, 'Default must restore the original rendering');
    assert.equal(await content(name), name.endsWith('.typ') ? '// theme: default\n' + original : original);
  }

  await evaluate(`(async()=>{
    const {s,ipc}=window.test,academic=await ipc.theme('academic'),noteTheme=ipc.noteTheme;
    const pending=new Promise(resolve=>window.test.releaseTheme=()=>{ipc.noteTheme=noteTheme;resolve(academic)});
    ipc.noteTheme=(path,text)=>{
      if(path==='Themes.md'&&text.includes('theme: academic')) { window.test.themePending=true;return pending; }
      return noteTheme(path,text);
    };
    await s.openNote('Themes.md');
  })()`);
  await selectCard('Academic');
  await until(() => evaluate('window.test.themePending===true'), 'first tab awaiting its theme');
  await evaluate("window.test.s.openNote('Themes.typ')");
  await pageFor('Themes.typ');
  await until(() => evaluate(status.replace('NAME', '"Default"')), 'new tab theme status');
  await evaluate('window.test.releaseTheme()');
  assert.ok(await evaluate(status.replace('NAME', '"Default"')), 'stale theme response must not overwrite the new tab');
  await evaluate("window.test.s.openNote('Themes.md')");
  await choose('Default');

  await evaluate(`(async()=>{const {s}=window.test;await s.closeTab('Themes.typ');await s.openNote('Themes.md');s.setPrefs('layout','split')})()`);
  await choose('Academic');
  await evaluate('window.test.s.editorView().focus()');
  const modifiers = process.platform === 'darwin' ? 4 : 2;
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers });
  assert.equal(await content('Themes.md'), markdown, 'Undo the theme as one editor transaction');

  await evaluate(`(async()=>{const {s}=window.test;await s.closeTab('Themes.md');await s.openNote('Audit.md')})()`);
  console.log('Document themes: Preview Only SVG, Markdown and Typst autosave/reopen, Default, Split Undo');
}
