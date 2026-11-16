import { invertedEffects } from "@codemirror/commands";
import { movedBlock } from "./blockMove.ts";
import { StateEffect, StateField, EditorState } from "@codemirror/state";
import { type NoteComment, offset, point, reanchor } from "../core/commentAnchors.ts";
interface AnchorSnapshot { id: string; from: number; to: number; quote: string; orphaned?: boolean }
const restoreAnchors = StateEffect.define<AnchorSnapshot[]>({ map: (list, changes) => list.map(c => {
  const from = changes.mapPos(c.from, 1);
  return { ...c, from, to: Math.max(from, changes.mapPos(c.to, -1)) };
}) });
export const refreshComments = StateEffect.define<void>();
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
      return list.map(c => {
        if (c.orphaned) return c;
        const a = offset(before, c.from), b = offset(before, c.to);
        if (move && a >= move.from && b <= move.to) return { ...c, from: point(after, move.dest + a - move.from), to: point(after, move.dest + b - move.from) };
        const from = tr.changes.mapPos(a, 1), to = Math.max(from, tr.changes.mapPos(b, -1));
        return { ...c, from: point(after, from), to: point(after, to),
          orphaned: a !== b && from === to, quote: from === to && a !== b ? c.quote : after.slice(from, to) };
      });
    },
  });
}
