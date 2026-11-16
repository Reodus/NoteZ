import { createEffect, createMemo, createSignal, For, Show, onCleanup } from 'solid-js';
import { render } from 'solid-js/web';
import { comments, focusedComment, setFocusedComment, showComments, addComment, patchComment, removeComment, copyAsPrompt } from '../core/comments';
import { state, cursor, goToLine } from '../core/store';
import { isNotePath } from '../core/ipc';
import { BuiltinPlugin } from '../core/plugins';
import { NoteComment } from '../core/commentAnchors';
import { pushLayer } from '../ui/primitives';
import { t } from '../core/i18n';
function Card(props: { path: string; c: NoteComment }) {
  let body!: HTMLTextAreaElement;
  const [reply, setReply] = createSignal('');
  const [editing, setEditing] = createSignal(false);
  createEffect(() => { if (focusedComment() === props.c.id) { body?.focus(); body?.scrollIntoView({ block: 'nearest' }); } });
  createEffect(() => { if (editing()) onCleanup(pushLayer(() => { (document.activeElement as HTMLElement | null)?.blur(); setEditing(false); })); });
  const active = () => focusedComment() === props.c.id || (!props.c.orphaned && cursor().line >= props.c.from.line && cursor().line <= props.c.to.line);
  return <article class="comment-card" classList={{ active: active(), resolved: props.c.resolved }}>
    <div class="comment-card-head">
      <button class="btn small" disabled={props.c.orphaned} onClick={() => { setFocusedComment(props.c.id); goToLine(props.c.from.line); }}>L{props.c.from.line}–{props.c.to.line}</button>
      <Show when={props.c.orphaned}><span>{t('Detached from text')}</span></Show>
      <button class="btn small" onClick={() => patchComment(props.path, props.c.id, { resolved: !props.c.resolved })}>{t(props.c.resolved ? 'Reopen' : 'Resolve')}</button>
      <button class="btn small danger" onClick={() => removeComment(props.path, props.c.id)}>{t('Delete')}</button>
    </div>
    <blockquote dir="auto">{props.c.quote || t('Empty line')}</blockquote>
    <textarea ref={body} class="input comment-body" dir="auto" aria-label={t('Comment')} placeholder={t('Write a comment…')} value={props.c.body}
      onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} onInput={e => patchComment(props.path, props.c.id, { body: e.currentTarget.value })} />
    <For each={props.c.replies}>{r => <div class="comment-reply" dir="auto">{r.body}</div>}</For>
    <form onSubmit={e => {
      e.preventDefault(); if (!reply().trim()) return;
      patchComment(props.path, props.c.id, { replies: [...props.c.replies, { id: crypto.randomUUID(), body: reply().trim(), created: new Date().toISOString() }] }); setReply('');
    }}>
      <input class="input" dir="auto" aria-label={t('Reply')} placeholder={t('Reply…')} onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} value={reply()} onInput={e => setReply(e.currentTarget.value)} />
      <button class="btn small" disabled={!reply().trim()}>{t('Reply')}</button>
    </form>
    <Show when={props.c.orphaned}><button class="btn small" onClick={() => void addComment(props.c.id)}>{t('Attach to selection')}</button></Show>
  </article>;
}
export function CommentsPane() {
  const [filter, setFilter] = createSignal('open');
  const list = createMemo(() => (comments[state.active ?? ''] ?? []).filter(c => focusedComment() === c.id || filter() === 'all' || (filter() === 'resolved' ? c.resolved : !c.resolved)).slice().sort((a,b) => a.from.line - b.from.line));
  return <div class="comments-pane">
    <div class="comments-header">
      <select class="input" aria-label={t('Filter comments')} value={filter()} onChange={e => { setFocusedComment(null); setFilter(e.currentTarget.value); }}>
        <option value="open">{t('Open comments')}</option><option value="resolved">{t('Resolved')}</option><option value="all">{t('All')}</option>
      </select><span>{list().length}</span>
      <button class="btn small" onClick={() => void copyAsPrompt()}>{t('Copy as prompt')}</button>
    </div>
    <Show when={isNotePath(state.active)} fallback={<div class="pane-empty">{t('Open a note first')}</div>}>
      <button class="btn small" onClick={() => void addComment()}>{t('Add comment')}</button>
      <For each={list()} fallback={<div class="pane-empty">{t('No comments yet.')}</div>}>{c => <Card path={state.active!} c={c} />}</For>
    </Show>
  </div>;
}
export const commentsPlugin: BuiltinPlugin = {
  id: 'core.comments', name: t('Comments'), description: t('Review notes with comments stored separately from their text.'), optional: true,
  onload(api) {
    api.panels.add({ id: 'pane', title: t('Comments'), label: true, icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 19 0Z"/></svg>', mount: el => render(() => <CommentsPane />, el) });
    api.commands.register({ id: 'comments.add', title: t('Add comment'), key: 'Mod-Alt-m', run: () => addComment() });
    api.commands.register({ id: 'comments.show', title: t('Show comments'), run: () => showComments() });
    api.commands.register({ id: 'comments.copy', title: t('Copy comments as prompt'), run: () => copyAsPrompt() });
    for (const dir of [1, -1]) api.commands.register({ id: dir === 1 ? 'comments.next' : 'comments.previous', title: t(dir === 1 ? 'Next comment' : 'Previous comment'), run: () => {
      const list = (comments[state.active ?? ''] ?? []).filter(c => !c.orphaned && !c.resolved).slice().sort((a,b) => dir * (a.from.line - b.from.line));
      const c = list.find(c => dir * (c.from.line - cursor().line) > 0) ?? list[0];
      if (c) { goToLine(c.from.line); showComments(c.id); }
    }});
    api.statusBar.addItem({ id: 'count', render: () => isNotePath(state.active) ? `💬 ${(comments[state.active!] ?? []).filter(c => !c.resolved).length}` : '', title: t('Show comments'), onClick: () => showComments() });
  },
};
