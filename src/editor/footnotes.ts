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
  head.textContent = `${t("Footnote")} ${label}`;
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
