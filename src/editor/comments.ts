import { Decoration, EditorView, GutterMarker, gutter, ViewPlugin } from '@codemirror/view';
import { app } from '../core/app';
import { comments, loadComments, replaceComments, showComments } from '../core/comments';
import { commentField, refreshComments } from "./commentRanges";
import { t } from '../core/i18n';
export { refreshComments } from "./commentRanges";
export function commentExtension(path: string) {
  const field = commentField(() => comments[path] ?? []);
  const decorations = EditorView.decorations.compute([field], state => {
    const lines = new Map<number, boolean>();
    for (const c of state.field(field)) if (!c.orphaned) {
      for (let n = c.from.line; n <= c.to.line; n++) if (n <= state.doc.lines) lines.set(n, (lines.get(n) ?? true) && c.resolved);
    }
    return Decoration.set([...lines].sort((a,b) => a[0]-b[0]).map(([n, resolved]) => Decoration.line({ class: resolved ? 'cm-commented cm-comment-resolved' : 'cm-commented' }).range(state.doc.line(n).from)));
  });
  class Marker extends GutterMarker {
    constructor(readonly id: string, readonly resolved: boolean) { super(); }
    eq(other: Marker) { return other.id === this.id && other.resolved === this.resolved; }
    toDOM() {
      const el = document.createElement('button'); el.className = 'comment-gutter-marker'; el.innerHTML = '<svg width=14 height=14 viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 19 0Z"/></svg>';
      el.title = t('Show comments'); el.setAttribute('aria-label', el.title); el.style.opacity = this.resolved ? '.4' : '1';
      el.onclick = e => { e.preventDefault(); showComments(this.id); }; return el;
    }
  }
  return [field, decorations, gutter({
    class: 'comment-gutter',
    lineMarker: (view, line) => {
      const n = view.state.doc.lineAt(line.from).number;
      const c = view.state.field(field).find(c => !c.orphaned && c.from.line <= n && c.to.line >= n);
      return c ? new Marker(c.id, c.resolved) : null;
    },
    lineMarkerChange: u => u.docChanged || u.startState.field(field) !== u.state.field(field),
  }), ViewPlugin.define(view => {
    const off = app.events.on('comments:changed', e => {
      if (e.path === path) view.dispatch({ effects: refreshComments.of() });
    });
    void loadComments(path);
    return { destroy: off };
  }), EditorView.updateListener.of(u => {
    if (u.docChanged || u.transactions.some(tr => tr.effects.some(e => e.is(refreshComments))))
      replaceComments(path, u.state.field(field), false);
  })];
}
