// Typing `$$` completes the formula block (Markdown notes only):
//   on an empty line   →  $$            mid-line  →  $$|$$
//                         |
//                         $$
// Lines inside callouts/quotes keep their `> ` prefix on every line.
import { EditorView } from "@codemirror/view";
import { isTypst } from "./format";

export const mathAutoPair = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== "$" || from !== to || isTypst() || view.state.selection.ranges.length > 1) return false;
  const doc = view.state.doc;
  if (doc.sliceString(from - 1, from) !== "$" || doc.sliceString(from - 2, from - 1) === "$") return false;
  const line = doc.lineAt(from);
  const before = line.text.slice(0, from - 1 - line.from);
  const after = line.text.slice(from - line.from);
  if (after.startsWith("$")) return false; // already closed: let it type over
  // Inside an open $$ block this `$$` closes it: type normally.
  const opened = (doc.sliceString(0, from - 1).match(/\$\$/g)?.length ?? 0) % 2 === 1;
  if (opened) return false;
  const prefix = /^(\s*(?:>\s?)*)$/.exec(before)?.[1];
  if (prefix !== undefined && !after.trim()) {
    const insert = `$\n${prefix}\n${prefix}$$`;
    view.dispatch({
      changes: { from, to: line.to, insert },
      selection: { anchor: from + 2 + prefix.length },
      userEvent: "input.type",
    });
    return true;
  }
  view.dispatch({ changes: { from, insert: "$$$" }, selection: { anchor: from + 1 }, userEvent: "input.type" });
  return true;
});
