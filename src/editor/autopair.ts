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
import { EditorSelection, EditorState, SelectionRange } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { isTypst } from "./format";
import { prefs } from "../core/store";

const WORD = /[\p{L}\p{N}]/u;
const TICK = "`";

function isTypingAtSelection(view: EditorView, from: number, to: number) {
  const { state } = view;
  return !view.compositionStarted && !state.readOnly && from === state.selection.main.from && to === state.selection.main.to;
}

function codeAt(state: EditorState, pos: number) {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let node: ReturnType<typeof tree.resolve> | null = tree.resolve(pos, side); node; node = node.parent) {
      if (node.name === "InlineCode" || node.name === "FencedCode" || node.name === "CodeBlock") return node;
    }
  }
  return null;
}

/** Prefix for the body and closing fence inside a Markdown quote or list item. */
function fenceContinuation(prefix: string): string | undefined {
  const match = /^((?: {0,3}>[ \t]?)* {0,3})(?:(?:[-+*]|\d{1,9}[.)]) +)?$/.exec(prefix);
  if (match) return match[1] + " ".repeat(prefix.length - match[1].length);
}

function escaped(before: string) {
  return (before.match(/\\+$/)?.[0].length ?? 0) % 2 === 1;
}

/** Pair an inline-code mark, or complete a fence once three marks are typed. */
export const markdownCodeAutoPair = EditorView.inputHandler.of((view, from, to, text) => {
  const { state } = view;
  if ((text !== TICK && text !== "~") || from !== to || isTypst() || !isTypingAtSelection(view, from, to) || state.selection.ranges.length !== 1) return false;
  const line = state.doc.lineAt(from);
  const before = state.sliceDoc(line.from, from);
  const after = state.sliceDoc(from, line.to);
  const code = codeAt(state, from);
  const close = code?.name === "InlineCode" ? code.lastChild : null;
  const movePast = (end: number) => {
    view.dispatch({ selection: { anchor: end }, scrollIntoView: true, userEvent: "select" });
    return true;
  };

  if (text === TICK && close?.name === "CodeMark" && close.from === from) return movePast(close.to);
  if (code && (code.name !== "InlineCode" || from < code.to)) return false;

  if (before.endsWith(text + text) && !after.trim()) {
    const continuation = fenceContinuation(before.slice(0, -2));
    if (continuation !== undefined) {
      const body = `\n${continuation}`;
      view.dispatch({
        changes: { from, to: line.to, insert: text + after + body + body + text.repeat(3) },
        selection: { anchor: from + 1 + after.length + body.length },
        scrollIntoView: true,
        userEvent: "input.type",
      });
      return true;
    }
  }

  if (text !== TICK || escaped(before)) return false;
  if (before.endsWith(TICK) && !before.endsWith(TICK + TICK) && after.startsWith(TICK) && !after.startsWith(TICK + TICK) && !escaped(before.slice(0, -1))) {
    return movePast(from + 1);
  }
  if (before.endsWith(TICK) || after.startsWith(TICK) || WORD.test(after.charAt(0))) return false;
  view.dispatch({ changes: { from, insert: TICK + TICK }, selection: { anchor: from + 1 }, scrollIntoView: true, userEvent: "input.type" });
  return true;
});

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
  if (text !== "$" || from !== to || isTypst() || !isTypingAtSelection(view, from, to) || view.state.selection.ranges.length > 1) return false;
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

/** Backspace in an empty inline-code or math pair deletes both signs. */
export const delimiterBackspace = keymap.of([
  {
    key: "Backspace",
    run: (view) => {
      const { state } = view;
      if (isTypst() || state.readOnly || state.selection.ranges.length > 1 || !state.selection.main.empty) return false;
      const pos = state.selection.main.head;
      const pair = state.sliceDoc(pos - 1, pos + 1);
      if ((pair !== TICK + TICK && pair !== "$$") || inCode(state, pos)) return false;
      const before = state.sliceDoc(state.doc.lineAt(pos).from, pos - 1);
      const after = state.sliceDoc(pos + 1, pos + 2);
      if (pair === TICK + TICK) {
        if (!prefs.autoPair || before.endsWith(TICK) || after === TICK || escaped(before)) return false;
      } else if (before.endsWith("$") && after !== "$") return false;
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

function surround(range: SelectionRange, open: string, close: string) {
  return {
    changes: [{ from: range.from, insert: open }, { from: range.to, insert: close }],
    range: EditorSelection.range(range.anchor + open.length, range.head + open.length),
  };
}

function wrapCode(state: EditorState, range: SelectionRange) {
  const text = state.sliceDoc(range.from, range.to);
  let size = 1;
  for (const [run] of text.matchAll(/`+/g)) size = Math.max(size, run.length + 1);
  if (!text.includes("\n")) {
    const ticks = TICK.repeat(size);
    const pad = text.startsWith(TICK) || text.endsWith(TICK) || (/^ .+ $/.test(text) && !!text.trim()) ? " " : "";
    return surround(range, ticks + pad, pad + ticks);
  }

  const fence = TICK.repeat(Math.max(size, 3));
  const left = state.sliceDoc(state.doc.lineAt(range.from).from, range.from);
  const right = state.sliceDoc(range.to, state.doc.lineAt(range.to).to);
  const continuation = fenceContinuation(left);
  const prefix = continuation ?? "";
  const split = text.endsWith("\n");
  return surround(range,
    (continuation === undefined ? "\n" : "") + fence + "\n" + prefix,
    (split ? "" : "\n") + prefix + fence + (right ? "\n" + (split ? "" : prefix) : ""),
  );
}

/**
 * Typing a symbol over selected text wraps it instead of replacing it, like
 * Obsidian: `$` → $x$, `` ` `` → `x`, `*` twice → **x**, `=` twice → ==x==.
 * The text stays selected so the marks can be stacked.
 */
export const wrapSelection = EditorView.inputHandler.of((view, from, to, text) => {
  if (text.length !== 1) return false;
  const close = WRAP_PAIRS[text];
  const typst = isTypst();
  if (!close || !isTypingAtSelection(view, from, to) || (typst && !TYPST_WRAP.has(text))) return false;
  const { state } = view;
  if (state.selection.ranges.some((r) => r.empty)) return false;
  const markdownCode = !typst && text === TICK;
  if (markdownCode && state.selection.ranges.some((r) =>
    [codeAt(state, r.from), codeAt(state, r.to)].some((node) => node && node.name !== "InlineCode" && node.from < r.to && node.to > r.from))) return false;
  view.dispatch(
    state.changeByRange((r) => markdownCode ? wrapCode(state, r) : surround(r, text, close)),
    { scrollIntoView: true, userEvent: "input.type" },
  );
  return true;
});
