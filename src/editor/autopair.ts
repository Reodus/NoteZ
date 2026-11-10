// Math delimiters in Markdown notes:
//   `$`  pairs to `$|$` (Settings → Editor → auto-pair), except after a
//        letter or digit (US$5), before a word, after `\`, or in code
//   `$` typed in front of the closing `$` steps over it
//   `$` typed in an empty pair `$|$` (or right after `$`) makes a formula block:
//        on an empty line   →  $$            mid-line  →  $$|$$
//                              |
//                              $$
//   Backspace in an empty pair deletes both signs.
// Lines inside callouts/quotes keep their `> ` prefix on every line.
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { isTypst } from "./format";
import { prefs } from "../core/store";

const WORD = /[\p{L}\p{N}]/u;

/** In inline code or a code block, where `$` is just a character. */
function inCode(state: EditorState, pos: number): boolean {
  for (let n: any = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (/^(InlineCode|FencedCode|CodeBlock|CodeText|CodeMark)$/.test(n.name)) return true;
  }
  return false;
}

/** Number of single `$` (not `$$`, not `\$`) in `text`: odd = inside a formula. */
function singleDollars(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] !== "$") continue;
    if (text[i + 1] === "$") { i++; continue; }
    n++;
  }
  return n;
}

export const mathAutoPair = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== "$" || from !== to || isTypst() || view.state.selection.ranges.length > 1) return false;
  const { state } = view;
  const doc = state.doc;
  if (inCode(state, from)) return false;
  const line = doc.lineAt(from);
  const at = (i: number) => doc.sliceString(i, i + 1);
  const prev = at(from - 1), prev2 = at(from - 2), next = at(from), next2 = at(from + 1);
  const lineBefore = line.text.slice(0, from - line.from);
  const move = () => (view.dispatch({ selection: { anchor: from + 1 }, userEvent: "select" }), true);

  // Right after an opening `$` (an empty pair `$|$`, or `$|` with pairing off): `$$`.
  if (prev === "$" && prev2 !== "$" && prev2 !== "\\" && singleDollars(lineBefore.slice(0, -1)) % 2 === 0) {
    const paired = next === "$" && next2 !== "$";
    if (next === "$" && !paired) return false;
    // Inside an open $$ block this `$$` closes it.
    const opened = (doc.sliceString(0, from - 1).match(/\$\$/g)?.length ?? 0) % 2 === 1;
    if (opened) return paired ? move() : false;
    const before = lineBefore.slice(0, -1);
    const rest = line.text.slice((paired ? from + 1 : from) - line.from);
    const prefix = /^(\s*(?:>\s?)*)$/.exec(before)?.[1];
    if (prefix !== undefined && !rest.trim()) {
      view.dispatch({
        changes: { from, to: line.to, insert: `$\n${prefix}\n${prefix}$$` },
        selection: { anchor: from + 2 + prefix.length },
        userEvent: "input.type",
      });
      return true;
    }
    view.dispatch({ changes: { from, insert: paired ? "$$" : "$$$" }, selection: { anchor: from + 1 }, userEvent: "input.type" });
    return true;
  }
  const inside = singleDollars(lineBefore) % 2 === 1;
  // Closing a formula in front of its `$`: step over it.
  if (inside && next === "$" && next2 !== "$") return move();
  if (!prefs.autoPair || inside || prev === "\\" || WORD.test(prev) || WORD.test(next) || next === "$") return false;
  view.dispatch({ changes: { from, insert: "$$" }, selection: { anchor: from + 1 }, userEvent: "input.type" });
  return true;
});

/** Backspace in an empty `$|$` (or `$$|$$`) deletes both signs. */
export const mathPairBackspace = keymap.of([
  {
    key: "Backspace",
    run: (view) => {
      const { state } = view;
      if (isTypst() || state.selection.ranges.length > 1 || !state.selection.main.empty) return false;
      const pos = state.selection.main.head;
      if (state.doc.sliceString(pos - 1, pos + 1) !== "$$" || inCode(state, pos)) return false;
      const outer = state.doc.sliceString(pos - 2, pos + 2);
      if (outer[0] === "$" && outer[3] !== "$") return false; // `$$|$`: not a pair
      view.dispatch({ changes: { from: pos - 1, to: pos + 1 }, userEvent: "delete.backward" });
      return true;
    },
  },
]);

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
