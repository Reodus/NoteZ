import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const calendar = 'core.daily-notes.calendar';

export async function checkWorkspace({ evaluate, rpc, until, reload, vault, scratch }) {
  const selector = (value) => `document.querySelector(${JSON.stringify(value)})`;
  const click = (value) => evaluate(`${selector(value)}.click()`);
  const exists = (value) => evaluate(`!!${selector(value)}`);
  const ui = (code) => evaluate(`(async()=>{const {s,ipc}=window.test;${code}})()`);
  const run = (id) => ui(`const {app}=await import('/src/core/app.ts');app.commands.run(${JSON.stringify(id)});`);
  const active = (path) => until(() => evaluate(`window.test.s.state.active===${JSON.stringify(path)}`), 'opened ' + path);
  const key = async (value, code, modifiers = 0) => {
    const params = {key:value, code, modifiers};
    if (value === 'Enter') params.windowsVirtualKeyCode = 13;
    await rpc('Input.dispatchKeyEvent', {type:'keyDown', ...params, ...(value==='Enter' ? {text:'\r',unmodifiedText:'\r'} : {})});
    await rpc('Input.dispatchKeyEvent', {type:'keyUp', ...params});
  };
  const viewport = (width) => rpc('Emulation.setDeviceMetricsOverride', {width, height:850, deviceScaleFactor:1, mobile:false});
  const capture = async (name) => {
    const shot = await rpc('Page.captureScreenshot', {format:'png'});
    writeFileSync(join(scratch, name+'.png'), Buffer.from(shot.data,'base64'));
  };

  const baseline = await ui(`return Object.fromEntries(['dailyFolder','dailyFormat','dailyTemplate','weekStart','pinnedPanels','layout','sidebarOpen','showTabBar'].map(k=>[k,s.prefs[k]]));`);
  await ui(`
    await ipc.write('DailyTemplate.md','# {{title}}\\n\\nDaily for {{date:YYYY-MM-DD}}.');
    await s.refreshTree();
    s.setPrefs('dailyFolder','Journal');s.setPrefs('dailyFormat','YYYY/MM/YYYY-MM-DD');
    s.setPrefs('dailyTemplate','DailyTemplate.md');s.setPrefs('weekStart',6);
    await s.closeTab('Audit.md');s.setSidebarOpen(false);s.setWorkspaceLayout('editor');
    const create=ipc.createNote;
    window.test.dailyCreates=0;
    ipc.createNote=async(path)=>{
      if(path.startsWith('Journal/')){window.test.dailyCreates++;await new Promise(r=>setTimeout(r,80));}
      return create(path);
    };
    window.test.originalCreate=create;
  `);
  const paths = await ui(`
    const {dailyPath}=await import('/src/plugins/daily.tsx');
    const today=new Date(), other=new Date(today.getFullYear(),today.getMonth(),today.getDate()===1?2:1);
    return {today:dailyPath(today),other:dailyPath(other)};
  `);
  const todayButton = '.rail-today';
  assert.equal(await ui('return s.state.tabs.length;'), 0);
  assert.equal(await evaluate(`${selector('.sidebar-slot')}.inert`), true);
  const ltr = await evaluate("document.documentElement.dir==='ltr'");
  assert.equal(await evaluate(`${selector('.workspace-rail')}.getBoundingClientRect().${ltr?'left':'right'}`), ltr ? 0 : 1280);
  await evaluate(`${selector(todayButton)}.focus()`);
  await key('Enter','Enter');
  await until(() => evaluate('window.test.dailyCreates===1'), 'keyboard starts daily note creation');
  await click(todayButton);
  await click(todayButton);
  await active(paths.today);
  assert.equal(await evaluate('window.test.dailyCreates'), 1, 'repeated activation creates exactly one note');
  const dailyFile = readFileSync(join(vault,paths.today),'utf8');
  const title = paths.today.split('/').at(-1).slice(0,-3);
  assert.equal(dailyFile, `# ${title}\n\nDaily for ${title}.`);
  await ui(`ipc.createNote=window.test.originalCreate;s.setWorkspaceLayout('preview');s.setGraphOpen(true);`);
  await key('d','KeyD',3);
  await until(() => evaluate("!window.test.s.graphOpen()&&window.test.s.prefs.layout==='split'&&!!window.test.s.editorView()"), 'shortcut restores editing from graph and PDF-only');
  assert.equal(readFileSync(join(vault,paths.today),'utf8'), dailyFile);

  await ui(`await s.closeTab(${JSON.stringify(paths.today)});s.setWorkspaceLayout('editor');`);
  await run('daily.calendar');
  await until(() => exists('.calendar-pane'), 'calendar opens without an active note');
  assert.equal(await ui('return s.state.active;'), null);
  assert.equal(await evaluate(`${selector('.cal-title')}.textContent.trim()`), await evaluate(`new Intl.DateTimeFormat(document.documentElement.lang==='fa'?'fa-IR':'en',{calendar:'gregory',month:'long',year:'numeric'}).format(new Date())`));
  assert.equal(await evaluate(`${selector('.cal-grid thead th:nth-child(2)')}.title`), await evaluate(`new Intl.DateTimeFormat(document.documentElement.lang==='fa'?'fa-IR':'en',{calendar:'gregory',weekday:'long'}).format(new Date(2024,0,6))`));
  const day = (path) => `.cal-day[data-note-path="${path}"]`;
  assert.equal(await exists(`${day(paths.today)}.today.has`), true);
  assert.equal(await exists(`${day(paths.other)}.has`), false);
  await click(day(paths.today));
  await active(paths.today);
  assert.equal(await exists(`${day(paths.today)}.active.has`), true);
  await click(day(paths.other));
  await active(paths.other);
  assert.equal(await exists(`${day(paths.other)}.active.has`), true);
  assert.match(readFileSync(join(vault,paths.other),'utf8'), /Daily for \d{4}-\d{2}-\d{2}/);
  await evaluate(`${selector('.tab.active')}.focus()`);
  const previous = ltr ? 'ArrowLeft' : 'ArrowRight';
  const next = ltr ? 'ArrowRight' : 'ArrowLeft';
  await key(previous,previous);
  await active(paths.today);
  assert.equal(await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(document.activeElement.title))))'), paths.today);
  await key(next,next);
  await active(paths.other);
  await ui(`s.setSidebarTab('files');`);
  await until(() => evaluate("Math.abs(document.querySelector('.sidebar-slot').getBoundingClientRect().width-window.test.s.prefs.sidebarWidth)<2"), 'sidebar finishes opening');
  await capture('workspace-desktop');

  const files = '[data-sidebar-pane="files"]';
  await ui(`s.setPrefs('showTabBar',false);`);
  assert.equal(await evaluate(`${selector('.tabs')}.hidden`), true);
  assert.equal(await exists('.mode-switch'), true);
  assert.equal(await exists('.workspace-panel-toggle'), true);
  await ui(`s.setPrefs('showTabBar',true);`);
  await viewport(780);
  await until(() => exists('.compact-workspace'), 'compact layout follows CSS viewport');
  assert.equal(await exists('.right-panel'), false);
  assert.equal(await evaluate(`${selector('.sidebar-slot')}.inert`), true);
  await click(files);
  assert.equal(await exists('.sidebar-slot.drawer-open'), true);
  await click('.workspace-panel-toggle');
  assert.equal(await exists('.sidebar-slot.drawer-open'), false);
  assert.equal(await exists('.right-panel'), true);
  assert.equal(await evaluate(`getComputedStyle(${selector('.right-panel')}).position`), 'absolute');
  await capture('workspace-compact');
  await evaluate(`${selector('.panel-manage')}.focus()`);
  await key('Escape','Escape');
  assert.equal(await exists('.right-panel'), false);
  assert.equal(await evaluate('document.activeElement.classList.contains("workspace-panel-toggle")'), true);
  assert.deepEqual(await ui(`return [s.prefs.layout,s.prefs.sidebarOpen];`), ['split',true]);
  await ui(`s.setWorkspaceLayout('editor');`);
  await run('daily.calendar');
  await until(() => exists('.calendar-pane'), 'calendar command opens a temporary drawer from editor-only');
  assert.equal(await ui('return s.prefs.layout;'), 'editor');
  await ui(`s.setWorkspaceLayout('split');`);
  await viewport(1280);
  await until(() => exists('.sidebar-slot.drawer-open'), 'desktop sidebar preference restored');

  await evaluate(`${selector('.panel-manage')}.focus()`);
  await key('Enter','Enter');
  await until(() => exists('.panel-manager'), 'keyboard opens tab management');
  const pin = (id) => `[data-panel-pin="${id}"]`;
  const row = (id) => `.panel-manager-row:has(${pin(id)})`;
  assert.equal(await evaluate(`${selector(pin(calendar))}.checked`), true);
  await click(`${row(calendar)} button:first-of-type`);
  await click(pin('styles'));
  assert.deepEqual(await ui('return s.prefs.pinnedPanels.slice();'), [calendar,'preview','styles']);
  await click(pin('styles'));
  await key('Escape','Escape');
  assert.equal(await exists('.panel-manager'), false);
  const tabOrder = () => evaluate("Array.from(document.querySelectorAll('[data-panel-tab]'),el=>el.dataset.panelTab)");
  await until(async () => (await tabOrder()).join(',') === `${calendar},preview`, 'reordered visible tabs');

  await ui(`
    const {app}=await import('/src/core/app.ts');
    const id='test.overflow';
    window.test.disposePanel=app.panels.add({id,title:'Very long optional plugin panel '.repeat(12),label:true,icon:'',mount:el=>{el.dataset.overflowFixture='';}});
    s.setPrefs('pinnedPanels',ids=>[...ids,id]);
  `);
  await click('.panel-more');
  await until(() => exists('.context-menu .menu-item'), 'overflow menu opens');
  const overflowItem = await evaluate(`Array.from(document.querySelectorAll('.context-menu .menu-item')).findIndex(el=>el.textContent.includes('Very long optional plugin panel'))`);
  assert.ok(overflowItem >= 0, 'a pinned tab that does not fit remains in the overflow menu');
  await click(`.context-menu .menu-entry:nth-child(${overflowItem+1}) .menu-item`);
  await until(() => exists('[data-overflow-fixture]'), 'overflow tab mounts');
  await ui(`window.test.disposePanel();s.setPrefs('pinnedPanels',ids=>ids.filter(id=>id!=='test.overflow'));`);

  await run('daily.calendar');
  await until(() => exists('.calendar-pane'), 'calendar active before plugin toggle');
  const enable = (value) => ui(`const {setBuiltinEnabled}=await import('/src/core/plugins.ts');await setBuiltinEnabled('core.daily-notes',${value});`);
  await enable(false);
  assert.equal(await exists(todayButton), false);
  assert.equal(await exists('.calendar-pane'), false);
  assert.equal(await ui('return s.rightTab();'), 'preview');
  assert.deepEqual(await ui('return s.prefs.pinnedPanels.slice();'), [calendar,'preview']);
  await enable(true);
  await until(async () => (await tabOrder()).join(',') === `${calendar},preview`, 're-enabled calendar keeps its position');
  await reload();
  await until(async () => (await tabOrder()).join(',') === `${calendar},preview`, 'tab order restored after UI reload');
  await ui(`for(const [key,value] of Object.entries(${JSON.stringify(baseline)}))s.setPrefs(key,value);s.setSidebarTab('files');`);
  console.log('Workspace: daily shortcut and creation, calendar localization, RTL/LTR rail, overlay drawers, panel overflow, pin order and reload');
}
