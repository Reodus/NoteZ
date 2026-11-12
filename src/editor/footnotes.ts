import type { BlockContext, LeafBlock, LeafBlockParser, MarkdownConfig } from "@lezer/markdown";
import { StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import { EditorView, hoverTooltip, showTooltip, type Tooltip } from "@codemirror/view";
import { previewHtml } from "../core/blocks";
import { t } from "../core/i18n";
import { hydrateImages } from "./livepreview";

/** `[^1]: word` is a footnote definition, but CommonMark also reads it as a
 * link reference (label `[^1]`, URL `word`), so a one-word footnote got the
 * small muted URL style while longer ones looked normal. Claim footnote
 * definitions before the link-reference parser sees them. */
class FootnoteDef implements LeafBlockParser {
  // Ending here (not only in finish) keeps the link-reference parser, which
  // ends its leaf on the next line, from claiming it first.
  nextLine(cx: BlockContext, _line: unknown, leaf: LeafBlock) {
    return this.finish(cx, leaf);
  }
  finish(cx: BlockContext, leaf: LeafBlock) {
    cx.addLeafElement(leaf, cx.elt("Paragraph", leaf.start, leaf.start + leaf.content.length, cx.parser.parseInline(leaf.content, leaf.start)));
    return true;
  }
}

export const footnoteDefinitions: MarkdownConfig = {
  parseBlock: [
    {
      name: "FootnoteDefinition",
      before: "LinkReference",
      leaf: (_cx, leaf) => (/^\[\^[^\]\s]+\]:/.test(leaf.content) ? new FootnoteDef() : null),
    },
  ],
};

// ------------------------------------------------------------ numbering

const MARK = /\[\^([^\]\s]+)\](:?)/g;

interface Mark {
  label: string;
  from: number;
  to: number;
  def: boolean;
}

/** Every `[^label]` marker outside code, in document order. */
function scanMarks(doc: Text): Mark[] {
  const out: Mark[] = [];
  let fence = false;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (/^\s*(```|~~~)/.test(line.text)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    // Blank out inline code so markers inside `…` are skipped.
    const text = line.text.replace(/`[^`]*`/g, (s) => " ".repeat(s.length));
    for (const m of text.matchAll(MARK)) {
      const def = m[2] === ":" && m.index === 0;
      const from = line.from + m.index!;
      out.push({ label: m[1], from, to: from + 3 + m[1].length, def });
    }
  }
  return out;
}

const orderCache = new WeakMap<Text, Map<string, number>>();

/** Footnote label → its number, in the order the references first appear
 * (as the PDF and exports number them). Unreferenced labels are absent. */
export function footnoteNumbers(doc: Text): Map<string, number> {
  let map = orderCache.get(doc);
  if (!map) {
    map = new Map();
    for (const m of scanMarks(doc)) if (!m.def && !map.has(m.label)) map.set(m.label, map.size + 1);
    orderCache.set(doc, map);
  }
  return map;
}

const DEF = /^\[\^([^\]\s]+)\]:/;
const INDENTED = /^( {2,}|\t)\S/;

interface DefBlock {
  label: string;
  /** First and last line numbers (continuation lines included). */
  first: number;
  last: number;
}

/** Footnote definitions grouped into runs that stand together — separated
 * only by blank lines — such as the list at the bottom of a note. */
function definitionRuns(doc: Text): DefBlock[][] {
  const runs: DefBlock[][] = [];
  let run: DefBlock[] = [];
  let fence = false;
  for (let n = 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (/^\s*(```|~~~)/.test(text)) fence = !fence;
    const m = fence ? null : DEF.exec(text);
    if (!m) {
      if (text.trim() !== "" && run.length) (runs.push(run), (run = []));
      continue;
    }
    let last = n;
    for (let k = n + 1; k <= doc.lines; k++) {
      const next = doc.line(k).text;
      if (INDENTED.test(next)) last = k;
      else if (next.trim() === "" && k < doc.lines && INDENTED.test(doc.line(k + 1).text)) continue;
      else break;
    }
    run.push({ label: m[1], first: n, last });
    n = last;
  }
  if (run.length) runs.push(run);
  return runs;
}

/** Changes that put footnotes in reading order: numeric labels become their
 * position (`[^1]`, `[^2]`, … top to bottom) and each group of definitions is
 * sorted by number. Word labels keep their names; definitions no reference
 * points to go after the referenced ones. `rename` maps old labels to new. */
export function renumberChanges(doc: Text): { changes: { from: number; to: number; insert: string }[]; rename: Map<string, string> } {
  const marks = scanMarks(doc);
  const order = footnoteNumbers(doc);
  const rename = new Map<string, string>();
  for (const [label, n] of order) if (/^\d+$/.test(label)) rename.set(label, String(n));
  let next = order.size;
  const rank = new Map(order);
  for (const m of marks) {
    if (!m.def || rank.has(m.label)) continue;
    rank.set(m.label, ++next);
    if (/^\d+$/.test(m.label)) rename.set(m.label, String(next));
  }
  const relabel = (from: number, to: number) => {
    let text = doc.sliceString(from, to);
    for (const m of marks.filter((m) => m.from >= from && m.to <= to).reverse()) {
      const label = rename.get(m.label);
      if (label !== undefined) text = text.slice(0, m.from + 2 - from) + label + text.slice(m.to - 1 - from);
    }
    return text;
  };

  const changes: { from: number; to: number; insert: string }[] = [];
  const sorted: [number, number][] = [];
  for (const run of definitionRuns(doc)) {
    if (run.length < 2) continue;
    const want = [...run].sort((a, b) => (rank.get(a.label) ?? Infinity) - (rank.get(b.label) ?? Infinity));
    if (want.every((b, i) => b === run[i])) continue;
    const from = doc.line(run[0].first).from;
    const to = doc.line(run[run.length - 1].last).to;
    // Keep the run's spacing: blank lines between notes if it had them.
    const gap = run.some((b, i) => i > 0 && b.first > run[i - 1].last + 1) ? "\n\n" : "\n";
    const insert = want.map((b) => relabel(doc.line(b.first).from, doc.line(b.last).to)).join(gap);
    changes.push({ from, to, insert });
    sorted.push([from, to]);
  }
  for (const m of marks) {
    const label = rename.get(m.label);
    if (label === undefined || label === m.label) continue;
    if (sorted.some(([a, b]) => m.from >= a && m.to <= b)) continue;
    changes.push({ from: m.from + 2, to: m.to - 1, insert: label });
  }
  return { changes, rename };
}

// ------------------------------------------------------------ footnote peek

/** A `[^label]` reference that isn't a definition, with the footnoted word in
 * front of it: the caret anywhere in `word[^1]` shows the footnote. */
const REF = /\[\^([^\]\s]+)\](?!:)/g;

interface Ref {
  label: string;
  /** Start of the footnoted word (or of the marker if it stands alone). */
  from: number;
  /** Start and end of the `[^label]` marker. */
  mark: number;
  to: number;
}

function refAt(state: EditorState, pos: number, side: "caret" | "hover"): Ref | null {
  const line = state.doc.lineAt(pos);
  for (const m of line.text.matchAll(REF)) {
    const s = line.from + m.index!;
    const e = s + m[0].length;
    let w = m.index!;
    while (w > 0 && !/[\s\]\)]/.test(line.text[w - 1])) w--;
    const from = line.from + w;
    // Hovering: the marker itself. Caret: the word and the marker.
    const start = side === "hover" ? s : from;
    if (pos >= start && pos <= e) return { label: m[1], from, mark: s, to: e };
  }
  return null;
}

/** The text of `[^label]: …`, with indented continuation lines. */
export function footnoteText(doc: Text, label: string): string | null {
  const head = `[^${label}]:`;
  let fence = false;
  for (let n = 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (/^\s*(```|~~~)/.test(text)) fence = !fence;
    if (fence || !text.startsWith(head)) continue;
    const out = [text.slice(head.length).trim()];
    for (let k = n + 1; k <= doc.lines; k++) {
      const next = doc.line(k).text;
      if (/^( {2,}|\t)\S/.test(next)) out.push(next.trim());
      else if (next.trim() === "" && k < doc.lines && /^( {2,}|\t)\S/.test(doc.line(k + 1).text)) out.push("");
      else break;
    }
    return out.join("\n").trim();
  }
  return null;
}

function peekDom(view: EditorView, label: string): { dom: HTMLElement } {
  const dom = document.createElement("div");
  dom.className = "cm-nz-fn-peek";
  const head = document.createElement("div");
  head.className = "cm-nz-preview-head";
  head.textContent = `${t("Footnote")} ${footnoteNumbers(view.state.doc).get(label) ?? label}`;
  const body = document.createElement("div");
  body.className = "cm-nz-preview-body markdown";
  const text = footnoteText(view.state.doc, label);
  if (text === null) {
    dom.classList.add("missing");
    body.textContent = t("Footnote {label} has no definition", { label });
  } else {
    body.textContent = text;
    void previewHtml(text)
      .then((html) => {
        body.innerHTML = html;
        hydrateImages(body);
      })
      .catch(() => {});
  }
  dom.append(head, body);
  return { dom };
}

function caretTooltip(state: EditorState): Tooltip | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const ref = refAt(state, sel.head, "caret");
  if (!ref) return null;
  return { pos: ref.from, end: ref.to, above: true, create: (view) => peekDom(view, ref.label) };
}

const caretPeek = StateField.define<Tooltip | null>({
  create: caretTooltip,
  update(tip, tr) {
    if (!tr.docChanged && !tr.selection) return tip;
    const next = caretTooltip(tr.state);
    // Keep the same tooltip while the caret moves within one reference.
    if (tip && next && !tr.docChanged && tip.pos === next.pos && tip.end === next.end) return tip;
    return next;
  },
  provide: (f) => showTooltip.from(f),
});

const hoverPeek = hoverTooltip(
  (view, pos) => {
    const ref = refAt(view.state, pos, "hover");
    if (!ref) return null;
    // The caret is already showing this one.
    const shown = view.state.field(caretPeek, false);
    if (shown && shown.end === ref.to) return null;
    return { pos: ref.mark, end: ref.to, above: true, create: (v) => peekDom(v, ref.label) };
  },
  { hoverTime: 300 },
);

/** Shows a footnote's text when the caret is on the footnoted word, or the
 * mouse is over its marker — no scrolling to the bottom to read it. */
export const footnotePeek: Extension = [caretPeek, hoverPeek];
