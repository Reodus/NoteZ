// Formatting actions behind the toolbar. Markdown uses NoteZ attribute
// syntax (`::: {align=center}` blocks, `[text]{color=red}` spans); Typst
// files get native Typst markup.
import { EditorSelection, EditorState, Line, SelectionRange } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { state as store } from "../core/store";
import { setFrontmatter } from "../core/frontmatter";

export const isTypst = () => !!store.active?.endsWith(".typ");

// ------------------------------------------------------------ attributes

export type Attrs = Record<string, string>;

export function parseAttrs(s: string): Attrs {
  const out: Attrs = {};
  const re = /([^\s=]+)(?:=(?:"([^"]*)"|(\S+)))?/g;
  let m: RegExpExecArray | null;
  const body = s.trim().replace(/^\{/, "").replace(/\}$/, "");
  while ((m = re.exec(body))) out[m[1]] = m[2] ?? m[3] ?? "";
  return out;
}

export function formatAttrs(a: Attrs): string {
  return Object.entries(a)
    .map(([k, v]) => (v === "" ? k : /[\s"{}]/.test(v) ? `${k}="${v.replace(/"/g, "")}"` : `${k}=${v}`))
    .join(" ");
}

// ---------------------------------------------------------------- inline

export type InlineKind = "bold" | "italic" | "strike" | "code" | "underline";

const MD_MARKS: Record<InlineKind, [string, string]> = {
  bold: ["**", "**"],
  italic: ["*", "*"],
  strike: ["~~", "~~"],
  code: ["`", "`"],
  underline: ["<u>", "</u>"],
};

const TYP_MARKS: Record<InlineKind, [string, string]> = {
  bold: ["*", "*"],
  italic: ["_", "_"],
  strike: ["#strike[", "]"],
  code: ["`", "`"],
  underline: ["#underline[", "]"],
};

/** Markdown syntax nodes for each inline style, and their marker nodes. */
const MD_NODES: Partial<Record<InlineKind, { node: string; mark: string }>> = {
  bold: { node: "StrongEmphasis", mark: "EmphasisMark" },
  italic: { node: "Emphasis", mark: "EmphasisMark" },
  strike: { node: "Strikethrough", mark: "StrikethroughMark" },
  code: { node: "InlineCode", mark: "CodeMark" },
};

/** Opening and closing marker ranges of a formatted span. */
interface Span {
  open: [number, number];
  close: [number, number];
}

/**
 * The `kind` span that contains `range` (cursor anywhere in it, markers
 * included), e.g. the cursor inside **blah** → the bold around it.
 */
export function enclosingSpan(state: EditorState, range: { from: number; to: number }, kind: InlineKind): Span | null {
  const typ = isTypst();
  const spec = typ ? undefined : MD_NODES[kind];
  if (spec) {
    const tree = syntaxTree(state);
    for (const side of [1, -1] as const) {
      for (let n: any = tree.resolveInner(range.from, side); n; n = n.parent) {
        if (n.name !== spec.node || n.from > range.from || n.to < range.to) continue;
        const marks: { from: number; to: number }[] = [];
        for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === spec.mark) marks.push({ from: c.from, to: c.to });
        if (marks.length < 2) continue;
        const a = marks[0];
        const b = marks[marks.length - 1];
        return { open: [a.from, a.to], close: [b.from, b.to] };
      }
    }
    return null;
  }
  // Underline (<u>…</u>) and Typst markup: scan the line.
  const [open, close] = (typ ? TYP_MARKS : MD_MARKS)[kind];
  const line = state.doc.lineAt(range.from);
  if (range.to > line.to) return null;
  const t = line.text;
  let best: Span | null = null;
  for (let i = t.indexOf(open); i >= 0; i = t.indexOf(open, i + 1)) {
    const j = t.indexOf(close, i + open.length);
    if (j < 0) break;
    const s = line.from + i;
    const e = line.from + j + close.length;
    if (s <= range.from && e >= range.to) best = { open: [s, s + open.length], close: [line.from + j, e] };
    if (s > range.to) break;
    i = j + close.length - 1;
  }
  return best;
}

/** Is the cursor/selection inside a `kind` span? (Toolbar button state.) */
export function inlineActive(state: EditorState, kind: InlineKind): boolean {
  const r = state.selection.main;
  if (enclosingSpan(state, r, kind)) return true;
  const [open, close] = (isTypst() ? TYP_MARKS : MD_MARKS)[kind];
  return !r.empty && state.sliceDoc(r.from - open.length, r.from) === open && state.sliceDoc(r.to, r.to + close.length) === close;
}

/** Remove the markers of `span`, keeping `range` on the same text. */
function unwrap(span: Span, range: SelectionRange) {
  const [os, oe] = span.open;
  const [cs, ce] = span.close;
  const map = (p: number) => p - Math.max(0, Math.min(p, oe) - os) - Math.max(0, Math.min(p, ce) - cs);
  return {
    changes: [
      { from: os, to: oe },
      { from: cs, to: ce },
    ],
    range: EditorSelection.range(map(range.anchor), map(range.head)),
  };
}

export function toggleInline(view: EditorView, kind: InlineKind) {
  const [open, close] = (isTypst() ? TYP_MARKS : MD_MARKS)[kind];
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      // Inside a formatted span (cursor anywhere in **blah**): remove it.
      const span = enclosingSpan(state, range, kind);
      if (span) return unwrap(span, range);
      const text = state.sliceDoc(range.from, range.to);
      const before = state.sliceDoc(range.from - open.length, range.from);
      const after = state.sliceDoc(range.to, range.to + close.length);
      // Unwrap if already wrapped (markers just outside the selection)…
      if (before === open && after === close) {
        return {
          changes: [
            { from: range.from - open.length, to: range.from },
            { from: range.to, to: range.to + close.length },
          ],
          range: EditorSelection.range(range.from - open.length, range.to - open.length),
        };
      }
      // …or inside it.
      if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
        const inner = text.slice(open.length, text.length - close.length);
        return {
          changes: { from: range.from, to: range.to, insert: inner },
          range: EditorSelection.range(range.from, range.from + inner.length),
        };
      }
      if (range.empty) {
        // Wrap the word under the cursor, or insert empty markers.
        const word = state.wordAt(range.head);
        if (word) {
          return {
            changes: [
              { from: word.from, insert: open },
              { from: word.to, insert: close },
            ],
            range: EditorSelection.cursor(range.head + open.length),
          };
        }
        return {
          changes: { from: range.from, insert: open + close },
          range: EditorSelection.cursor(range.from + open.length),
        };
      }
      return {
        changes: [
          { from: range.from, insert: open },
          { from: range.to, insert: close },
        ],
        range: EditorSelection.range(range.from + open.length, range.to + open.length),
      };
    }),
  );
  view.focus();
}

/** Inline span attributes: font, size, color, highlight… (null removes). */
export function applySpan(view: EditorView, changes: Record<string, string | null>) {
  if (isTypst()) return applyTypstSpan(view, changes);
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  // Existing span around the selection?
  const re = /\[([^\]]*)\]\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line.text))) {
    const start = line.from + m.index;
    const end = start + m[0].length;
    const innerStart = start + 1;
    const innerEnd = innerStart + m[1].length;
    if (range.from >= start && range.to <= end && (range.from >= innerStart || range.empty) && range.to <= Math.max(innerEnd, range.from)) {
      const attrs = { ...parseAttrs(m[2]) };
      // Applying the value the span already has removes it (toggle).
      const same = Object.entries(changes).every(([k, v]) => v !== null && attrs[k] === v);
      if (same) for (const k of Object.keys(changes)) changes = { ...changes, [k]: null };
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) delete attrs[k];
        else attrs[k] = v;
      }
      const insert = Object.keys(attrs).length ? `[${m[1]}]{${formatAttrs(attrs)}}` : m[1];
      view.dispatch({
        changes: { from: start, to: end, insert },
        selection: { anchor: start + (Object.keys(attrs).length ? 1 : 0), head: start + (Object.keys(attrs).length ? 1 : 0) + m[1].length },
      });
      view.focus();
      return;
    }
  }
  const attrs: Attrs = {};
  for (const [k, v] of Object.entries(changes)) if (v !== null) attrs[k] = v;
  if (!Object.keys(attrs).length) return;
  let { from, to } = range;
  if (range.empty) {
    const w = state.wordAt(range.head);
    if (w) ({ from, to } = w);
  }
  const text = state.sliceDoc(from, to) || "text";
  const insert = `[${text}]{${formatAttrs(attrs)}}`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + 1, head: from + 1 + text.length },
  });
  view.focus();
}

function applyTypstSpan(view: EditorView, changes: Record<string, string | null>) {
  const { state } = view;
  const r = state.selection.main;
  const text = state.sliceDoc(r.from, r.to) || "text";
  const args: string[] = [];
  let wrapHighlight: string | null = null;
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) continue;
    if (k === "font") args.push(`font: "${v}"`);
    if (k === "size") args.push(`size: ${v}`);
    if (k === "color") args.push(`fill: rgb("${v}")`);
    if (k === "highlight") wrapHighlight = v;
  }
  let insert = args.length ? `#text(${args.join(", ")})[${text}]` : text;
  if (wrapHighlight) insert = `#highlight(fill: rgb("${wrapHighlight}"))[${insert}]`;
  view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: { anchor: r.from + insert.length } });
  view.focus();
}

// ---------------------------------------------------------- block styles

export type BlockStyle = "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "quote";

const MD_PREFIX = /^(#{1,6}\s+|>\s?)/;
const TYP_PREFIX = /^(={1,6}\s+)/;

export function blockStyleAt(state: EditorState, pos: number): BlockStyle {
  const text = state.doc.lineAt(pos).text;
  if (isTypst()) {
    const m = /^(={1,6})\s/.exec(text);
    return m ? (`h${m[1].length}` as BlockStyle) : "p";
  }
  const m = /^(#{1,6})\s/.exec(text);
  if (m) return `h${m[1].length}` as BlockStyle;
  if (/^>\s?/.test(text)) return "quote";
  return "p";
}

function selectedLines(state: EditorState): Line[] {
  const seen = new Set<number>();
  const lines: Line[] = [];
  for (const r of state.selection.ranges) {
    for (let p = r.from; p <= r.to; ) {
      const l = state.doc.lineAt(p);
      if (!seen.has(l.number)) {
        seen.add(l.number);
        lines.push(l);
      }
      p = l.to + 1;
    }
  }
  return lines;
}

export function setBlockStyle(view: EditorView, style: BlockStyle) {
  const typ = isTypst();
  // Applying the style every selected line already has turns it off.
  if (style !== "p" && selectedLines(view.state).every((l) => blockStyleAt(view.state, l.from) === style)) style = "p";
  const changes = selectedLines(view.state).map((l) => {
    const strip = l.text.replace(typ ? TYP_PREFIX : MD_PREFIX, "");
    let prefix = "";
    if (style.startsWith("h")) prefix = (typ ? "=" : "#").repeat(Number(style[1])) + " ";
    if (style === "quote") prefix = typ ? "" : "> ";
    return { from: l.from, to: l.to, insert: prefix + strip };
  });
  view.dispatch({ changes });
  if (typ && style === "quote") wrapParagraph(view, "#quote(block: true)[", "]");
  view.focus();
}

/**
 * Make the current line the document title (Word's "Title" style).
 * Markdown: the text moves into the frontmatter `title:` (shown above the
 * note and typeset with the theme's Title style); Typst: `#title[…]`.
 */
export function setTitle(view: EditorView) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (isTypst()) {
    const text = line.text.replace(/^(={1,6}\s+)/, "").replace(/^#title\[(.*)\]\s*$/, "$1");
    const insert = `#title[${text}]`;
    view.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + insert.length } });
    view.focus();
    return;
  }
  const text = line.text.replace(MD_PREFIX, "").trim();
  if (!text) return;
  // Remove the line (and the blank line after it), then store the title.
  const doc = view.state.doc;
  const next = line.number < doc.lines ? doc.line(line.number + 1) : null;
  const to = next ? (next.text.trim() ? next.from : Math.min(doc.length, next.to + 1)) : line.to;
  const from = !next && line.number > 1 ? line.from - 1 : line.from;
  view.dispatch({ changes: { from, to, insert: "" } });
  setFrontmatter(view, ["title"], text);
  view.focus();
}

// --------------------------------------------------- lists & paragraphs

export function toggleList(view: EditorView, kind: "bullet" | "number" | "task") {
  const typ = isTypst();
  const lines = selectedLines(view.state);
  const re = /^(\s*)([-*+]\s\[[ xX]\]\s|[-*+]\s|\d+[.)]\s|\+\s)/;
  const all = lines.every((l) => {
    const m = re.exec(l.text);
    if (!m) return false;
    const marker = m[2];
    return kind === "task" ? /\[[ xX]\]/.test(marker) : kind === "number" ? /\d|^\+/.test(marker) : /^[-*]\s$/.test(marker);
  });
  let n = 0;
  const changes = lines
    .filter((l) => l.text.trim() || lines.length === 1)
    .map((l) => {
      const m = re.exec(l.text);
      const indent = m ? m[1] : /^\s*/.exec(l.text)![0];
      const body = m ? l.text.slice(m[0].length) : l.text.trimStart();
      if (all) return { from: l.from, to: l.to, insert: indent + body };
      n++;
      const marker = kind === "bullet" ? "- " : kind === "task" ? (typ ? "- ☐ " : "- [ ] ") : typ ? "+ " : `${n}. `;
      return { from: l.from, to: l.to, insert: indent + marker + body };
    });
  view.dispatch({ changes });
  view.focus();
}

/** Line numbers [first, last] of the paragraph at `pos` (stops at blank lines, fences, ::: lines). */
function paragraphAt(state: EditorState, pos: number): [number, number] {
  const isStop = (t: string) => !t.trim() || /^\s*(:::|```|~~~)/.test(t);
  const cur = state.doc.lineAt(pos).number;
  let a = cur;
  let b = cur;
  if (isStop(state.doc.line(cur).text)) return [cur, cur];
  while (a > 1 && !isStop(state.doc.line(a - 1).text)) a--;
  while (b < state.doc.lines && !isStop(state.doc.line(b + 1).text)) b++;
  return [a, b];
}

function wrapParagraph(view: EditorView, open: string, close: string) {
  const s = view.state;
  const sel = s.selection.main;
  const [a] = paragraphAt(s, sel.from);
  const [, b] = paragraphAt(s, sel.to);
  const from = s.doc.line(a).from;
  const to = s.doc.line(b).to;
  view.dispatch({ changes: [{ from, insert: open + "\n" }, { from: to, insert: "\n" + close }] });
}

// ----------------------------------------------- divs: align / direction

interface Div {
  open: Line;
  close: Line | null;
  attrs: Attrs;
}

/** The innermost `::: {…}` block containing line `n`. */
function divAt(state: EditorState, n: number): Div | null {
  let depth = 0;
  for (let i = n; i >= 1; i--) {
    const t = state.doc.line(i).text.trim();
    if (/^:::\s*$/.test(t) && i !== n) depth++;
    else if (/^:::\s*\S/.test(t)) {
      if (depth === 0) {
        const open = state.doc.line(i);
        let d = 0;
        let close: Line | null = null;
        for (let j = i + 1; j <= state.doc.lines; j++) {
          const tj = state.doc.line(j).text.trim();
          if (/^:::\s*\S/.test(tj)) d++;
          else if (/^:::\s*$/.test(tj)) {
            if (d === 0) {
              close = state.doc.line(j);
              break;
            }
            d--;
          }
        }
        if (close && close.number < n) return null;
        return { open, close, attrs: parseAttrs(t.replace(/^:::\s*/, "")) };
      }
      depth--;
    }
  }
  return null;
}

export function blockAttr(state: EditorState, pos: number, key: string): string | null {
  if (isTypst()) {
    if (key !== "align") return null;
    const n = state.doc.lineAt(pos).number;
    for (let i = n; i >= Math.max(1, n - 30); i--) {
      const m = /^#align\((\w+)\)\[\s*$/.exec(state.doc.line(i).text.trim());
      if (m) return m[1];
      if (i !== n && /^\]\s*$/.test(state.doc.line(i).text.trim())) return null;
    }
    return null;
  }
  return divAt(state, state.doc.lineAt(pos).number)?.attrs[key] ?? null;
}

/** Set (or with null, remove) a block attribute for the paragraph(s) at the cursor. */
export function setBlockAttr(view: EditorView, key: string, value: string | null) {
  if (isTypst()) return setTypstAlign(view, key === "align" ? value : null);
  const s = view.state;
  const sel = s.selection.main;
  const div = divAt(s, s.doc.lineAt(sel.from).number);
  if (div) {
    const attrs = { ...div.attrs };
    if (value === null) delete attrs[key];
    else attrs[key] = value;
    if (Object.keys(attrs).length === 0 && div.close) {
      view.dispatch({
        changes: [
          { from: div.open.from, to: Math.min(div.open.to + 1, s.doc.length) },
          { from: div.close.from - 1, to: div.close.to },
        ],
      });
    } else {
      view.dispatch({ changes: { from: div.open.from, to: div.open.to, insert: `::: {${formatAttrs(attrs)}}` } });
    }
  } else if (value !== null) {
    wrapParagraph(view, `::: {${key}=${value}}`, ":::");
  }
  view.focus();
}

function setTypstAlign(view: EditorView, value: string | null) {
  const s = view.state;
  const n = s.doc.lineAt(s.selection.main.from).number;
  for (let i = n; i >= Math.max(1, n - 30); i--) {
    const line = s.doc.line(i);
    if (/^#align\(\w+\)\[\s*$/.test(line.text.trim())) {
      if (value === null) {
        // Remove the wrapper: find the matching closing bracket line.
        for (let j = i + 1; j <= s.doc.lines; j++) {
          const lj = s.doc.line(j);
          if (/^\]\s*$/.test(lj.text.trim())) {
            view.dispatch({ changes: [{ from: line.from, to: line.to + 1 }, { from: lj.from - 1, to: lj.to }] });
            return;
          }
        }
        return;
      }
      view.dispatch({ changes: { from: line.from, to: line.to, insert: `#align(${value})[` } });
      return;
    }
  }
  if (value) wrapParagraph(view, `#align(${value})[`, "]");
  view.focus();
}

// --------------------------------------------------------------- insert

export function insertText(view: EditorView, text: string, cursorOffset?: number) {
  const r = view.state.selection.main;
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: text },
    selection: { anchor: r.from + (cursorOffset ?? text.length) },
    scrollIntoView: true,
  });
  view.focus();
}

/** Insert a block on its own lines (adds blank lines around as needed). */
export function insertBlock(view: EditorView, block: string, cursorInBlock?: number) {
  const s = view.state;
  const line = s.doc.lineAt(s.selection.main.head);
  const atEmpty = !line.text.trim();
  const pos = atEmpty ? line.from : line.to;
  const before = atEmpty ? (line.number > 1 && s.doc.line(line.number - 1).text.trim() ? "\n" : "") : "\n\n";
  const text = `${before}${block}\n`;
  view.dispatch({
    changes: { from: pos, to: atEmpty ? line.to : pos, insert: text },
    selection: { anchor: pos + before.length + (cursorInBlock ?? block.length) },
    scrollIntoView: true,
  });
  view.focus();
}

export function insertTable(view: EditorView, rows: number, cols: number) {
  if (isTypst()) {
    const cells = Array.from({ length: rows * cols }, (_, i) => (i < cols ? `[*Header ${i + 1}*]` : "[]"));
    insertBlock(view, `#table(\n  columns: ${cols},\n  ${cells.join(", ")}\n)`);
    return;
  }
  const head = "| " + Array.from({ length: cols }, (_, i) => `Header ${i + 1}`).join(" | ") + " |";
  const sep = "|" + Array.from({ length: cols }, () => " --- |").join("");
  const row = "| " + Array.from({ length: cols }, () => "   ").join(" | ") + " |";
  insertBlock(view, [head, sep, ...Array.from({ length: Math.max(1, rows - 1) }, () => row)].join("\n"), 2);
}

export function insertLink(view: EditorView) {
  const r = view.state.selection.main;
  const text = view.state.sliceDoc(r.from, r.to) || "link";
  if (isTypst()) {
    const ins = `#link("https://")[${text}]`;
    insertText(view, ins, 7);
    view.dispatch({ selection: { anchor: r.from + 7, head: r.from + 15 } });
  } else {
    insertText(view, `[${text}](https://)`, text.length + 3);
    view.dispatch({ selection: { anchor: r.from + text.length + 3, head: r.from + text.length + 11 } });
  }
}

export function insertImage(view: EditorView, vaultPath: string) {
  if (isTypst()) insertBlock(view, `#figure(image("/${vaultPath}", width: 80%), caption: [])`);
  else insertBlock(view, `![](${encodeURI(vaultPath)})`, 2);
}

export function insertMath(view: EditorView, display: boolean) {
  if (isTypst()) {
    display ? insertBlock(view, "$ x^2 + y^2 = z^2 $", 2) : insertText(view, "$x$", 1);
  } else {
    display ? insertBlock(view, "$$\n\\frac{a}{b}\n$$", 3) : insertText(view, "$x$", 1);
  }
}

export function insertPageBreak(view: EditorView) {
  insertBlock(view, isTypst() ? "#pagebreak()" : "<!-- pagebreak -->");
}

export function insertToc(view: EditorView) {
  insertBlock(view, isTypst() ? "#outline()" : "<!-- toc -->");
}

export function insertFootnote(view: EditorView) {
  if (isTypst()) return insertText(view, "#footnote[]", 10);
  const doc = view.state.doc.toString();
  let n = 1;
  while (doc.includes(`[^${n}]`)) n++;
  const r = view.state.selection.main;
  view.dispatch({
    changes: [
      { from: r.to, insert: `[^${n}]` },
      { from: view.state.doc.length, insert: `${doc.endsWith("\n") ? "" : "\n"}\n[^${n}]: ` },
    ],
    selection: { anchor: view.state.doc.length + `[^${n}]`.length + (doc.endsWith("\n") ? 1 : 2) + `[^${n}]: `.length },
    scrollIntoView: true,
  });
  view.focus();
}

/** Insert a fenced special block (```chart … ```). */
export function insertFenced(view: EditorView, lang: string, code: string) {
  if (isTypst() && lang === "typst") return insertBlock(view, code);
  insertBlock(view, "```" + lang + "\n" + code.trimEnd() + "\n```", lang.length + 4);
}

/** Colors used for callouts in the PDF (core/src/render/md.rs callout_style). */
const CALLOUT_COLOR: Record<string, string> = {
  tip: "#1f9d55", success: "#1f9d55", important: "#8a4fd8", example: "#8a4fd8", warning: "#c98a10",
  caution: "#d13c3c", danger: "#d13c3c", bug: "#d13c3c", question: "#0e8f9e", abstract: "#0e8f9e",
  quote: "#7a7f8f", todo: "#2f6fde", info: "#2f6fde", note: "#2f6fde",
};

const CALLOUT_HEAD = /^(\s*>\s*)\[!([^\]]+)\]([+-]?)/;

/**
 * Insert an Obsidian callout (`> [!type]`). On a callout header line its type
 * changes; with a selection (or on a line of text) the lines go inside it.
 * `fold`: "" = always open, "+" = foldable (open), "-" = foldable (closed).
 */
export function insertCallout(view: EditorView, type: string, fold: "" | "+" | "-" = "") {
  const s = view.state;
  const T = type.toUpperCase();
  if (isTypst()) {
    const color = CALLOUT_COLOR[type] ?? CALLOUT_COLOR.note;
    const title = type[0].toUpperCase() + type.slice(1);
    const open = `#block(width: 100%, inset: 10pt, radius: 4pt, fill: rgb("${color}").lighten(90%), stroke: (left: 3pt + rgb("${color}")))[\n  #text(weight: "bold", fill: rgb("${color}"))[${title}] \\\n  `;
    insertBlock(view, `${open}\n]`, open.length);
    return;
  }
  const head = s.doc.lineAt(s.selection.main.head);
  // Already a callout: retype it (search up to its header).
  for (let n = head.number; n >= 1; n--) {
    const l = s.doc.line(n);
    if (!/^\s*>/.test(l.text)) break;
    const m = CALLOUT_HEAD.exec(l.text);
    if (m) {
      const from = l.from + m[1].length;
      view.dispatch({ changes: { from, to: from + m[0].length - m[1].length, insert: `[!${T}]${fold}` } });
      view.focus();
      return;
    }
  }
  const sel = s.selection.main;
  const lines = selectedLines(s);
  const hasText = !sel.empty || head.text.trim().length > 0;
  if (!hasText) {
    insertBlock(view, `> [!${T}]${fold} \n> `);
    return;
  }
  const first = lines[0];
  const last = lines[lines.length - 1];
  const body = lines.map((l) => "> " + l.text.replace(/^\s*>\s?/, "")).join("\n");
  const insert = `> [!${T}]${fold} \n${body}`;
  view.dispatch({
    changes: { from: first.from, to: last.to, insert },
    selection: { anchor: first.from + insert.length },
    scrollIntoView: true,
  });
  view.focus();
}
