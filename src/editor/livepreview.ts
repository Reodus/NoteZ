// Live preview (Obsidian-style): Markdown syntax is hidden and rendered —
// headings without `#`, bold without `**`, links as links, checkboxes,
// math, images, rules — everywhere except on the lines the cursor is on,
// where the raw source comes back for editing.
import { EditorState, Extension, Range, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { fileSrc } from "../core/native";
import { parseAttrs } from "./format";
import { canRender, previewsEnabled } from "./widgets";
import { TableWidget, rawTableField } from "./tables";
import { PropertiesWidget } from "./properties";

export interface LiveOptions {
  /** Open a link target (note name, path or URL). */
  openLink: (target: string) => void;
  /** Vault-relative path of the note being edited (for images). */
  notePath: () => string | null;
  vaultRoot: () => string | null;
  /** Absolute path of an image (relative or Obsidian-style bare name). */
  resolveAsset?: (note: string, url: string) => Promise<string | null>;
}

let liveOpts: LiveOptions | null = null;
export const getLiveOpts = () => liveOpts;
const resolved = new Map<string, Promise<string | null>>();

/** Image URL the webview can load, or null when the file can't be found. */
function resolveImage(src: string): Promise<string | null> {
  if (/^(https?:|data:)/.test(src)) return Promise.resolve(src);
  const o = liveOpts;
  if (!o?.resolveAsset) return Promise.resolve(null);
  const note = o.notePath() ?? "";
  const key = `${note}\0${src}`;
  let p = resolved.get(key);
  if (!p) {
    p = o
      .resolveAsset(note, decodeURI(src.split(/[?#]/)[0]))
      .then((abs) => (abs ? fileSrc(abs) : null))
      .catch(() => null)
      .then((u) => {
        if (!u) resolved.delete(key); // retry later (file may appear)
        return u;
      });
    resolved.set(key, p);
  }
  return p;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;

const HIDE = Decoration.replace({});

// ---------------------------------------------------------------- widgets

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-nz-lp-bullet";
    s.textContent = "•";
    return s;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-nz-lp-check";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      const text = view.state.sliceDoc(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(text)) return;
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-nz-lp-hr";
    return s;
  }
}

class ChipWidget extends WidgetType {
  constructor(readonly label: string, readonly kind: string) {
    super();
  }
  eq(o: ChipWidget) {
    return o.label === this.label && o.kind === this.kind;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = `cm-nz-lp-chip ${this.kind}`;
    s.textContent = this.label;
    return s;
  }
}

let katexP: Promise<typeof import("katex").default> | null = null;
const loadKatex = () =>
  (katexP ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([k]) => k.default));
const mathCache = new Map<string, string>();

/** Clicking a rendered formula puts the cursor inside its source. */
function editOnClick(el: HTMLElement, view: EditorView, offset: (from: number) => number) {
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const from = view.posAtDOM(el);
    view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, offset(from)) } });
    view.focus();
  });
}

class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean) {
    super();
  }
  eq(o: MathWidget) {
    return o.tex === this.tex && o.display === this.display;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    // `$x$` → just after the `$`; one-line `$$x$$` → after the `$$`.
    editOnClick(el, view, (from) => {
      const line = view.state.doc.lineAt(from);
      const lead = this.display ? /^\s*\$\$/.exec(line.text)?.[0].length ?? 2 : 1;
      return this.display ? line.from + lead : from + 1;
    });
    el.className = this.display ? "cm-nz-lp-math display" : "cm-nz-lp-math";
    el.dir = "ltr";
    const key = (this.display ? "D" : "I") + this.tex;
    const cached = mathCache.get(key);
    if (cached) el.innerHTML = cached;
    else {
      el.textContent = this.tex;
      loadKatex().then((katex) => {
        const html = katex.renderToString(this.tex, { displayMode: this.display, throwOnError: false, output: "html" });
        mathCache.set(key, html);
        el.innerHTML = html;
      });
    }
    return el;
  }
}

/** A display formula on its own block (for multi-line $$ … $$). */
class MathBlockWidget extends WidgetType {
  constructor(readonly tex: string) {
    super();
  }
  eq(o: MathBlockWidget) {
    return o.tex === this.tex;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    // Multi-line $$ … $$ → start of the first formula line.
    editOnClick(el, view, (from) => {
      const doc = view.state.doc;
      const first = doc.lineAt(from);
      // Shown under its source while editing: the cursor is already there.
      if (from > first.from) return view.state.selection.main.head;
      if (first.text.trim() !== "$$" || first.number >= doc.lines) return first.from + first.text.indexOf("$$") + 2;
      return doc.line(first.number + 1).to;
    });
    el.className = "cm-nz-lp-mathblock";
    el.dir = "ltr";
    const key = "D" + this.tex;
    const cached = mathCache.get(key);
    if (cached) el.innerHTML = cached;
    else {
      el.textContent = this.tex;
      loadKatex().then((katex) => {
        const html = katex.renderToString(this.tex, { displayMode: true, throwOnError: false, output: "html" });
        mathCache.set(key, html);
        el.innerHTML = html;
      });
    }
    return el;
  }
}

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly width: string | null) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt && o.width === this.width;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-nz-lp-image";
    const img = document.createElement("img");
    img.alt = this.alt;
    if (this.width) img.style.width = `${this.width}px`;
    const missing = () => {
      wrap.textContent = `🖼 ${this.alt || this.src}`;
      wrap.classList.add("missing");
    };
    img.onerror = missing;
    resolveImage(this.src).then((u) => (u ? (img.src = u) : missing()));
    wrap.appendChild(img);
    return wrap;
  }
}

/** `![[doc.pdf]]`, `![[doc.pdf#page=3|500]]`: the PDF in Chromium's viewer. */
class PdfWidget extends WidgetType {
  /** `|300` = width in px (as in the PDF export); `#height=400` = viewer height. */
  constructor(readonly src: string, readonly page: string | null, readonly width: string | null, readonly height: string | null = null) {
    super();
  }
  eq(o: PdfWidget) {
    return o.src === this.src && o.page === this.page && o.width === this.width && o.height === this.height;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-nz-lp-pdf";
    const bar = document.createElement("span");
    bar.className = "cm-nz-lp-pdf-bar";
    bar.textContent = `📄 ${this.src.split("/").pop()}${this.page ? ` · page ${this.page}` : ""}`;
    bar.title = "Click to edit the embed";
    editOnClick(bar, view, (from) => from + 3);
    const frame = document.createElement("iframe");
    if (this.width) wrap.style.width = `${this.width}px`;
    frame.style.height = `${this.height ?? (this.width ? Math.round(Number(this.width) * 1.35) : 560)}px`;
    frame.title = this.src;
    resolveImage(this.src).then((u) => {
      if (u) frame.src = u + (this.page ? `#page=${this.page}` : "");
      else {
        wrap.classList.add("missing");
        frame.replaceWith(Object.assign(document.createElement("span"), { textContent: `missing: ${this.src}` }));
      }
    });
    wrap.append(bar, frame);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

class FootnoteWidget extends WidgetType {
  constructor(readonly label: string, readonly def: boolean) {
    super();
  }
  eq(o: FootnoteWidget) {
    return o.label === this.label && o.def === this.def;
  }
  toDOM() {
    const s = document.createElement("sup");
    s.className = this.def ? "cm-nz-lp-fn def" : "cm-nz-lp-fn";
    s.dir = "ltr";
    s.textContent = this.label;
    return s;
  }
}

class BreakWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return document.createElement("br");
  }
}

/** Load images inside rendered HTML (tables) marked with data-src. */
export function hydrateImages(root: HTMLElement) {
  root.querySelectorAll<HTMLImageElement>("img[data-src]").forEach((img) => {
    const src = img.dataset.src!;
    img.onerror = () => img.replaceWith(Object.assign(document.createElement("span"), { className: "cm-nz-lp-image missing", textContent: `🖼 ${src}` }));
    resolveImage(src).then((u) => (u ? (img.src = u) : img.onerror?.(new Event("error"))));
  });
}

export const CALLOUTS: Record<string, { label: string; icon: string; color?: string }> = {
  note: { label: "Note", icon: "ℹ" },
  info: { label: "Info", icon: "ℹ" },
  tip: { label: "Tip", icon: "💡" },
  important: { label: "Important", icon: "❕" },
  warning: { label: "Warning", icon: "⚠" },
  caution: { label: "Caution", icon: "⛔" },
  danger: { label: "Danger", icon: "⛔" },
  success: { label: "Success", icon: "✓" },
  question: { label: "Question", icon: "?" },
  quote: { label: "Quote", icon: "❝" },
  abstract: { label: "Summary", icon: "≡" },
  example: { label: "Example", icon: "☰" },
  todo: { label: "To do", icon: "☐" },
  bug: { label: "Bug", icon: "🐞" },
};

class CalloutIcon extends WidgetType {
  constructor(readonly type: string, readonly label: string) {
    super();
  }
  eq(o: CalloutIcon) {
    return o.type === this.type && o.label === this.label;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-nz-callout-icon";
    s.dir = "ltr"; // own direction → ignored by the line's dir=auto
    const i = document.createElement("b");
    i.textContent = CALLOUTS[this.type]?.icon ?? "ℹ";
    s.appendChild(i);
    if (this.label) s.append(this.label);
    return s;
  }
}

// ------------------------------------------------------ block-level parts

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Renders the `.nz-math` placeholders that `inlineHtml` emits with KaTeX. */
export function hydrateMath(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>(".nz-math[data-tex]").forEach((el) => {
    const tex = el.dataset.tex!;
    const display = el.classList.contains("display");
    const key = (display ? "D" : "I") + tex;
    el.removeAttribute("data-tex");
    const cached = mathCache.get(key);
    if (cached) return void (el.innerHTML = cached);
    loadKatex().then((katex) => {
      const html = katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "html" });
      mathCache.set(key, html);
      if (el.isConnected) el.innerHTML = html;
    });
  });
}

// `$$x$$`, or `$x$` with no space just inside the dollars and no digit right
// after the closing one (so prices like "$5 and $10" stay text). Code spans
// are matched too so the dollars inside them are left alone.
const INLINE_MATH = /`[^`]+`|(?<!\\)\$\$((?:\\.|[^$\\])+?)\$\$|(?<![\\$])\$(?=[^\s$])((?:\\.|[^$\\])+?)(?<=\S)\$(?![\d$])/g;

/** Minimal inline Markdown → HTML for table cells and properties. */
export function inlineHtml(src: string): string {
  const math: string[] = [];
  src = src.replace(/%%.*?%%/g, "").replace(INLINE_MATH, (m, d, i) => {
    if (m[0] === "`") return m;
    math.push(d === undefined ? `<span class="nz-math" dir="ltr" data-tex="${escHtml(i)}">${escHtml(m)}</span>` : `<span class="nz-math display" dir="ltr" data-tex="${escHtml(d)}">${escHtml(m)}</span>`);
    return `\u0001${math.length - 1}\u0001`;
  });
  return renderInline(src).replace(/\u0001(\d+)\u0001/g, (_, n) => math[+n]);
}

function renderInline(src: string): string {
  return escHtml(src)
    .replace(/!\[\[([^\]|]+?)(?:\|(\d+))?\]\]/g, (_, f, w) =>
      IMAGE_EXT.test(f) ? `<img data-src="${f}"${w ? ` style="width:${w}px"` : ""}>` : `<span class="cm-nz-lp-link internal" data-target="${f}">↪ ${f}</span>`,
    )
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => `<img data-src="${u}" alt="${a.split("|")[0]}">`)
    .replace(/&lt;center&gt;/gi, '<span class="cm-nz-center">')
    .replace(/&lt;\/center&gt;/gi, "</span>")
    .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
    .replace(/==([^=\s][^=]*?)==/g, '<mark class="cm-nz-lp-mark">$1</mark>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<i>$2</i>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, t, a) => `<span class="cm-nz-lp-link internal" data-target="${t}">${a || t}</span>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<span class="cm-nz-lp-link" data-target="$2">$1</span>')
    .replace(/\[([^\]]*)\]\{[^}]*\}/g, "$1");
}

class FenceWidget extends WidgetType {
  constructor(readonly lang: string, readonly closing: boolean) {
    super();
  }
  eq(o: FenceWidget) {
    return o.lang === this.lang && o.closing === this.closing;
  }
  toDOM() {
    const d = document.createElement("div");
    d.className = this.closing ? "cm-nz-lp-fence end" : "cm-nz-lp-fence";
    if (!this.closing) d.textContent = this.lang || "code";
    return d;
  }
}

function blockDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const decos: Range<Decoration>[] = [];
  const sel = state.selection.ranges;
  const touched = (from: number, to: number) => sel.some((r) => r.to >= from && r.from <= to);

  // Frontmatter → Properties card.
  if (doc.lines > 2 && doc.line(1).text === "---") {
    for (let i = 2; i <= Math.min(doc.lines, 200); i++) {
      const t = doc.line(i).text;
      if (t === "---" || t === "...") {
        const end = doc.line(i).to;
        if (!touched(0, end)) decos.push(Decoration.replace({ widget: new PropertiesWidget(doc.sliceString(0, end)), block: true }).range(0, end));
        break;
      }
    }
  }

  // Multi-line %% comments are hidden.
  for (let i = 1; i <= doc.lines; i++) {
    const t = doc.line(i).text.trim();
    if (!t.startsWith("%%") || (t.length > 2 && t.slice(2).includes("%%"))) continue;
    let j = i + 1;
    while (j <= doc.lines && !doc.line(j).text.includes("%%")) j++;
    if (j > doc.lines) break;
    const from = doc.line(i).from;
    const to = doc.line(j).to;
    if (!touched(from, to)) decos.push(Decoration.replace({ block: true }).range(from, to));
    i = j;
  }

  // Display math: $$ … $$ spanning lines (Obsidian/LaTeX style).
  {
    let fence: string | null = null;
    let open: { from: number; line: number; first: string } | null = null;
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const t = line.text.trim();
      const f = /^(`{3,}|~{3,})/.exec(t);
      if (!open && f) {
        if (!fence) fence = f[1][0];
        else if (t[0] === fence) fence = null;
        continue;
      }
      if (fence) continue;
      if (!open) {
        // Opening `$$` (a line that starts with $$ and does not also close it).
        if (t.startsWith("$$") && !(t.length > 4 && t.endsWith("$$"))) {
          open = { from: line.from, line: i, first: t.slice(2) };
          if (t !== "$$" && t.endsWith("$$") && t.length > 2) open = null;
        }
        continue;
      }
      if (t.endsWith("$$")) {
        const tex = [open.first, ...Array.from({ length: i - open.line - 1 }, (_, k) => doc.line(open!.line + 1 + k).text), t.slice(0, -2)]
          .join("\n")
          .trim();
        const to = line.to;
        const widget = new MathBlockWidget(tex);
        if (touched(open.from, to)) decos.push(Decoration.widget({ widget, block: true, side: 1 }).range(to));
        else decos.push(Decoration.replace({ widget, block: true }).range(open.from, to));
        open = null;
      }
    }
  }

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === "Table") {
        const from = doc.lineAt(node.from).from;
        const to = doc.lineAt(node.to).to;
        // Tables stay tables while editing (cells are edited in place), unless
        // "Edit as Markdown" asked for the source.
        if (state.field(rawTableField, false) !== from) {
          decos.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(from, to)), block: true }).range(from, to));
        }
        return false;
      }
      if (node.name === "FencedCode") {
        const open = doc.lineAt(node.from);
        const close = doc.lineAt(node.to);
        const m = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(open.text);
        const lang = (m?.[2] ?? "").toLowerCase();
        // Special blocks (charts, diagrams…) are drawn by the block previews.
        if (state.facet(previewsEnabled) && canRender(lang)) return false;
        if (close.number <= open.number + 1) return false;
        for (let n = open.number + 1; n < close.number; n++) {
          const cls = ["cm-nz-lp-code"];
          if (n === open.number + 1) cls.push("first");
          if (n === close.number - 1) cls.push("last");
          decos.push(Decoration.line({ class: cls.join(" ") }).range(doc.line(n).from));
        }
        if (!touched(open.from, close.to)) {
          decos.push(Decoration.replace({ widget: new FenceWidget(lang, false), block: true }).range(open.from, open.to));
          if (/^\s*(`{3,}|~{3,})\s*$/.test(close.text)) {
            decos.push(Decoration.replace({ widget: new FenceWidget(lang, true), block: true }).range(close.from, close.to));
          }
        }
        return false;
      }
    },
  });
  return Decoration.set(decos, true);
}

const blockField = StateField.define<DecorationSet>({
  create: blockDecorations,
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.reconfigured || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return blockDecorations(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// -------------------------------------------------------------- building

/** End offset of the YAML frontmatter, or -1 when the note has none. */
function frontmatterEnd(view: EditorView): number {
  const doc = view.state.doc;
  if (doc.lines < 2 || doc.line(1).text !== "---") return -1;
  for (let i = 2; i <= Math.min(doc.lines, 200); i++) {
    const t = doc.line(i).text;
    if (t === "---" || t === "...") return doc.line(i).to;
  }
  return -1;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const decos: Range<Decoration>[] = [];
  const taken: [number, number][] = [];
  const free = (from: number, to: number) => !taken.some(([a, b]) => from < b && to > a);
  const add = (from: number, to: number, deco: Decoration) => {
    if (from > to || (from < to && !free(from, to))) return;
    if (from < to) taken.push([from, to]);
    decos.push(deco.range(from, to));
  };

  // Lines touched by a selection keep their source.
  const active = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = doc.lineAt(r.from).number;
    const b = doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) active.add(i);
  }
  const isActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const fmEnd = frontmatterEnd(view);
  const tree = syntaxTree(state);
  const inCode = (pos: number) => {
    for (let n: any = tree.resolveInner(pos, 1); n; n = n.parent) {
      if (/^(FencedCode|CodeBlock|InlineCode|CodeText|HTMLBlock|Comment)$/.test(n.name)) return n.name;
    }
    return null;
  };

  /** `> [!NOTE] Title` blockquotes become colored callout boxes. */
  const calloutLines = (from: number, to: number) => {
    const first = doc.lineAt(from);
    const m = /^(\s*>\s*)\[!(\w+)\]([+-]?)\s?/.exec(first.text);
    if (!m) return;
    const kind = m[2].toLowerCase();
    const type = CALLOUTS[kind] ? kind : "note";
    const last = doc.lineAt(to);
    for (let n = first.number; n <= last.number; n++) {
      const l = doc.line(n);
      const cls = ["cm-nz-callout", `cm-nz-callout-${type}`];
      if (n === first.number) cls.push("first");
      if (n === last.number) cls.push("last");
      decos.push(Decoration.line({ class: cls.join(" ") }).range(l.from));
    }
    if (!active.has(first.number)) {
      const end = first.from + m[0].length;
      const title = first.text.slice(m[0].length).trim();
      add(first.from, end, Decoration.replace({ widget: new CalloutIcon(type, title ? "" : CALLOUTS[type]?.label ?? kind) }));
    }
  };

  for (const { from, to } of view.visibleRanges) {
    // ----- regex-based syntax (NoteZ extensions, wikilinks, math, comments)
    let pos = Math.max(from, fmEnd + 1);
    while (pos <= to && pos <= doc.length) {
      const line = doc.lineAt(pos);
      pos = line.to + 1;
      if (active.has(line.number) || line.from <= fmEnd) continue;
      const text = line.text;
      const codeAtStart = inCode(line.from);
      if (codeAtStart === "FencedCode" || codeAtStart === "CodeBlock") continue;

      // Page break / TOC comments.
      const cm = /^\s*<!--\s*(pagebreak|toc)\s*-->\s*$/i.exec(text);
      if (cm) {
        const pb = cm[1].toLowerCase() === "pagebreak";
        add(line.from, line.to, Decoration.replace({ widget: new ChipWidget(pb ? "Page break" : "Table of contents", pb ? "pagebreak" : "toc") }));
        continue;
      }
      if (/^\s*<center>/i.test(text)) decos.push(Decoration.line({ attributes: { style: "text-align:center" } }).range(line.from));
      // Fenced divs.
      const div = /^\s*:::\s*(.*)$/.exec(text);
      if (div) {
        const attrs = div[1].trim().replace(/^\{|\}$/g, "");
        const label = attrs
          ? Object.entries(parseAttrs(div[1].trim()))
              .map(([k, v]) => (v ? `${k}: ${v}` : k))
              .join(" · ")
          : "";
        add(line.from, line.to, Decoration.replace({ widget: new ChipWidget(label || "end", label ? "div" : "div-end") }));
        continue;
      }
      // Display math on one line: $$ … $$
      const dm = /^\s*\$\$(.+)\$\$\s*$/.exec(text);
      if (dm) {
        add(line.from, line.to, Decoration.replace({ widget: new MathWidget(dm[1].trim(), true) }));
        continue;
      }

      const inline: [RegExp, (m: RegExpExecArray, s: number) => void][] = [
        // Inline math $…$ (not $$, not "$5 and $6" with spaces inside the delimiters).
        [
          /(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\$|\d)/g,
          (m, s) => {
            if (!inCode(s)) add(s, s + m[0].length, Decoration.replace({ widget: new MathWidget(m[1], false) }));
          },
        ],
        // Footnotes: [^1] references and `[^1]:` definitions.
        [
          /\[\^([^\]\s]+)\](:?)/g,
          (m, s) => {
            if (inCode(s)) return;
            const def = m[2] === ":" && s === line.from;
            add(s, s + m[0].length, Decoration.replace({ widget: new FootnoteWidget(m[1], def) }));
          },
        ],
        // %% comment %% (single line)
        [
          /%%.*?%%/g,
          (m, s) => {
            if (!inCode(s)) add(s, s + m[0].length, HIDE);
          },
        ],
        // ![[embed|width]]
        [
          /!\[\[([^\]|\n]+?)(?:\|([^\]\n]*))?\]\]/g,
          (m, s) => {
            if (inCode(s)) return;
            const e = s + m[0].length;
            const [file, frag = ""] = m[1].trim().split("#");
            if (IMAGE_EXT.test(m[1])) {
              const w = /^\d+$/.test(m[2] ?? "") ? m[2] : null;
              add(s, e, Decoration.replace({ widget: new ImageWidget(m[1].trim(), "", w) }));
            } else if (/\.pdf$/i.test(file)) {
              const page = /page=(\d+)/.exec(frag)?.[1] ?? null;
              const w = /^\d+$/.test(m[2] ?? "") ? m[2] : null;
              add(s, e, Decoration.replace({ widget: new PdfWidget(file, page, w, /height=(\d+)/.exec(frag)?.[1] ?? null) }));
            } else {
              add(s, s + 3, HIDE);
              add(s + 3, e - 2, Decoration.mark({ class: "cm-nz-lp-link internal embed", attributes: { "data-target": m[1] } }));
              add(e - 2, e, HIDE);
            }
          },
        ],
        // <center> … </center>, <br>
        [
          /<\/?center>|<br\s*\/?>/gi,
          (m, s) => {
            if (inCode(s)) return;
            if (/^<br/i.test(m[0])) add(s, s + m[0].length, Decoration.replace({ widget: new BreakWidget() }));
            else add(s, s + m[0].length, HIDE);
          },
        ],
        // ==highlight==
        [
          /(?<!=)==(?=[^=\s])([^=\n]*?[^=\s])==(?!=)/g,
          (m, s) => {
            if (inCode(s)) return;
            const e = s + m[0].length;
            if (!free(s, e)) return;
            add(s, s + 2, HIDE);
            add(s + 2, e - 2, Decoration.mark({ class: "cm-nz-lp-mark" }));
            add(e - 2, e, HIDE);
          },
        ],
        // [[target|alias]]
        [
          /\[\[([^\]|\n]+)(\|([^\]\n]+))?\]\]/g,
          (m, s) => {
            if (inCode(s)) return;
            const e = s + m[0].length;
            const textFrom = m[3] ? s + 2 + m[1].length + 1 : s + 2;
            const textTo = e - 2;
            if (!free(s, e)) return;
            add(s, textFrom, HIDE);
            add(textFrom, textTo, Decoration.mark({ class: "cm-nz-lp-link internal", attributes: { "data-target": m[1] } }));
            add(textTo, e, HIDE);
          },
        ],
        // [text]{attrs}
        [
          /\[([^\]\n]*)\]\{([^}\n]*)\}/g,
          (m, s) => {
            if (inCode(s)) return;
            const innerTo = s + 1 + m[1].length;
            add(s, s + 1, HIDE);
            add(innerTo, s + m[0].length, HIDE);
          },
        ],
      ];
      for (const [re, fn] of inline) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) fn(m, line.from + m.index);
      }
    }

    // ----- Markdown syntax tree
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.from <= fmEnd) return;
        const name = node.name;
        if (name === "FencedCode" || name === "CodeBlock" || name === "HTMLBlock") return false;
        if (name === "Blockquote") calloutLines(node.from, node.to);
        if (isActive(node.from)) {
          // Multi-line nodes may continue on inactive lines.
          return;
        }
        switch (name) {
          case "HeaderMark": {
            const parent = node.node.parent?.name ?? "";
            if (!parent.startsWith("ATXHeading")) return;
            let end = node.to;
            if (doc.sliceString(end, end + 1) === " ") end++;
            if (node.from === doc.lineAt(node.from).from) add(node.from, end, HIDE);
            else add(node.from - (doc.sliceString(node.from - 1, node.from) === " " ? 1 : 0), node.to, HIDE); // closing ###
            return;
          }
          case "EmphasisMark":
          case "StrikethroughMark":
            add(node.from, node.to, HIDE);
            return;
          case "CodeMark":
            if (node.node.parent?.name === "InlineCode") add(node.from, node.to, HIDE);
            return;
          case "QuoteMark": {
            let end = node.to;
            if (doc.sliceString(end, end + 1) === " ") end++;
            add(node.from, end, HIDE);
            return;
          }
          case "HorizontalRule":
            add(node.from, node.to, Decoration.replace({ widget: new RuleWidget() }));
            return;
          case "ListMark": {
            const item = node.node.parent;
            const list = item?.parent?.name;
            const task = item?.getChild("Task");
            let end = node.to;
            if (doc.sliceString(end, end + 1) === " ") end++;
            if (task) add(node.from, end, HIDE);
            else if (list === "BulletList") add(node.from, end, Decoration.replace({ widget: new BulletWidget() }));
            return;
          }
          case "TaskMarker": {
            const checked = /x/i.test(doc.sliceString(node.from, node.to));
            add(node.from, node.to, Decoration.replace({ widget: new CheckboxWidget(checked) }));
            if (checked) {
              const line = doc.lineAt(node.from);
              if (node.to < line.to) add(node.to, line.to, Decoration.mark({ class: "cm-nz-lp-done" }));
            }
            return;
          }
          case "Image": {
            const src = node.node.getChild("URL");
            if (!src) return false;
            const raw = doc.sliceString(node.from, node.to);
            const alt = /^!\[([^\]]*)\]/.exec(raw)?.[1] ?? "";
            const [label, width] = alt.split("|");
            const url = doc.sliceString(src.from, src.to).replace(/^<|>$/g, "");
            const [file, frag = ""] = url.split("#");
            const w = /^\d+$/.test(width ?? "") ? width : null;
            const widget = /\.pdf$/i.test(file) ? new PdfWidget(file, /page=(\d+)/.exec(frag)?.[1] ?? null, w, /height=(\d+)/.exec(frag)?.[1] ?? null) : new ImageWidget(url, label, w);
            add(node.from, node.to, Decoration.replace({ widget }));
            return false;
          }
          case "Link": {
            const marks = node.node.getChildren("LinkMark");
            const url = node.node.getChild("URL");
            if (marks.length < 2) return;
            const textFrom = marks[0].to;
            const textTo = marks[1].from;
            if (!free(node.from, node.to)) return false;
            add(node.from, textFrom, HIDE);
            const target = url ? doc.sliceString(url.from, url.to).replace(/^<|>$/g, "") : "";
            add(textFrom, textTo, Decoration.mark({ class: "cm-nz-lp-link", attributes: { "data-target": target } }));
            add(textTo, node.to, HIDE);
            return false;
          }
          case "URL":
            if (node.node.parent?.name === "Autolink" || node.node.parent?.name === "Document" || node.node.parent?.name === "Paragraph") {
              add(node.from, node.to, Decoration.mark({ class: "cm-nz-lp-link", attributes: { "data-target": doc.sliceString(node.from, node.to) } }));
            }
            return;
          case "Escape":
            add(node.from, node.from + 1, HIDE);
            return;
        }
      },
    });
  }
  return Decoration.set(decos, true);
}

export function livePreview(enabled: boolean, typstMode: boolean, opts: LiveOptions): Extension {
  if (!enabled || typstMode) return [];
  liveOpts = opts;
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
          this.decorations = build(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
  const clicks = EditorView.domEventHandlers({
    mousedown(e) {
      const el = (e.target as HTMLElement).closest?.(".cm-nz-lp-link") as HTMLElement | null;
      if (!el || e.button !== 0 || e.shiftKey) return false;
      const target = el.dataset.target;
      if (!target) return false;
      e.preventDefault();
      opts.openLink(target);
      return true;
    },
  });
  return [rawTableField, plugin, blockField, clicks, EditorView.editorAttributes.of({ class: "cm-nz-live" })];
}
