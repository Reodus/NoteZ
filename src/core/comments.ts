import { createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { app, notify } from './app';
import { ipc, isNotePath } from './ipc';
import { editorView, state, setPrefs, setRightTab } from './store';
import { t } from './i18n';
import { onVaultFs } from './native';
import { NoteComment, point, reanchor } from './commentAnchors';
export type { NoteComment } from './commentAnchors';
export const COMMENTS_PANEL = 'core.comments.pane';
export const [comments, setComments] = createStore<Record<string, NoteComment[]>>({});
export const [focusedComment, setFocusedComment] = createSignal<string | null>(null);
const loads = new Map<string, Promise<void>>();
const dirty = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let epoch = 0;
let writes = Promise.resolve();
const storage = (p: string) => `.notez/comments/${p}.json`;
function changed(path: string) { app.events.emit('comments:changed', { path }); }
export async function flushComments() {
  await Promise.all([...loads.values()]);
  const failures: unknown[] = [];
  for (const path of dirty) {
    clearTimeout(timers.get(path)); timers.delete(path); dirty.delete(path);
    const data = JSON.stringify({ version: 1, note: path, comments: comments[path] ?? [] }, null, 2);
    writes = writes.then(() => ipc.write(storage(path), data)).catch(e => {
      dirty.add(path); failures.push(e); notify(t('Comments not saved: {error}', { error: e }), 'error');
    });
  }
  await writes;
  if (failures.length) throw failures[0];
}
function save(path: string) {
  dirty.add(path); clearTimeout(timers.get(path));
  timers.set(path, setTimeout(() => void flushComments().catch(() => {}), 300));
}
export function replaceComments(path: string, list: NoteComment[], emit = true) {
  if (!comments[path]) return;
  if (JSON.stringify(comments[path]) === JSON.stringify(list)) return;
  setComments(path, list); save(path); if (emit) changed(path);
}
export async function loadComments(path: string, refresh = false) {
  if (!isNotePath(path) || (!refresh && comments[path]) || (refresh && dirty.has(path))) return;
  const snapshot = JSON.stringify(comments[path]);
  if (loads.has(path)) return loads.get(path);
  const generation = epoch;
  const task = (async () => {
    let list: NoteComment[] = [];
    try {
      const data = JSON.parse(await ipc.read(storage(path)));
      if (data.version !== 1 || !Array.isArray(data.comments)) throw new Error('Invalid comments file');
      list = data.comments;
    } catch (e) {
      // A missing sidecar is normal; other read/parse failures must not be overwritten.
      if (!/not found|no such file|cannot find/i.test(String(e))) {
        notify(t('Comments not loaded: {error}', { error: e }), 'error'); return;
      }
    }
    if (generation !== epoch || (refresh && (dirty.has(path) || snapshot !== JSON.stringify(comments[path])))) return;
    const text = state.buffers[path]?.content;
    const anchored = text === undefined ? list : list.map(c => reanchor(c, text));
    if (JSON.stringify(comments[path]) !== JSON.stringify(anchored)) { setComments(path, anchored); changed(path); }
    if (JSON.stringify(list) !== JSON.stringify(anchored)) save(path);
  })().finally(() => { if (generation === epoch) loads.delete(path); });
  loads.set(path, task); return task;
}
export function showComments(id?: string) {
  if (id) setFocusedComment(id);
  if (!app.panels.items().some(p => p.id === COMMENTS_PANEL)) return;
  setPrefs('layout', 'split'); setRightTab(COMMENTS_PANEL);
}
export async function addComment(reattach?: string) {
  const path = state.active, view = editorView();
  if (!path || !view || !isNotePath(path)) return;
  await loadComments(path);
  if (!comments[path] || state.active !== path || editorView() !== view) return;
  let { from, to } = view.state.selection.main;
  if (from === to) { const l = view.state.doc.lineAt(from); from = l.from; to = l.to; }
  const text = view.state.doc.toString();
  const anchor = { from: point(text, from), to: point(text, to), quote: text.slice(from, to), orphaned: false };
  const id = reattach ?? crypto.randomUUID(), now = new Date().toISOString();
  replaceComments(path, reattach ? comments[path].map(c => c.id === id ? { ...c, ...anchor, updated: now } : c) : [...comments[path], { id, ...anchor, body: '', created: now, updated: now, resolved: false, replies: [] }]);
  showComments(id);
}
export function patchComment(path: string, id: string, patch: Partial<NoteComment>) {
  replaceComments(path, (comments[path] ?? []).map(c => c.id === id ? { ...c, ...patch, updated: new Date().toISOString() } : c));
}
export function removeComment(path: string, id: string) { replaceComments(path, (comments[path] ?? []).filter(c => c.id !== id)); }
export async function copyAsPrompt(path = state.active) {
  if (!path) return;
  await loadComments(path);
  const list = (comments[path] ?? []).filter(c => !c.resolved).sort((a,b) => a.from.line - b.from.line);
  await navigator.clipboard.writeText(`Review comments on ${path}:\n\n` + list.map(c => `### L${c.from.line}–${c.to.line}${c.orphaned ? ' (orphaned)' : ''}\n${c.quote.split('\n').map(l => '> ' + l).join('\n')}\n\n${c.body}${c.replies.map(r => '\n\nReply: ' + r.body).join('')}`).join('\n\n'));
}
export function renameComments(from: string, to: string) {
  for (const p of Object.keys(comments)) if (comments[p] && (p === from || p.startsWith(from + '/'))) {
    const dest = to + p.slice(from.length); setComments(dest, comments[p]); setComments(p, undefined!); save(dest);
  }
}
app.events.on('note:opened', ({ path }) => void loadComments(path));
app.events.on('vault:opened', () => {
  epoch++; loads.clear(); dirty.clear(); timers.forEach(clearTimeout); timers.clear();
  for (const p of Object.keys(comments)) setComments(p, undefined!);
  setFocusedComment(null);
});

onVaultFs(paths => {
  for (const path of Object.keys(comments)) if (comments[path] && paths.some(p => p === storage(path) || storage(path).startsWith(p.replace(/\/$/, '') + '/'))) void loadComments(path, true);
});
