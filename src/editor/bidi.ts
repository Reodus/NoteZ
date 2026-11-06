// Per-line text direction: the line's first strong character decides
// (Persian → RTL, Latin → LTR), except that a line starting with a Latin word
// is RTL when at least as many of its words are Persian ("windows یک سیستم
// عامل", "hello سلام"). A word ends at whitespace or where the script
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
// paragraph-direction buttons) take that direction instead of the guess.
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, Direction, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { parseAttrs } from "./format";

const autoDir = Decoration.line({ attributes: { dir: "auto" } });
const rtlDir = Decoration.line({ attributes: { dir: "rtl" } });
const ltrDir = Decoration.line({ attributes: { dir: "ltr" } });
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
  let prev: "rtl" | "ltr" | null = null;
  for (const c of text) {
    if (/\s/.test(c)) {
      prev = null;
      continue;
    }
    const d = RTL.test(c) ? "rtl" : /\p{L}/u.test(c) ? "ltr" : null;
    if (d && d !== prev) {
      if (d === "rtl") rtl++;
      else ltr++;
      prev = d;
    }
  }
  return rtl >= ltr;
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

const DIV_OPEN = /^\s*:::\s*(\{.*\}|\S.*)\s*$/;
const DIV_CLOSE = /^\s*:::\s*$/;

/** Explicit `dir` of the `:::` blocks enclosing each line, from line 1 up to `last`. */
function explicitDirs(view: EditorView, last: number): ("rtl" | "ltr" | null)[] {
  const doc = view.state.doc;
  const out: ("rtl" | "ltr" | null)[] = [null];
  const stack: ("rtl" | "ltr" | null)[] = [];
  let inFence = false;
  for (let i = 1; i <= last; i++) {
    const text = doc.line(i).text;
    const cur = stack.length ? stack[stack.length - 1] : null;
    out.push(cur);
    if (/^\s*(```|~~~)/.test(text)) inFence = !inFence;
    if (inFence) continue;
    if (DIV_CLOSE.test(text)) stack.pop();
    else {
      const m = DIV_OPEN.exec(text);
      if (m) {
        const d = parseAttrs(m[1]).dir;
        stack.push(d === "rtl" || d === "ltr" ? d : cur);
      }
    }
  }
  return out;
}

function build(view: EditorView): Decos {
  const lines = new RangeSetBuilder<Decoration>();
  const runs = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const ranges = view.visibleRanges;
  const dirs = ranges.length ? explicitDirs(view, doc.lineAt(ranges[ranges.length - 1].to).number) : [];
  for (const { from, to } of ranges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      const forced = dirs[line.number];
      const rtl = forced ? forced === "rtl" : RTL.test(line.text) && rtlLine(line.text);
      lines.add(line.from, line.from, rtl ? rtlDir : forced === "ltr" ? ltrDir : autoDir);
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
