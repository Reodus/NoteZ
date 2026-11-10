// Per-line text direction: the line's first strong character decides
// (Arabic, Persian, Urdu, Syriac, Thaana, NKo … → RTL; every other
// script → LTR), except that a line starting with a left-to-right word is RTL
// when at least as many of its words are right-to-left ("windows یک سیستم
// عامل", "hello مرحبا"). A word ends at whitespace or where the script
// changes, so "helloسلام" is two. Same rule as
// detect_dir in core/src/render/md.rs.
// perLineTextDirection makes CodeMirror's cursor motion respect it.
//
// Latin runs in right-to-left lines: the bidi algorithm gives neutral
// characters at the end of a run the line's direction, so `read()` shows as
// `()read` and `C++` as `++C`. Runs that end in characters belonging to them
// are isolated as left-to-right (same rule as core/src/render/bidi.rs).
//
// Math is written left to right whatever the line: an inline `$…$` /
// `$$…$$` formula is isolated as one left-to-right run (otherwise the `$`
// signs and `\` jump sides in a Persian sentence), and the lines of a
// multi-line `$$` block are always left to right.
//
// Lines inside a `::: {dir=rtl}` / `::: {dir=ltr}` block (the toolbar's
// paragraph-direction buttons) or a `::: {lang=ar}` block take that direction
// instead of the guess.
import { EditorSelection, Prec, RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, Direction, EditorView, keymap, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RTL, rtlLine, explicitDirs } from "./dirrules";

export { RTL, isRtlLang, rtlLine, explicitDirAt, tableDir } from "./dirrules";

const autoDir = Decoration.line({ attributes: { dir: "auto" } });
const rtlDir = Decoration.line({ attributes: { dir: "rtl" } });
const ltrDir = Decoration.line({ attributes: { dir: "ltr" } });
const ltrRun = Decoration.mark({ bidiIsolate: Direction.LTR, class: "cm-nz-ltr-run", attributes: { dir: "ltr" } });

const LATIN = /[A-Za-z0-9_]/;
const RUN = /[A-Za-z0-9_][A-Za-z0-9_ .,:;'"!?+\-*/=<>@#$%&|~^\\(){}[\]]*/g;

/** [from, to) offsets of Latin runs whose trailing neutrals belong to them. */
export function runsNeedingIsolation(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(RUN)) {
    const run = m[0];
    let end = run.length;
    const count = (ch: string, upTo: number) => run.slice(0, upTo).split(ch).length - 1;
    while (end > 0) {
      const c = run[end - 1];
      if (LATIN.test(c)) break;
      const pair: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
      const keep = pair[c]
        ? count(pair[c], end) >= count(c, end)
        : "+#%".includes(c) && end > 1 && run[end - 2] !== " ";
      if (keep) break;
      end--;
    }
    if (end > 0 && !LATIN.test(run[end - 1])) out.push([m.index!, m.index! + end]);
  }
  return out;
}

/** Inline code spans (`…`, ``…``) with no right-to-left letters in them. */
function codeSpans(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g)) {
    if (!RTL.test(m[2])) out.push([m.index!, m.index! + m[0].length]);
  }
  return out;
}

/** Inline formulas (`$…$`, `$$…$$`) outside code spans. */
function mathSpans(text: string, code: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/(?<![\\$])(\$\$?)(?![\s$])((?:\\.|[^$\\])+?)(?<!\s)\1(?![$\d])/g)) {
    const a = m.index!, b = a + m[0].length;
    if (!code.some(([c, d]) => a < d && b > c)) out.push([a, b]);
  }
  return out;
}

/** Image sources (`![caption](path)`, `![[file|300]]`) outside code spans:
 * Markdown syntax, so they read left to right even with a Persian caption
 * (otherwise `![`, `](` and the path scatter across the line). */
function imageSpans(text: string, code: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/!\[\[[^\]\n]+\]\]|!\[[^\]\n]*\]\([^)\n]*\)/g)) {
    const a = m.index!, b = a + m[0].length;
    if (!code.some(([c, d]) => a < d && b > c)) out.push([a, b]);
  }
  return out;
}

/**
 * Ranges of a right-to-left line shown left-to-right: inline code spans, image sources and
 * formulas as a whole (backticks, leading `__` and trailing `()` included — `__libc_malloc()`
 * would otherwise show as `libc_malloc()__`), then the Latin runs outside them.
 */
export function ltrRanges(text: string): [number, number][] {
  const code = codeSpans(text);
  const images = imageSpans(text, code);
  const math = mathSpans(text, code).filter(([a, b]) => !images.some(([c, d]) => a < d && b > c));
  const whole = [...code, ...images, ...math];
  const runs = runsNeedingIsolation(text).filter(([a, b]) => !whole.some(([c, d]) => a < d && b > c));
  return [...whole, ...runs].sort((x, y) => x[0] - y[0]);
}

/** Line numbers (up to `last`) inside multi-line `$$` blocks, delimiters included. */
function mathBlockLines(doc: EditorView["state"]["doc"], last: number): Set<number> {
  const out = new Set<number>();
  let open = false, fence: string | null = null;
  for (let n = 1; n <= last; n++) {
    const text = doc.line(n).text.replace(/^\s*(?:>\s?)*/, "");
    const f = /^(`{3,}|~{3,})/.exec(text)?.[1];
    if (!open && (fence ? text.startsWith(fence) : f)) { fence = fence ? null : f!; continue; }
    if (fence) continue;
    const marks = (text.match(/(?<!\\)\$\$/g) ?? []).length;
    if (open || (marks % 2 === 1 && text.trimStart().startsWith("$$"))) out.add(n);
    if (marks % 2 === 1) open = !open;
  }
  return out;
}

/** The caption inside image sources (`![caption|300](…)`, `![[file|caption]]`)
 * that reads right to left: isolated on its own, so its words keep their
 * order and the brackets around it aren't mirrored. */
export function rtlCaptions(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/!\[\[([^\]\n]+)\]\]|!\[([^\]\n]*)\]\([^)\n]*\)/g)) {
    const wiki = m[1] !== undefined;
    const inner = (wiki ? m[1] : m[2]).replace(/\|\s*\d+(\.\d+)?\s*$/, "");
    if (!RTL.test(inner) || !rtlLine(inner)) continue;
    const a = m.index! + (wiki ? 3 : 2);
    out.push([a, a + inner.length]);
  }
  return out;
}

const rtlRun = Decoration.mark({ bidiIsolate: Direction.RTL, class: "cm-nz-rtl-run", attributes: { dir: "rtl" } });

interface Decos {
  lines: DecorationSet;
  runs: DecorationSet;
}

function build(view: EditorView): Decos {
  const lines = new RangeSetBuilder<Decoration>();
  const runs = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const ranges = view.visibleRanges;
  const last = ranges.length ? doc.lineAt(ranges[ranges.length - 1].to).number : 0;
  const dirs = ranges.length ? explicitDirs(doc, last) : [];
  const math = mathBlockLines(doc, last);
  for (const { from, to } of ranges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      const forced = math.has(line.number) ? "ltr" : dirs[line.number];
      const rtl = forced ? forced === "rtl" : RTL.test(line.text) && rtlLine(line.text);
      lines.add(line.from, line.from, rtl ? rtlDir : forced === "ltr" ? ltrDir : autoDir);
      const marks: [number, number, Decoration][] = rtl ? ltrRanges(line.text).map(([a, b]) => [a, b, ltrRun]) : [];
      if (RTL.test(line.text)) for (const [a, b] of rtlCaptions(line.text)) marks.push([a, b, rtlRun]);
      // Outer ranges first when two start together.
      marks.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
      for (const [a, b, d] of marks) if (b > a) runs.add(line.from + a, line.from + b, d);
      pos = line.to + 1;
    }
  }
  return { lines: lines.finish(), runs: runs.finish() };
}

const autoDirPlugin = ViewPlugin.fromClass(
  class {
    decos: Decos;
    constructor(view: EditorView) {
      this.decos = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decos = build(u.view);
    }
  },
  {
    provide: (p) => [
      EditorView.decorations.of((v) => v.plugin(p)?.decos.lines ?? Decoration.none),
      EditorView.decorations.of((v) => v.plugin(p)?.decos.runs ?? Decoration.none),
      EditorView.bidiIsolatedRanges.of((v) => v.plugin(p)?.decos.runs ?? Decoration.none),
    ],
  },
);


// Home / End. CodeMirror finds the end of a visual line by asking which
// position is at the line's edge on screen; in a right-to-left line that ends
// with a left-to-right run (an English word, a formula, code) the left edge is
// the *start* of that run, so End stopped there. Wrapping always breaks lines
// in logical order, so the row's end is instead the last position that is
// still on the cursor's row (and its start the first one), found by binary
// search. Home still stops at the indentation first, like CodeMirror's.
function rowOf(view: EditorView, pos: number, side: -1 | 1): number | null {
  const c = view.coordsAtPos(pos, side);
  return c ? (c.top + c.bottom) / 2 : null;
}

function rowBoundary(view: EditorView, head: number, forward: boolean, assoc: number): number {
  const line = view.state.doc.lineAt(head);
  const side = forward ? -1 : 1;
  // The cursor's own row: at a wrap point it belongs to the row it is drawn on.
  const row = rowOf(view, head, assoc < 0 ? -1 : assoc > 0 ? 1 : forward ? 1 : -1);
  if (row === null) return forward ? line.to : line.from;
  const same = (p: number) => {
    const r = rowOf(view, p, side);
    return r !== null && Math.abs(r - row) < 2;
  };
  let lo = forward ? head : line.from, hi = forward ? line.to : head;
  if (forward) {
    if (same(hi)) return hi;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (same(m)) lo = m; else hi = m; }
    return lo;
  }
  if (same(lo)) {
    const indent = line.from + /^\s*/.exec(line.text)![0].length;
    return head !== indent && indent < head ? indent : line.from;
  }
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (same(m)) hi = m; else lo = m; }
  return hi;
}

function boundary(forward: boolean, extend: boolean) {
  return (view: EditorView) => {
    const sel = view.state.selection;
    view.dispatch({
      selection: EditorSelection.create(
        sel.ranges.map((r) => {
          const to = rowBoundary(view, r.head, forward, r.assoc);
          return extend ? EditorSelection.range(r.anchor, to) : EditorSelection.cursor(to, forward ? -1 : 1);
        }),
        sel.mainIndex,
      ),
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  };
}

export const homeEndKeys = Prec.high(
  keymap.of([
    { key: "End", run: boundary(true, false), shift: boundary(true, true) },
    { key: "Home", run: boundary(false, false), shift: boundary(false, true) },
  ]),
);

export const bidi = [EditorView.perLineTextDirection.of(true), autoDirPlugin, homeEndKeys];
