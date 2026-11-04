// Keep an empty line after a block that ends the note (table, code block,
// math block, callout/quote), so there is always somewhere to keep writing.
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Lines that render as a block widget the caret can't sit after. */
const BLOCK_END = /^\s*(\||```|~~~|\$\$|>|<\/?(center|div|details)\b|:::)/;

function needsLine(state: EditorState): boolean {
  const last = state.doc.line(state.doc.lines);
  return last.length > 0 && BLOCK_END.test(last.text);
}

/** After an edit leaves the note ending in such a block, add a newline. */
const appendFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.isUserEvent("undo") || tr.isUserEvent("redo")) return tr;
  const doc = tr.newDoc;
  const last = doc.line(doc.lines);
  if (!last.length || !BLOCK_END.test(last.text)) return tr;
  return [tr, { changes: { from: doc.length, insert: "\n" }, sequential: true, annotations: Transaction.addToHistory.of(false) }];
});

/** Clicking below the last block (e.g. a note opened that ends in a table) gives a new line there. */
const clickBelow = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0 || !needsLine(view.state)) return false;
    const bottom = view.documentTop + view.lineBlockAt(view.state.doc.length).bottom;
    if (e.clientY <= bottom) return false;
    e.preventDefault();
    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, insert: "\n" }, selection: { anchor: end + 1 }, scrollIntoView: true });
    view.focus();
    return true;
  },
});

export const trailingLine = (typst: boolean) => (typst ? [] : [appendFilter, clickBelow]);
