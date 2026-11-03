// Per-line text direction: every line gets dir="auto", so the browser picks
// RTL/LTR from the line's first strong character (Persian → RTL, Latin → LTR).
// perLineTextDirection makes CodeMirror's cursor motion respect it.
//
// Latin runs in right-to-left lines: the bidi algorithm gives neutral
// characters at the end of a run the line's direction, so `read()` shows as
// `()read` and `C++` as `++C`. Runs that end in characters belonging to them
// are isolated as left-to-right (same rule as core/src/render/bidi.rs).
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, Direction, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

const autoDir = Decoration.line({ attributes: { dir: "auto" } });
const ltrRun = Decoration.mark({ bidiIsolate: Direction.LTR, class: "cm-nz-ltr-run", attributes: { dir: "ltr" } });

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LATIN = /[A-Za-z0-9_]/;
const RUN = /[A-Za-z0-9][A-Za-z0-9_ .,:;'"!?+\-*/=<>@#$%&|~^\\(){}[\]]*/g;

/** Is the first strong character of `text` right-to-left? */
function rtlLine(text: string): boolean {
  for (const c of text) {
    if (RTL.test(c)) return true;
    if (/\p{L}/u.test(c)) return false;
  }
  return false;
}

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

interface Decos {
  lines: DecorationSet;
  runs: DecorationSet;
}

function build(view: EditorView): Decos {
  const lines = new RangeSetBuilder<Decoration>();
  const runs = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      lines.add(line.from, line.from, autoDir);
      if (RTL.test(line.text) && rtlLine(line.text)) {
        for (const [a, b] of runsNeedingIsolation(line.text)) runs.add(line.from + a, line.from + b, ltrRun);
      }
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
