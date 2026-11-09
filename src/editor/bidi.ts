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
// Lines inside a `::: {dir=rtl}` / `::: {dir=ltr}` block (the toolbar's
// paragraph-direction buttons) or a `::: {lang=ar}` block take that direction
// instead of the guess.
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, Direction, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
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

/**
 * Ranges of a right-to-left line shown left-to-right: inline code spans as a
 * whole (backticks, leading `__` and trailing `()` included — `__libc_malloc()`
 * would otherwise show as `libc_malloc()__`), then the Latin runs outside them.
 */
export function ltrRanges(text: string): [number, number][] {
  const code = codeSpans(text);
  const runs = runsNeedingIsolation(text).filter(([a, b]) => !code.some(([c, d]) => a < d && b > c));
  return [...code, ...runs].sort((x, y) => x[0] - y[0]);
}

interface Decos {
  lines: DecorationSet;
  runs: DecorationSet;
}

function build(view: EditorView): Decos {
  const lines = new RangeSetBuilder<Decoration>();
  const runs = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const ranges = view.visibleRanges;
  const dirs = ranges.length ? explicitDirs(doc, doc.lineAt(ranges[ranges.length - 1].to).number) : [];
  for (const { from, to } of ranges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      const forced = dirs[line.number];
      const rtl = forced ? forced === "rtl" : RTL.test(line.text) && rtlLine(line.text);
      lines.add(line.from, line.from, rtl ? rtlDir : forced === "ltr" ? ltrDir : autoDir);
      if (rtl) for (const [a, b] of ltrRanges(line.text)) runs.add(line.from + a, line.from + b, ltrRun);
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

export const bidi = [EditorView.perLineTextDirection.of(true), autoDirPlugin];
