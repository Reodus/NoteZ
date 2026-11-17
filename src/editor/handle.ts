// Block handle, folding and zoom for Markdown notes.
// - A grip appears left of the block under the mouse: drag it to move the
//   block (a heading takes its section along); click it for a menu (copy a
//   link or embed of the block, turn into, duplicate, fold, zoom, delete).
// - Headings, list items, quotes, code and tables fold (gutter arrows,
//   Ctrl+Shift+[ / ]).
// - Zoom shows one heading's section or one list item alone, with
//   breadcrumbs to go back out.
import { EditorSelection, EditorState, Extension, RangeSetBuilder, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, keymap, showPanel, ViewPlugin, ViewUpdate, WidgetType, type Panel } from "@codemirror/view";
import { codeFolding, foldable, foldEffect, foldedRanges, foldGutter, foldKeymap, syntaxTree, unfoldEffect } from "@codemirror/language";
import { pushLayer, openMenuAt, MenuItem } from "../ui/primitives";
import { state as store } from "../core/store";
import { stem } from "../core/ipc";
import { ensureBlockId, linkName } from "../core/blocks";
import { frontmatterRange } from "../core/frontmatter";
import { setBlockStyle, toggleList, BlockStyle } from "./format";
import { notify } from "../core/app";

import { blockMove } from "./blockMove";
import { t } from "../core/i18n";
export interface Block {
  /** Start of the first line and end of the last line. */
  from: number;
  to: number;
  kind: "heading" | "item" | "paragraph" | "quote" | "code" | "table" | "math" | "other";
  /** Heading level. */
  level?: number;
}

const HEADING = /^(#{1,6})\s/;
const FENCE = /^\s*(```|~~~)/;

/** End of the section a heading at line `n` starts (before the next heading of its level or higher). */
function sectionEnd(st: EditorState, n: number, level: number): number {
  const doc = st.doc;
  let fence = false;
  let end = doc.lines;
  for (let k = n + 1; k <= doc.lines; k++) {
    const t = doc.line(k).text;
    if (FENCE.test(t)) fence = !fence;
    const m = !fence && HEADING.exec(t);
    if (m && m[1].length <= level) {
      end = k - 1;
      break;
    }
  }
  while (end > n && !doc.line(end).text.trim()) end--;
  return doc.line(end).to;
}

/** The block at `pos`: the innermost list item, else the top-level block. */
export function blockAt(st: EditorState, pos: number): Block | null {
  const doc = st.doc;
  const fm = frontmatterRange(doc.sliceString(0, Math.min(doc.length, 20000)));
  if (fm && pos < fm.bodyStart) return null;
  const line = doc.lineAt(pos);
  if (!line.text.trim()) return null;
  const tree = syntaxTree(st);
  for (let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(line.from + line.text.search(/\S|$/), 1); n; n = n.parent) {
    if (n.name === "ListItem") return { from: doc.lineAt(n.from).from, to: doc.lineAt(Math.max(n.from, n.to - (doc.sliceString(n.to - 1, n.to) === "\n" ? 1 : 0))).to, kind: "item" };
  }
  let top = tree.topNode.firstChild;
  while (top && top.to < line.from) top = top.nextSibling;
  if (!top || top.from > line.to) return null;
  const from = doc.lineAt(top.from).from;
  const h = /^ATXHeading(\d)$/.exec(top.name);
  if (h) return { from, to: doc.lineAt(top.from).to, kind: "heading", level: +h[1] };
  const kind: Block["kind"] =
    top.name === "Paragraph" ? (doc.lineAt(top.from).text.trim().startsWith("$$") ? "math" : "paragraph")
    : top.name === "Blockquote" ? "quote"
    : top.name === "FencedCode" || top.name === "CodeBlock" ? "code"
    : top.name === "Table" ? "table"
    : "other";
  let to = doc.lineAt(Math.max(top.from, top.to - 1)).to;
  // `^id` on its own line after a table or quote belongs to it.
  const next = doc.lineAt(to).number + 2;
  if (next <= doc.lines && /^\^[\w-]+\s*$/.test(doc.line(next).text) && !doc.line(next - 1).text.trim()) to = doc.line(next).to;
  return { from, to, kind };
}

/** What dragging or zooming a block covers: a heading's whole section. */
function extent(st: EditorState, b: Block): { from: number; to: number } {
  if (b.kind === "heading") return { from: b.from, to: sectionEnd(st, st.doc.lineAt(b.from).number, b.level!) };
  return b;
}

// ------------------------------------------------------------- moving

/** Move `[from, to]` (whole lines) to before or after block `target`. */
function moveBlock(view: EditorView, src: { from: number; to: number }, item: boolean, at: number, before: boolean) {
  const spec = blockMove(view.state, src, item, at, before);
  if (spec) view.dispatch(spec);
}

// --------------------------------------------------------------- menu

async function copyLink(view: EditorView, b: Block, embed: boolean) {
  const path = store.active;
  if (!path) return;
  const name = linkName(path, null);
  let sub: string;
  if (b.kind === "heading") sub = view.state.doc.lineAt(b.from).text.replace(/^#+\s+/, "").replace(/\s+\^[\w-]+\s*$/, "").replace(/[#|\[\]^]/g, " ").trim();
  else {
    // Save first so the core sees the current text and line numbers.
    const line = view.state.doc.lineAt(b.kind === "item" ? b.from : b.to).number;
    sub = "^" + (await ensureBlockId(path, line));
  }
  const link = `${embed ? "!" : ""}[[${name}#${sub}]]`;
  await navigator.clipboard.writeText(link);
  notify(t("Copied {link}", { link }));
}

function turnInto(view: EditorView, b: Block, to: BlockStyle | "bullet" | "number" | "task") {
  view.dispatch({ selection: EditorSelection.range(b.from, view.state.doc.lineAt(b.kind === "item" ? b.from : b.to).to) });
  if (to === "bullet" || to === "number" || to === "task") {
    // From another list kind: drop the old marker first.
    const strip = view.state.doc.sliceString(b.from, b.to).replace(/^(\s*)([-*+]\s\[[ xX]\]\s|[-*+]\s|\d+[.)]\s)/gm, "$1");
    if (b.kind === "item") view.dispatch({ changes: { from: b.from, to: b.to, insert: strip }, selection: EditorSelection.range(b.from, b.from + strip.length) });
    toggleList(view, to);
  } else {
    if (b.kind === "item") {
      const strip = view.state.doc.sliceString(b.from, b.to).replace(/^(\s*)([-*+]\s\[[ xX]\]\s|[-*+]\s|\d+[.)]\s)/gm, "");
      view.dispatch({ changes: { from: b.from, to: b.to, insert: strip }, selection: EditorSelection.range(b.from, b.from + strip.length) });
    }
    setBlockStyle(view, to);
  }
  view.focus();
}

function blockMenu(view: EditorView, b: Block, x: number, y: number) {
  const ext = extent(view.state, b);
  const lineEnd = view.state.doc.lineAt(b.from).to;
  const foldRange = foldable(view.state, view.state.doc.lineAt(b.from).from, lineEnd);
  let folded = false;
  foldedRanges(view.state).between(lineEnd, lineEnd + 1, () => {
    folded = true;
  });
  const items: (MenuItem | "-")[] = [
    { label: t("Copy link to block"), run: () => void copyLink(view, b, false) },
    { label: t("Copy embed of block"), run: () => void copyLink(view, b, true) },
    "-",
    {
      label: t("Turn into"),
      run: () => {},
      items: [
        { label: t("Text"), run: () => turnInto(view, b, "p") },
        { label: t("Heading 1"), run: () => turnInto(view, b, "h1") },
        { label: t("Heading 2"), run: () => turnInto(view, b, "h2") },
        { label: t("Heading 3"), run: () => turnInto(view, b, "h3") },
        { label: t("Bulleted list"), run: () => turnInto(view, b, "bullet") },
        { label: t("Numbered list"), run: () => turnInto(view, b, "number") },
        { label: t("Task list"), run: () => turnInto(view, b, "task") },
        { label: t("Quote"), run: () => turnInto(view, b, "quote") },
      ],
    },
    {
      label: t("Duplicate"),
      run: () => {
        const text = view.state.doc.sliceString(ext.from, ext.to);
        const sep = b.kind === "item" ? "\n" : "\n\n";
        view.dispatch({ changes: { from: ext.to, insert: sep + text.replace(/\s\^[\w-]+(\s*)$/gm, "$1") }, userEvent: "input.duplicate" });
      },
    },
  ];
  if (foldRange) items.push({ label: folded ? t("Unfold") : t("Fold"), run: () => view.dispatch({ effects: (folded ? unfoldEffect : foldEffect).of(foldRange) }) });
  if (b.kind === "heading" || b.kind === "item") items.push({ label: t("Zoom in"), hint: "Ctrl+Shift+.", run: () => zoomTo(view, b) });
  items.push("-", {
    label: t("Delete"),
    danger: true,
    run: () => {
      const doc = view.state.doc;
      let { from, to } = ext;
      if (doc.sliceString(to, to + 1) === "\n") to += 1;
      else if (from > 0) from -= 1;
      view.dispatch({ changes: { from, to }, userEvent: "delete.block" });
    },
  });
  openMenuAt(x, y, items);
}

// ------------------------------------------------------------- handle

/** The right edge of what is drawn before the text at `pos` (a list bullet, a quote bar…). */
function lineRight(view: EditorView, pos: number): number[] {
  const c = view.coordsAtPos(pos, -1);
  return c ? [c.right] : [];
}

class Handle {
  dom: HTMLElement;
  indicator: HTMLElement;
  block: Block | null = null;
  hideTimer = 0;
  cancelDrag: (() => void) | null = null;
  pointer: { x: number; y: number } | null = null;
  refreshKey = {};
  onMouseMove = (e: MouseEvent) => { if (!e.buttons && !(e.target as HTMLElement).closest?.(".cm-nz-handle, .cm-gutters, .cm-panels")) this.hover(e); };
  onMouseLeave = () => { this.pointer = null; this.hideSoon(); };
  onScroll = () => this.refresh();
  constructor(readonly view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-nz-handle";
    this.dom.title = t("Drag to move · click for options");
    this.dom.setAttribute("aria-hidden", "true");
    this.dom.innerHTML = `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>`;
    this.indicator = document.createElement("div");
    this.indicator.className = "cm-nz-drop-line";
    view.dom.append(this.dom, this.indicator);
    // Widgets intentionally hide their editing events from CodeMirror. Hover
    // still belongs to the block handle, including over editable table cells.
    view.dom.addEventListener("mousemove", this.onMouseMove, true);
    view.dom.addEventListener("mouseleave", this.onMouseLeave);
    view.scrollDOM.addEventListener("scroll", this.onScroll);
    this.dom.addEventListener("pointerdown", (e) => this.down(e));
    this.dom.addEventListener("mouseenter", () => clearTimeout(this.hideTimer));
    this.dom.addEventListener("mouseleave", () => this.hideSoon());
  }
  /** Mouse over the editor: show the handle by the block under it. */
  hover(e: MouseEvent) {
    if (store.active?.endsWith(".typ") || this.cancelDrag) return;
    this.pointer = { x: e.clientX, y: e.clientY };
    const content = this.view.contentDOM.getBoundingClientRect();
    // Also when the mouse is in the margin left of the text.
    const x = Math.max(content.left + 4, Math.min(e.clientX, content.right - 4));
    const pos = this.view.posAtCoords({ x, y: e.clientY }, false);
    const b = pos == null ? null : blockAt(this.view.state, pos);
    if (!b) return this.hideSoon();
    clearTimeout(this.hideTimer);
    this.block = b;
    this.place();
  }
  place() {
    const b = this.block;
    if (!b) return;
    this.view.requestMeasure({ key: this, read: () => {
      const view = this.view, dom = view.dom.getBoundingClientRect(), content = view.contentDOM.getBoundingClientRect();
      const first = view.state.doc.lineAt(b.from), indent = first.text.search(/\S|$/);
      const at = view.coordsAtPos(first.from + indent, 1);
      if (!at) return null;
      const found = view.domAtPos(b.from, 1);
      const node = found.node === view.contentDOM ? found.node.childNodes[found.offset] : found.node;
      const el = node?.nodeType === 1 ? node as HTMLElement : node?.parentElement;
      const line = el?.closest<HTMLElement>(".cm-line");
      const widget = line ? null : el?.closest<HTMLElement>(".cm-nz-lp-table, .cm-nz-preview") ?? (el !== view.contentDOM ? el : null);
      const dirEl = widget?.querySelector<HTMLElement>("[dir]") ?? line ?? widget;
      const rtl = dirEl ? getComputedStyle(dirEl).direction === "rtl" : view.textDirection === 1;
      const marker = line?.querySelector<HTMLElement>(".cm-nz-lp-bullet, .cm-nz-lp-check")?.getBoundingClientRect();
      // Inline image previews share the source line and can make the caret
      // rectangle as tall as the image. Anchor the grip to the source row.
      const sourceImage = line?.querySelector<HTMLElement>(".cm-nz-lp-image.preview");
      const rect = widget?.getBoundingClientRect();
      const sourceRow = sourceImage ? line!.getBoundingClientRect() : null;
      const rowHeight = sourceImage ? view.defaultLineHeight : at.bottom - at.top;
      const x = rtl
        ? Math.min(Math.max(sourceRow?.right ?? rect?.right ?? at.right, marker?.right ?? 0, ...lineRight(view, first.from + indent)) + 6, dom.right - 22)
        : Math.max(Math.min(sourceRow?.left ?? rect?.left ?? at.left, marker?.left ?? Infinity) - 24, dom.left + (view.scrollDOM.querySelector<HTMLElement>(".cm-gutters")?.getBoundingClientRect().width ?? 0) + 2);
      const top = (rect?.top ?? sourceRow?.top ?? at.top) + Math.max(0, (Math.min(rowHeight, 40) - 22) / 2);
      const viewport = view.scrollDOM.getBoundingClientRect();
      if (top < viewport.top || top + 22 > viewport.bottom || !content.width) return null;
      return { x: x - dom.left, y: top - dom.top };
    }, write: pos => {
      if (!pos || this.block !== b) return this.hide();
      this.dom.style.top = `${pos.y}px`;
      this.dom.style.left = `${pos.x}px`;
      this.dom.classList.add("visible");
    } });
  }
  refresh() {
    if (this.cancelDrag || !this.pointer) return;
    const { x, y } = this.pointer;
    this.view.requestMeasure({ key: this.refreshKey, read: () => {
      const box = this.view.scrollDOM.getBoundingClientRect();
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) return null;
      const pos = this.view.posAtCoords({ x, y }, false);
      return pos == null ? null : blockAt(this.view.state, pos);
    }, write: block => {
      this.block = block;
      if (block) this.place(); else this.hide();
    } });
  }

  hideSoon() {
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), 250);
  }
  hide() {
    this.dom.classList.remove("visible");
  }
  down(e: PointerEvent) {
    const b = this.block;
    if (!b || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const view = this.view;
    this.cancelDrag?.();
    const sx = e.clientX, sy = e.clientY;
    let dragging = false, frame = 0;
    let drop: { at: number; before: boolean } | null = null;
    let last = e;
    const ext = extent(view.state, b);
    const scroll = () => {
      if (!dragging) return;
      const box = view.scrollDOM.getBoundingClientRect();
      const delta = last.clientY < box.top + 40 ? -12 : last.clientY > box.bottom - 40 ? 12 : 0;
      if (delta) { view.scrollDOM.scrollTop += delta; drop = this.dropTarget(last, ext); }
      frame = requestAnimationFrame(scroll);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      last = ev;
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      if (!dragging) {
        dragging = true;
        document.body.classList.add("nz-dragging-block");
        this.dom.classList.add("dragging");
        frame = requestAnimationFrame(scroll);
      }
      drop = this.dropTarget(ev, ext);
    };
    const cleanup = () => {
      this.cancelDrag = null;
      cancelAnimationFrame(frame);
      removeLayer();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", cancel);
      this.dom.removeEventListener("lostpointercapture", cancel);
      if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
      document.body.classList.remove("nz-dragging-block");
      this.dom.classList.remove("dragging");
      this.indicator.classList.remove("visible");
    };
    const cancel = () => { cleanup(); this.hide(); };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (dragging) drop = this.dropTarget(ev, ext);
      cleanup();
      if (!dragging) return blockMenu(view, b, ev.clientX, ev.clientY);
      if (drop) moveBlock(view, ext, b.kind === "item", drop.at, drop.before);
      view.focus();
    };
    const removeLayer = pushLayer(cancel);
    this.cancelDrag = cancel;
    this.dom.setPointerCapture(e.pointerId);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cancel);
    this.dom.addEventListener("lostpointercapture", cancel);
  }

  /** Where a drop at the pointer goes: before or after the block under it. */
  dropTarget(ev: PointerEvent, src: { from: number; to: number }) {
    const view = this.view;
    const content = view.contentDOM.getBoundingClientRect();
    const pos = view.posAtCoords({ x: Math.max(content.left + 4, Math.min(ev.clientX, content.right - 4)), y: ev.clientY }, false);
    let t = pos == null ? null : blockAt(view.state, pos);
    if (!t && pos != null && !view.state.doc.lineAt(pos).text.trim()) {
      const doc = view.state.doc, n = doc.lineAt(pos).number;
      for (let distance = 1; !t && distance < doc.lines; distance++) for (const candidate of [n + distance, n - distance]) {
        if (candidate >= 1 && candidate <= doc.lines) {
          t = blockAt(view.state, doc.line(candidate).from);
          if (t) break;
        }
      }
    }
    // Inside the dragged block: no drop.
    if (!t || (t.from >= src.from && t.from <= src.to)) {
      this.indicator.classList.remove("visible");
      return null;
    }
    if (t.kind === "heading") t = { ...t, ...extent(view.state, t) };
    const top = view.coordsAtPos(t.from, 1);
    const bottom = view.coordsAtPos(t.to, -1);
    if (!top || !bottom) return null;
    const before = ev.clientY < (top.top + bottom.bottom) / 2;
    const dom = view.dom.getBoundingClientRect();
    const firstLine = view.state.doc.lineAt(t.from);
    const line = view.coordsAtPos(firstLine.from + firstLine.text.search(/\S|$/), 1);
    const left = Math.max(dom.left + 24, Math.min(line?.left ?? content.left, content.left + 48));
    this.indicator.style.top = `${(before ? top.top : bottom.bottom) - dom.top - 1}px`;
    this.indicator.style.left = `${left - dom.left}px`;
    this.indicator.style.width = `${Math.max(0, Math.min(dom.right - 24, content.right - 48) - left)}px`;
    this.indicator.classList.add("visible");
    return { at: before ? t.from : t.to, before };
  }
  destroy() {
    this.cancelDrag?.();
    this.view.dom.removeEventListener("mousemove", this.onMouseMove, true);
    this.view.dom.removeEventListener("mouseleave", this.onMouseLeave);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    clearTimeout(this.hideTimer);
    this.dom.remove();
    this.indicator.remove();
  }
}

const handlePlugin = ViewPlugin.fromClass(
  class {
    h: Handle;
    constructor(view: EditorView) {
      this.h = new Handle(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.geometryChanged) {
        if (u.docChanged) this.h.cancelDrag?.();
        this.h.refresh();
      }
    }
    destroy() {
      this.h.destroy();
    }
  },

);

// --------------------------------------------------------------- zoom

interface Zoom {
  from: number;
  to: number;
}
const setZoom = StateEffect.define<Zoom | null>();

const zoomField = StateField.define<Zoom | null>({
  create: () => null,
  update(z, tr) {
    for (const e of tr.effects) if (e.is(setZoom)) return e.value;
    if (!z || !tr.docChanged) return z;
    const from = tr.changes.mapPos(z.from, -1);
    const to = tr.changes.mapPos(z.to, 1);
    return to > from ? { from, to } : null;
  },
  provide: (f) => [
    EditorView.decorations.compute([f], (st) => {
      const z = st.field(f);
      if (!z) return Decoration.none;
      // Hide everything before and after (with the line breaks).
      const b = new RangeSetBuilder<Decoration>();
      if (z.from > 0) b.add(0, z.from - 1, HIDDEN);
      if (z.to < st.doc.length) b.add(z.to + 1, st.doc.length, HIDDEN);
      return b.finish();
    }),
    showPanel.from(f, (z) => (z ? zoomPanel : null)),
  ],
});

const HIDDEN = Decoration.replace({ block: true });

/** The cursor stays inside the zoomed range. */
const zoomClamp = EditorState.transactionFilter.of((tr: Transaction) => {
  const z = tr.state.field(zoomField, false) ?? null;
  const next = tr.effects.find((e) => e.is(setZoom));
  const zone = next ? (next.value as Zoom | null) : z && tr.docChanged ? { from: tr.changes.mapPos(z.from, -1), to: tr.changes.mapPos(z.to, 1) } : z;
  if (!zone || !tr.selection) return tr;
  const clamp = (p: number) => Math.max(zone.from, Math.min(zone.to, p));
  const sel = tr.selection;
  if (sel.ranges.every((r) => r.from >= zone.from && r.to <= zone.to)) return tr;
  return [tr, { selection: EditorSelection.create(sel.ranges.map((r) => EditorSelection.range(clamp(r.anchor), clamp(r.head))), sel.mainIndex), sequential: true }];
});

/** Headings above `pos` (outermost first), for breadcrumbs. */
function ancestors(st: EditorState, pos: number): { level: number; text: string; from: number }[] {
  const out: { level: number; text: string; from: number }[] = [];
  let fence = false;
  const doc = st.doc;
  const upto = doc.lineAt(pos).number;
  for (let n = 1; n < upto; n++) {
    const t = doc.line(n).text;
    if (FENCE.test(t)) fence = !fence;
    const m = !fence && HEADING.exec(t);
    if (!m) continue;
    const level = m[1].length;
    while (out.length && out[out.length - 1].level >= level) out.pop();
    out.push({ level, text: t.replace(/^#+\s+/, "").replace(/\s+\^[\w-]+\s*$/, ""), from: doc.line(n).from });
  }
  return out;
}

function zoomPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-nz-zoom-bar";
  const render = () => {
    const z = view.state.field(zoomField);
    dom.replaceChildren();
    if (!z) return;
    const crumb = (label: string, run: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = (e) => (e.preventDefault(), run());
      dom.append(b);
      const sep = document.createElement("span");
      sep.textContent = "›";
      dom.append(sep);
    };
    crumb(store.active ? stem(store.active) : t("Note"), () => zoomOut(view));
    for (const a of ancestors(view.state, z.from)) {
      crumb(a.text, () => {
        const b = blockAt(view.state, a.from);
        if (b) zoomTo(view, b);
      });
    }
    const cur = document.createElement("strong");
    cur.textContent = view.state.doc.lineAt(z.from).text.replace(/^\s*([-*+]\s(\[.\]\s)?|\d+[.)]\s|#+\s+)/, "").replace(/\s+\^[\w-]+\s*$/, "").slice(0, 80);
    const close = document.createElement("button");
    close.className = "close";
    close.title = t("Zoom out (Esc)");
    close.textContent = "×";
    close.onclick = (e) => (e.preventDefault(), zoomOut(view));
    dom.append(cur, close);
  };
  render();
  return { dom, top: true, update: (u) => (u.docChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setZoom)))) && render() };
}

export function zoomTo(view: EditorView, b: Block) {
  const r = extent(view.state, b);
  view.dispatch({ effects: setZoom.of(r), selection: { anchor: view.state.doc.lineAt(r.from).to }, scrollIntoView: true });
  view.focus();
}

export function zoomOut(view: EditorView): boolean {
  const z = view.state.field(zoomField, false);
  if (!z) return false;
  view.dispatch({ effects: setZoom.of(null) });
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }) });
  view.focus();
  return true;
}

/** Zoom into the heading section or list item at the cursor. */
export function zoomIn(view: EditorView): boolean {
  if (store.active?.endsWith(".typ")) return false;
  const b = blockAt(view.state, view.state.selection.main.head);
  if (!b || (b.kind !== "heading" && b.kind !== "item")) {
    // Inside a section: zoom into the nearest heading above.
    const a = ancestors(view.state, view.state.selection.main.head).pop();
    const hb = a && blockAt(view.state, a.from);
    if (!hb) return false;
    zoomTo(view, hb);
    return true;
  }
  zoomTo(view, b);
  return true;
}

class FoldWidget extends WidgetType {
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "cm-nz-folded";
    el.textContent = "…";
    el.title = t("Folded — click to unfold");
    el.onclick = () => {
      const pos = view.posAtDOM(el);
      foldedRanges(view.state).between(pos, pos + 1, (from, to) => {
        view.dispatch({ effects: unfoldEffect.of({ from, to }) });
      });
    };
    return el;
  }
}

/** Handle, folding and zoom (Markdown notes). */
export function blockTools(): Extension {
  return [
    handlePlugin,
    codeFolding({ placeholderDOM: (view) => new FoldWidget().toDOM(view) }),
    foldGutter({
      markerDOM: (open) => {
        const el = document.createElement("span");
        el.className = "cm-nz-fold-marker" + (open ? "" : " closed");
        el.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        return el;
      },
    }),
    keymap.of(foldKeymap),
    zoomField,
    zoomClamp,
    keymap.of([
      { key: "Mod-Shift-.", run: zoomIn },
      { key: "Mod-Shift-,", run: zoomOut },
      { key: "Escape", run: zoomOut },
    ]),
  ];
}
