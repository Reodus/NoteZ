import { Annotation, EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';
/** Source coordinates before a move, destination coordinates after it. */
export const movedBlock = Annotation.define<{ from: number; to: number; dest: number }>();
export function blockMove(state: EditorState, src: { from: number; to: number }, item: boolean, at: number, before: boolean): TransactionSpec | null {
  const doc = state.doc;
  if (at >= src.from && at <= src.to) return null;
  const text = doc.sliceString(src.from, src.to), sep = item ? '\n' : '\n\n';
  let delFrom = src.from, delTo = src.to;
  const after = doc.sliceString(src.to, Math.min(doc.length, src.to + 2));
  if (!item && after === '\n\n') delTo += 2;
  else if (after.startsWith('\n')) delTo++;
  else if (src.from > 0) delFrom = Math.max(0, src.from - (doc.sliceString(Math.max(0, src.from - 2), src.from) === '\n\n' && !item ? 2 : 1));
  if (at > delFrom && at < delTo) return null;
  const changes = state.changes([{ from: delFrom, to: delTo }, { from: at, insert: before ? text + sep : sep + text }]);
  const dest = changes.mapPos(at, -1) + (before ? 0 : sep.length);
  const sel = state.selection.main;
  const anchor = sel.anchor >= src.from && sel.anchor <= src.to ? dest + sel.anchor - src.from : dest;
  const head = sel.head >= src.from && sel.head <= src.to ? dest + sel.head - src.from : anchor;
  return { changes, selection: EditorSelection.range(anchor, head), annotations: movedBlock.of({ ...src, dest }), userEvent: 'move.block', scrollIntoView: true };
}
