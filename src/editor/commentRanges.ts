import { invertedEffects } from "@codemirror/commands";
import { movedBlock } from "./blockMove.ts";
import { Annotation, StateEffect, StateField, EditorState } from "@codemirror/state";
import { type NoteComment, offset, point, reanchor } from "../core/commentAnchors.ts";
interface AnchorSnapshot { id: string; from: number; to: number; quote: string; orphaned?: boolean }
const restoreAnchors = StateEffect.define<AnchorSnapshot[]>({ map: (list, changes) => list.map(c => {
  const from = changes.mapPos(c.from, 1);
  return { ...c, from, to: Math.max(from, changes.mapPos(c.to, -1)) };
}) });
export const refreshComments = StateEffect.define<void>();
/** Unchanged source spans relocated by a structural edit. */
export const movedRanges = Annotation.define<{ from: number; to: number; dest: number }[]>();
export function commentField(read: () => NoteComment[]) {
  const initial = (state: EditorState) => read().map(c => reanchor(c, state.doc.toString()));
  return StateField.define<NoteComment[]>({
    create: initial,
    provide: field => invertedEffects.of(tr => {
      if (!tr.docChanged) return [];
      const text = tr.startState.doc.toString();
      return [restoreAnchors.of(tr.startState.field(field).map(c => ({ id: c.id, from: offset(text, c.from), to: offset(text, c.to), quote: c.quote, orphaned: c.orphaned })))];
    }),
    update(list, tr) {
      const restored = tr.effects.find(e => e.is(restoreAnchors))?.value as AnchorSnapshot[] | undefined;
      if (restored) return list.map(c => {
        const anchor = restored.find(a => a.id === c.id);
        return anchor ? { ...c, ...anchor, from: point(tr.newDoc.toString(), anchor.from), to: point(tr.newDoc.toString(), anchor.to) } : reanchor(c, tr.newDoc.toString());
      });
      if (tr.effects.some(e => e.is(refreshComments))) return initial(tr.state);
      if (!tr.docChanged) return list;
      const before = tr.startState.doc.toString(), after = tr.newDoc.toString();
      const move = tr.annotation(movedBlock);
      const ranges = tr.annotation(movedRanges);
      return list.map(c => {
        if (c.orphaned) return c;
        const a = offset(before, c.from), b = offset(before, c.to);
        const relocated = move && a >= move.from && b <= move.to ? move : ranges?.find(r => a >= r.from && b <= r.to);
        if (relocated) return { ...c, from: point(after, relocated.dest + a - relocated.from), to: point(after, relocated.dest + b - relocated.from) };
        const from = tr.changes.mapPos(a, 1), to = Math.max(from, tr.changes.mapPos(b, -1));
        return { ...c, from: point(after, from), to: point(after, to),
          orphaned: a !== b && from === to, quote: from === to && a !== b ? c.quote : after.slice(from, to) };
      });
    },
  });
}
