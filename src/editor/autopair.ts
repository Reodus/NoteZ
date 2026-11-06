// Typing `$$` completes the formula block (Markdown notes only):
//   on an empty line   →  $$            mid-line  →  $$|$$
//                         |
//                         $$
// Lines inside callouts/quotes keep their `> ` prefix on every line.
import { EditorSelection } from "@codemirror/state";
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

/** Closing mark for a symbol typed over a selection. */
export const WRAP_PAIRS: Record<string, string> = {
  $: "$", "`": "`", "*": "*", _: "_", "=": "=", "~": "~", '"': '"', "'": "'", "(": ")", "[": "]", "{": "}",
};
const TYPST_WRAP = new Set(["$", "`", "*", "_", '"', "(", "[", "{"]);

/**
 * Typing a symbol over selected text wraps it instead of replacing it, like
 * Obsidian: `$` → $x$, `` ` `` → `x`, `*` twice → **x**, `=` twice → ==x==.
 * The text stays selected so the marks can be stacked.
 */
export const wrapSelection = EditorView.inputHandler.of((view, _from, _to, text) => {
  const close = WRAP_PAIRS[text];
  if (!close || (isTypst() && !TYPST_WRAP.has(text))) return false;
  const { state } = view;
  if (state.selection.ranges.some((r) => r.empty)) return false;
  view.dispatch(
    state.changeByRange((r) => ({
      changes: [
        { from: r.from, insert: text },
        { from: r.to, insert: close },
      ],
      range: EditorSelection.range(r.anchor + text.length, r.head + text.length),
    })),
    { userEvent: "input.type" },
  );
  return true;
});
