// Per-line text direction: the line's first strong character decides
// (Persian → RTL, Latin → LTR), except that a line starting with a Latin word
// but mostly Persian ("windows یک سیستم عامل") is RTL. Same rule as
// detect_dir in core/src/render/md.rs.
// perLineTextDirection makes CodeMirror's cursor motion respect it.
//
// Latin runs in right-to-left lines: the bidi algorithm gives neutral
// characters at the end of a run the line's direction, so `read()` shows as
// `()read` and `C++` as `++C`. Runs that end in characters belonging to them
// are isolated as left-to-right (same rule as core/src/render/bidi.rs).
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, Direction, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

const autoDir = Decoration.line({ attributes: { dir: "auto" } });
const rtlDir = Decoration.line({ attributes: { dir: "rtl" } });
const ltrRun = Decoration.mark({ bidiIsolate: Direction.LTR, class: "cm-nz-ltr-run", attributes: { dir: "ltr" } });

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LATIN = /[A-Za-z0-9_]/;
const RUN = /[A-Za-z0-9][A-Za-z0-9_ .,:;'"!?+\-*/=<>@#$%&|~^\\(){}[\]]*/g;

/** Direction of the first strong character of `text`, if any. */
function firstStrong(text: string): "rtl" | "ltr" | null {
  for (const c of text) {
    if (RTL.test(c)) return "rtl";
    if (/\p{L}/u.test(c)) return "ltr";
  }
  return null;
}

/** Is the line right-to-left (see the rule at the top)? */
function rtlLine(text: string): boolean {
  const first = firstStrong(text);
  if (first !== "ltr") return first === "rtl";
  let rtl = 0;
  let ltr = 0;
  for (const w of text.split(/\s+/)) {
    const d = firstStrong(w);
    if (d === "rtl") rtl++;
    else if (d === "ltr") ltr++;
  }
  return rtl > ltr;
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
      const rtl = RTL.test(line.text) && rtlLine(line.text);
      lines.add(line.from, line.from, rtl ? rtlDir : autoDir);
      if (rtl) {
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
