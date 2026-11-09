// Table editing in live preview (like Obsidian's table editor + the Advanced
// Tables plugin): a Markdown table always stays a rendered table; each cell
// is edited in place and writes straight back to the Markdown source.
//
// - Click a cell to edit it (its Markdown source appears while editing).
// - Tab / Shift+Tab: next / previous cell (Tab on the last cell adds a row).
// - Enter: cell below (adds a row at the end). Shift+Enter: line break.
// - Arrows move between cells at the edges; Up/Down leave the table at the
//   top/bottom; Escape returns to the text.
// - Right-click: insert/delete/move rows and columns, align, sort, format,
//   or edit the table as plain Markdown.
// - The source is re-aligned (padded pipes) on Tab/Enter and when you leave.
import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { EditorView, WidgetType, keymap } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { undo, redo } from "@codemirror/commands";
import { askText, openMenu, MenuItem } from "../ui/primitives";
import { openPath } from "../core/native";
import { root } from "../core/store";
import { saveFiles } from "./attachments";
import { getLiveOpts, hydrateImages, hydrateMath, inlineHtml } from "./livepreview";
import { WRAP_PAIRS } from "./autopair";
import { ltrRanges, rtlLine, RTL } from "./bidi";

type Align = "" | "left" | "center" | "right";

interface Model {
  header: string[];
  aligns: Align[];
  rows: string[][];
}

// ------------------------------------------------------------- parsing

/** Cell content ranges (offsets in `text`) between unescaped pipes. */
function segments(text: string): { from: number; to: number }[] {
  const pipes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "|") pipes.push(i);
  }
  const lead = text.trimStart().startsWith("|");
  const trimmed = text.trimEnd();
  const trail = pipes.length > (lead ? 1 : 0) && pipes[pipes.length - 1] === trimmed.length - 1;
  const bounds = [lead ? pipes[0] : -1, ...pipes.slice(lead ? 1 : 0, trail ? -1 : undefined), trail ? pipes[pipes.length - 1] : text.length];
  const out: { from: number; to: number }[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) out.push({ from: bounds[i] + 1, to: bounds[i + 1] });
  return out;
}

const cellsOf = (line: string) => segments(line).map((s) => line.slice(s.from, s.to).trim());

function parse(src: string): Model {
  const lines = src.split("\n").filter((l) => l.trim());
  const header = cellsOf(lines[0] ?? "");
  const aligns = cellsOf(lines[1] ?? "").map((c): Align => (/^:-+:$/.test(c) ? "center" : /^-+:$/.test(c) ? "right" : /^:-+$/.test(c) ? "left" : ""));
  const rows = lines.slice(2).map(cellsOf);
  const n = Math.max(1, header.length, ...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(Math.max(0, n - r.length)).fill("")].slice(0, n);
  return { header: pad(header), aligns: pad(aligns as string[]) as Align[], rows: rows.map(pad) };
}

/** Display width: combining marks and joiners take no space. */
const width = (s: string) => [...s].filter((c) => !/[\p{M}‌‍‎‏]/u.test(c)).length;
const padTo = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));

/** Advanced-Tables-style source: aligned pipes, `---` rows with colons. */
function format(m: Model): string {
  const n = m.header.length;
  const w = Array.from({ length: n }, (_, c) => Math.max(3, width(m.header[c]), ...m.rows.map((r) => width(r[c] ?? ""))));
  const line = (cells: string[]) => "| " + cells.map((c, i) => padTo(c ?? "", w[i])).join(" | ") + " |";
  const delim = "| " + m.aligns.map((a, i) => {
    const d = w[i];
    return a === "center" ? ":" + "-".repeat(d - 2) + ":" : a === "right" ? "-".repeat(d - 1) + ":" : a === "left" ? ":" + "-".repeat(d - 1) : "-".repeat(d);
  }).join(" | ") + " |";
  return [line(m.header), delim, ...m.rows.map(line)].join("\n");
}

const unesc = (s: string) => s.replace(/\\\|/g, "|");
const esc = (s: string) => s.replace(/(?<!\\)\|/g, "\\|");

// ------------------------------------------------- "edit as Markdown"

const setRawTable = StateEffect.define<number | null>();

/** Table start that is temporarily shown as Markdown source (or null). */
export const rawTableField = StateField.define<number | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setRawTable)) return e.value;
    if (v == null) return v;
    v = tr.changes.mapPos(v);
    const r = tableAt(tr.state, v);
    const sel = tr.state.selection.main;
    return r && sel.to >= r.from && sel.from <= r.to ? v : null;
  },
});

function tableAt(state: EditorState, pos: number): { from: number; to: number } | null {
  for (let n: any = syntaxTree(state).resolveInner(Math.min(state.doc.length, pos + 1), -1); n; n = n.parent) {
    if (n.name === "Table") return { from: state.doc.lineAt(n.from).from, to: state.doc.lineAt(n.to).to };
  }
  return null;
}

// --------------------------------------------------------- the widget

interface Live {
  view: EditorView;
  src: string;
}
const live = new WeakMap<HTMLElement, Live>();
/** The cell whose own input is being written (don't overwrite its text). */
let writingCell: HTMLElement | null = null;

export class TableWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }
  eq(o: TableWidget) {
    return o.src === this.src;
  }
  get estimatedHeight() {
    return 16 + 38 * Math.max(1, this.src.split("\n").length - 1);
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    live.set(wrap, { view, src: this.src });
    wire(wrap);
    render(wrap, parse(this.src));
    return wrap;
  }
  updateDOM(dom: HTMLElement, view: EditorView) {
    const st = live.get(dom);
    if (!st) return false;
    st.view = view;
    st.src = this.src;
    const m = parse(this.src);
    const table = dom.querySelector("table");
    const sameShape =
      table && table.rows.length === m.rows.length + 1 && (table.rows[0]?.cells.length ?? -1) === m.header.length;
    if (!sameShape) {
      const focus = focusedCell(dom);
      render(dom, m);
      if (focus) focusCell(dom, focus.r, focus.c);
      return true;
    }
    // Same shape: refresh only cells whose source changed.
    const all = [m.header, ...m.rows];
    table!.querySelectorAll<HTMLElement>(".nz-cell").forEach((cell) => {
      const r = Number(cell.dataset.r);
      const c = Number(cell.dataset.c);
      const raw = all[r][c] ?? "";
      const td = cell.parentElement as HTMLElement;
      td.style.textAlign = m.aligns[c] || "";
      if (cell === document.activeElement) {
        if (cell !== writingCell && cell.innerText.replace(/\n$/, "") !== unesc(raw)) {
          setRaw(cell, unesc(raw));
          caretToEnd(cell);
        }
        cell.dataset.raw = raw;
      } else if (cell.dataset.raw !== raw) {
        cell.dataset.raw = raw;
        paint(cell);
      }
    });
    return true;
  }
  ignoreEvent() {
    return true; // the widget handles its own mouse/keyboard
  }
}

function paint(cell: HTMLElement) {
  cell.innerHTML = inlineHtml(unesc(cell.dataset.raw ?? "")) || "";
  hydrateImages(cell);
  hydrateMath(cell);
}

function tableDir(src: string): "rtl" | "ltr" {
  const prose = src.replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)|<[^>]+>|\[\^[^\]]*\]/g, "");
  const strong = /[֐-ࣿיִ-﷿ﹰ-﻿]|[A-Za-zÀ-ɏ]/.exec(prose);
  return strong && /[^A-Za-zÀ-ɏ]/.test(strong[0]) ? "rtl" : "ltr";
}

function render(wrap: HTMLElement, m: Model) {
  const st = live.get(wrap)!;
  wrap.className = /!\[/.test(st.src) ? "cm-nz-lp-table nz-edit-table figure" : "cm-nz-lp-table nz-edit-table";
  wrap.textContent = "";
  const dir = tableDir(st.src);
  const box = el("div", "nz-table-box");
  box.dir = dir;
  const scroll = el("div", "nz-table-scroll");
  const table = document.createElement("table");
  table.dir = dir;
  const mkRow = (cells: string[], r: number, tag: "th" | "td") => {
    const tr = document.createElement("tr");
    cells.forEach((raw, c) => {
      const td = document.createElement(tag);
      if (m.aligns[c]) td.style.textAlign = m.aligns[c];
      const cell = el("div", "nz-cell");
      cell.contentEditable = "plaintext-only";
      cell.spellcheck = false;
      cell.dir = "auto";
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cell.dataset.raw = raw;
      paint(cell);
      td.append(cell);
      tr.append(td);
    });
    return tr;
  };
  const thead = document.createElement("thead");
  thead.append(mkRow(m.header, 0, "th"));
  const tbody = document.createElement("tbody");
  m.rows.forEach((row, i) => tbody.append(mkRow(row, i + 1, "td")));
  table.append(thead, tbody);
  scroll.append(table);
  const addRow = el("button", "nz-add-row");
  addRow.title = "Add row";
  addRow.textContent = "+";
  const addCol = el("button", "nz-add-col");
  addCol.title = "Add column";
  addCol.textContent = "+";
  addRow.addEventListener("mousedown", (e) => {
    e.preventDefault();
    edit(wrap, (m) => (m.rows.push(m.header.map(() => "")), { r: m.rows.length, c: 0 }));
  });
  addCol.addEventListener("mousedown", (e) => {
    e.preventDefault();
    edit(wrap, (m) => {
      m.header.push("");
      m.aligns.push("");
      m.rows.forEach((r) => r.push(""));
      return { r: 0, c: m.header.length - 1 };
    });
  });
  box.append(scroll, addRow, addCol);
  wrap.append(box);
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
};

// ------------------------------------------------------ doc access

function rangeOf(wrap: HTMLElement): { from: number; to: number } | null {
  const st = live.get(wrap);
  if (!st || !wrap.isConnected) return null;
  const from = st.view.posAtDOM(wrap);
  return { from, to: Math.min(st.view.state.doc.length, from + st.src.length) };
}

/** Replace the whole table with the formatted model, then focus a cell. */
function commit(wrap: HTMLElement, m: Model, focus?: { r: number; c: number } | null) {
  const st = live.get(wrap)!;
  const range = rangeOf(wrap);
  if (!range) return;
  const text = format(m);
  const view = st.view;
  if (view.state.sliceDoc(range.from, range.to) !== text) {
    view.dispatch({ changes: { from: range.from, to: range.to, insert: text }, userEvent: "input.table" });
  }
  if (focus) {
    const now = findWrap(view, range.from) ?? wrap;
    focusCell(now, focus.r, focus.c);
  }
}

// --------------------------------------------- keyboard into tables

/**
 * Arrow keys next to a rendered table go into its cells (like Obsidian)
 * instead of putting the caret beside the widget, where it is drawn as tall
 * as the whole table.
 */
function enterTable(view: EditorView, dir: "up" | "down" | "left" | "right"): boolean {
  const s = view.state;
  const sel = s.selection.main;
  if (!sel.empty) return false;
  const line = s.doc.lineAt(sel.head);
  const forward = dir === "down" || dir === "right";
  if (dir === "right" && sel.head !== line.to) return false;
  if (dir === "left" && sel.head !== line.from) return false;
  // Already on the table's own first/last line (caret beside the widget)?
  let t = tableAt(s, sel.head);
  const beside = !!t && sel.head >= t.from && sel.head <= t.to;
  // A wrapped line: Up/Down first move within it.
  if (!beside && (dir === "up" || dir === "down") && s.doc.lineAt(view.moveVertically(sel, forward).head).number === line.number) return false;
  if (!beside) {
    const n = forward ? line.number + 1 : line.number - 1;
    if (n < 1 || n > s.doc.lines) return false;
    const next = s.doc.line(n);
    t = tableAt(s, next.from);
    if (!t || (forward ? t.from !== next.from : t.to !== next.to)) return false;
  }
  if (!t || s.field(rawTableField, false) === t.from) return false;
  const wrap = findWrap(view, t.from);
  const st = wrap && live.get(wrap);
  if (!wrap || !st) return false;
  const m = parse(st.src);
  const lastRow = m.rows.length;
  const lastCol = m.header.length - 1;
  if (dir === "down") focusCell(wrap, 0, 0);
  else if (dir === "up") focusCell(wrap, lastRow, 0);
  else if (dir === "right") focusCell(wrap, 0, 0);
  else focusCell(wrap, lastRow, lastCol);
  return true;
}

export const tableKeys = Prec.high(
  keymap.of([
    { key: "ArrowDown", run: (v) => enterTable(v, "down") },
    { key: "ArrowUp", run: (v) => enterTable(v, "up") },
    { key: "ArrowRight", run: (v) => enterTable(v, getComputedStyle(v.contentDOM).direction === "rtl" ? "left" : "right") },
    { key: "ArrowLeft", run: (v) => enterTable(v, getComputedStyle(v.contentDOM).direction === "rtl" ? "right" : "left") },
  ]),
);

/** Keyboard moves (Page Up/Down, Ctrl+Home…) that land beside a rendered table skip past it. */
export const skipTableCaret = EditorView.updateListener.of((u) => {
  if (!u.selectionSet || u.docChanged) return;
  const tr = u.transactions.find((t) => t.isUserEvent("select") && !t.isUserEvent("select.pointer"));
  if (!tr) return;
  const s = u.state;
  const sel = s.selection.main;
  if (!sel.empty) return;
  const t = tableAt(s, sel.head);
  if (!t || sel.head < t.from || sel.head > t.to || s.field(rawTableField, false) === t.from) return;
  if (!findWrap(u.view, t.from)) return;
  const down = sel.head >= u.startState.selection.main.head;
  const target = down ? Math.min(s.doc.length, t.to + 1) : Math.max(0, t.from - 1);
  if (target >= t.from && target <= t.to) return;
  queueMicrotask(() => u.view.dispatch({ selection: { anchor: target }, scrollIntoView: true }));
});

// ------------------------------------------- toolbar ↔ focused cell

let activeCellEl: HTMLElement | null = null;
const cellListeners = new Set<() => void>();
const setCurrentCell = (cell: HTMLElement | null) => {
  if (cell === activeCellEl) return;
  activeCellEl = cell;
  cellListeners.forEach((f) => f());
};

/** Call `fn` whenever a table cell gains or loses focus. */
export function onTableCellFocus(fn: () => void): () => void {
  cellListeners.add(fn);
  return () => cellListeners.delete(fn);
}

/** Alignment of the focused cell's column, or null when no cell is focused. */
export function tableCellAlign(): Align | null {
  if (!activeCellEl && cellSel?.wrap.isConnected) {
    const st = live.get(cellSel.wrap);
    return st ? parse(st.src).aligns[rect(cellSel).c0] ?? "" : null;
  }
  const cell = activeCellEl;
  const wrap = cell?.isConnected ? cell.closest<HTMLElement>(".nz-edit-table") : null;
  const st = wrap && live.get(wrap);
  if (!cell || !st) return null;
  return parse(st.src).aligns[Number(cell.dataset.c)] ?? "";
}

/** Toolbar alignment inside a table: Markdown aligns whole columns. */
export function alignTableColumn(a: Align): boolean {
  if (!activeCellEl && cellSel?.wrap.isConnected && live.has(cellSel.wrap)) {
    const { c0, c1 } = rect(cellSel);
    editKeepSel(cellSel.wrap, (m) => {
      for (let c = c0; c <= c1; c++) m.aligns[c] = a;
    });
    cellListeners.forEach((f) => f());
    return true;
  }
  const cell = activeCellEl;
  const wrap = cell?.isConnected ? cell.closest<HTMLElement>(".nz-edit-table") : null;
  if (!cell || !wrap || !live.has(wrap)) return false;
  const r = Number(cell.dataset.r);
  const c = Number(cell.dataset.c);
  edit(wrap, (m) => ((m.aligns[c] = a), { r, c }));
  cellListeners.forEach((f) => f());
  return true;
}

/** Apply a structural change to the table under `wrap`. */
function edit(wrap: HTMLElement, fn: (m: Model) => { r: number; c: number } | null | void) {
  const st = live.get(wrap);
  if (!st) return;
  const m = parse(st.src);
  const focus = fn(m);
  commit(wrap, m, focus ?? null);
}

function findWrap(view: EditorView, from: number): HTMLElement | null {
  for (const w of view.contentDOM.querySelectorAll<HTMLElement>(".nz-edit-table")) {
    if (live.has(w) && view.posAtDOM(w) === from) return w;
  }
  return null;
}

/** Write one cell's text into the source (only that cell's span changes). */
function writeCell(cell: HTMLElement) {
  const wrap = cell.closest<HTMLElement>(".nz-edit-table");
  const st = wrap && live.get(wrap);
  const range = wrap && rangeOf(wrap);
  if (!st || !range) return;
  const r = Number(cell.dataset.r);
  const c = Number(cell.dataset.c);
  const value = esc(cell.innerText.replace(/\n$/, "").replace(/\n/g, " "));
  const doc = st.view.state.doc;
  const line = doc.line(doc.lineAt(range.from).number + (r === 0 ? 0 : r + 1));
  const seg = segments(line.text)[c];
  writingCell = cell;
  try {
    if (seg) {
      st.view.dispatch({ changes: { from: line.from + seg.from, to: line.from + seg.to, insert: ` ${value} ` }, userEvent: "input.type" });
    } else {
      const m = parse(st.src);
      (r === 0 ? m.header : m.rows[r - 1])[c] = value;
      commit(wrap!, m);
    }
  } finally {
    writingCell = null;
  }
  cell.dataset.raw = value;
}

// --------------------------------------------------------- focus

function cellAt(wrap: HTMLElement, r: number, c: number) {
  return wrap.querySelector<HTMLElement>(`.nz-cell[data-r="${r}"][data-c="${c}"]`);
}

function focusCell(wrap: HTMLElement, r: number, c: number) {
  const cell = cellAt(wrap, r, c);
  if (!cell) return;
  cell.focus({ preventScroll: true });
  cell.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function focusedCell(wrap: HTMLElement) {
  const a = document.activeElement as HTMLElement | null;
  return a && wrap.contains(a) && a.classList.contains("nz-cell") ? { r: Number(a.dataset.r), c: Number(a.dataset.c) } : null;
}

/**
 * The cell's Markdown while it is edited. In right-to-left text, inline code
 * and Latin runs are wrapped as left-to-right (as on editor lines), so
 * `free()` doesn't show as `()free`; the text itself is unchanged.
 */
function setRaw(cell: HTMLElement, text: string) {
  if (!RTL.test(text) || !rtlLine(text)) {
    cell.textContent = text;
    return;
  }
  cell.textContent = "";
  let at = 0;
  for (const [a, b] of ltrRanges(text)) {
    if (a > at) cell.append(text.slice(at, a));
    const span = document.createElement("span");
    span.dir = "ltr";
    span.textContent = text.slice(a, b);
    cell.append(span);
    at = b;
  }
  if (at < text.length) cell.append(text.slice(at));
}

function caretToEnd(el: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

function caretAt(el: HTMLElement): { start: boolean; end: boolean } {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return { start: false, end: false };
  const r = sel.getRangeAt(0);
  const before = document.createRange();
  before.selectNodeContents(el);
  before.setEnd(r.startContainer, r.startOffset);
  const off = before.toString().length;
  return { start: off === 0, end: off >= el.innerText.replace(/\n$/, "").length };
}

/** Put the editor cursor before/after the table and focus the text. */
function leave(wrap: HTMLElement, where: "before" | "after") {
  const st = live.get(wrap);
  const range = rangeOf(wrap);
  if (!st || !range) return;
  const view = st.view;
  const doc = view.state.doc;
  if (where === "after") {
    if (range.to >= doc.length) view.dispatch({ changes: { from: doc.length, insert: "\n" }, selection: { anchor: doc.length + 1 } });
    else view.dispatch({ selection: { anchor: range.to + 1 }, scrollIntoView: true });
  } else {
    view.dispatch({ selection: { anchor: Math.max(0, range.from - 1) }, scrollIntoView: true });
  }
  view.focus();
}

// ------------------------------------------- selecting cells with the mouse

/** A rectangle of selected cells (drag across cells, or Shift+click). */
interface CellSel {
  wrap: HTMLElement;
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}
let cellSel: CellSel | null = null;

const rect = (s: CellSel) => ({
  r0: Math.min(s.r0, s.r1),
  r1: Math.max(s.r0, s.r1),
  c0: Math.min(s.c0, s.c1),
  c1: Math.max(s.c0, s.c1),
});

function paintCellSel() {
  document.querySelectorAll(".nz-cell-selected").forEach((e) => e.classList.remove("nz-cell-selected"));
  if (!cellSel?.wrap.isConnected) return;
  const { r0, r1, c0, c1 } = rect(cellSel);
  cellSel.wrap.querySelectorAll<HTMLElement>(".nz-cell").forEach((cell) => {
    const r = Number(cell.dataset.r);
    const c = Number(cell.dataset.c);
    if (r >= r0 && r <= r1 && c >= c0 && c <= c1) cell.parentElement!.classList.add("nz-cell-selected");
  });
}

function setCellSel(sel: CellSel | null) {
  cellSel = sel;
  paintCellSel();
  cellListeners.forEach((f) => f());
}

/** Select from (r0, c0) to (r1, c1): the table itself takes focus. */
function selectCells(wrap: HTMLElement, r0: number, c0: number, r1: number, c1: number) {
  window.getSelection()?.removeAllRanges();
  if (document.activeElement !== wrap) wrap.focus({ preventScroll: true });
  setCurrentCell(null);
  setCellSel({ wrap, r0, c0, r1, c1 });
}

/** Like edit(), but the cell selection stays (and is repainted). */
function editKeepSel(wrap: HTMLElement, fn: (m: Model) => void) {
  const sel = cellSel;
  edit(wrap, (m) => void fn(m));
  const view = live.get(wrap)?.view;
  const range = view && rangeOf(wrap);
  const now = (range && view && findWrap(view, range.from)) || wrap;
  if (sel) {
    if (document.activeElement !== now) now.focus({ preventScroll: true });
    cellSel = { ...sel, wrap: now };
    paintCellSel();
  }
}

/** The selected cells as a model (first selected row = header). */
function selectedModel(m: Model, s: CellSel): Model {
  const { r0, r1, c0, c1 } = rect(s);
  const all = [m.header, ...m.rows];
  const rows = all.slice(r0, r1 + 1).map((r) => r.slice(c0, c1 + 1));
  return { header: rows[0], aligns: m.aligns.slice(c0, c1 + 1), rows: rows.slice(1) };
}

const htmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Rows of a pasted block: tab-separated (spreadsheets) or a Markdown table. */
function pastedRows(text: string): string[][] | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  if (lines.every((l) => l.trim().startsWith("|"))) {
    return lines.filter((l) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(l) || !l.includes("-")).map(cellsOf);
  }
  if (lines.length > 1 || text.includes("\t")) return lines.map((l) => l.split("\t").map((c) => esc(c.trim())));
  return null;
}

function wireCellSelection(wrap: HTMLElement) {
  let drag: { r: number; c: number; moved: boolean } | null = null;
  const cellFrom = (e: MouseEvent) => {
    const cell = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest?.(".nz-cell") as HTMLElement | null;
    return cell && wrap.contains(cell) ? cell : null;
  };
  const move = (e: MouseEvent) => {
    if (!drag) return;
    const cell = cellFrom(e);
    if (!cell) return;
    const r = Number(cell.dataset.r);
    const c = Number(cell.dataset.c);
    if (!drag.moved && r === drag.r && c === drag.c) return; // still selecting text in one cell
    e.preventDefault();
    if (!drag.moved) {
      drag.moved = true;
      wrap.classList.add("nz-selecting");
    }
    if (!cellSel || cellSel.r1 !== r || cellSel.c1 !== c) selectCells(wrap, drag.r, drag.c, r, c);
  };
  const up = () => {
    drag = null;
    wrap.classList.remove("nz-selecting");
    document.removeEventListener("mousemove", move, true);
    document.removeEventListener("mouseup", up, true);
  };

  wrap.addEventListener("mousedown", (e) => {
    const cell = (e.target as HTMLElement).closest?.(".nz-cell") as HTMLElement | null;
    if (!cell) return;
    const r = Number(cell.dataset.r);
    const c = Number(cell.dataset.c);
    if (e.button === 2 && cellSel?.wrap === wrap) {
      const s = rect(cellSel);
      // Right-click inside the selection keeps it (and focus) for the menu.
      if (r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1) e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (e.shiftKey) {
      // Extend from the focused cell (or the current selection's anchor).
      const from = cellSel?.wrap === wrap ? { r: cellSel.r0, c: cellSel.c0 } : focusedCell(wrap);
      if (from) {
        e.preventDefault();
        selectCells(wrap, from.r, from.c, r, c);
        return;
      }
    }
    if (cellSel) setCellSel(null);
    drag = { r, c, moved: false };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", up, true);
  });

  wrap.addEventListener("keydown", (e) => {
    if (e.target !== wrap || cellSel?.wrap !== wrap) return;
    const s = cellSel;
    const { r0, r1, c0, c1 } = rect(s);
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      editKeepSel(wrap, (m) => {
        const all = [m.header, ...m.rows];
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) all[r][c] = "";
      });
    } else if (e.key === "Escape") {
      e.preventDefault();
      setCellSel(null);
      leave(wrap, "after");
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      setCellSel(null);
      focusCell(wrap, s.r1, s.c1);
    } else if (e.key.startsWith("Arrow") && e.shiftKey) {
      e.preventDefault();
      const st = live.get(wrap)!;
      const m = parse(st.src);
      const rtl = (wrap.querySelector("table") as HTMLElement | null)?.dir === "rtl";
      const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, rtl ? 1 : -1], ArrowRight: [0, rtl ? -1 : 1] }[e.key] ?? [0, 0];
      const r = Math.max(0, Math.min(m.rows.length, s.r1 + d[0]));
      const c = Math.max(0, Math.min(m.header.length - 1, s.c1 + d[1]));
      selectCells(wrap, s.r0, s.c0, r, c);
    } else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      setCellSel(null);
      focusCell(wrap, s.r1, s.c1);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      const m = parse(live.get(wrap)!.src);
      selectCells(wrap, 0, 0, m.rows.length, m.header.length - 1);
    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
      e.preventDefault();
      const view = live.get(wrap)!.view;
      setCellSel(null);
      if (e.key.toLowerCase() === "y" || e.shiftKey) redo(view);
      else undo(view);
      // Back to editing a cell, so the keyboard keeps working.
      const range = rangeOf(wrap);
      const now = (range && findWrap(view, range.from)) || wrap;
      focusCell(now, s.r1, s.c1);
    }
  });

  const copyCells = (e: ClipboardEvent, cut: boolean) => {
    if (e.target !== wrap || cellSel?.wrap !== wrap) return;
    const st = live.get(wrap);
    if (!st) return;
    e.preventDefault();
    const sub = selectedModel(parse(st.src), cellSel);
    const rows = [sub.header, ...sub.rows];
    e.clipboardData?.setData("text/plain", format(sub));
    e.clipboardData?.setData(
      "text/html",
      `<table>${rows.map((r, i) => `<tr>${r.map((c) => (i ? `<td>${htmlEsc(unesc(c))}</td>` : `<th>${htmlEsc(unesc(c))}</th>`)).join("")}</tr>`).join("")}</table>`,
    );
    if (cut) {
      const { r0, r1, c0, c1 } = rect(cellSel);
      editKeepSel(wrap, (m) => {
        const all = [m.header, ...m.rows];
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) all[r][c] = "";
      });
    }
  };
  wrap.addEventListener("copy", (e) => copyCells(e, false));
  wrap.addEventListener("cut", (e) => copyCells(e, true));
  wrap.addEventListener("paste", (e) => {
    if (e.target !== wrap || cellSel?.wrap !== wrap) return;
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const rows = pastedRows(text) ?? [[esc(text.replace(/\r?\n/g, " "))]];
    const { r0, c0, r1, c1 } = rect(cellSel);
    // A single value fills the whole selection; a block lands at its corner.
    const fill = rows.length === 1 && rows[0].length === 1;
    editKeepSel(wrap, (m) => {
      const h = fill ? r1 - r0 + 1 : rows.length;
      const w = fill ? c1 - c0 + 1 : Math.max(...rows.map((r) => r.length));
      while (m.rows.length < r0 + h - 1) m.rows.push(m.header.map(() => ""));
      while (m.header.length < c0 + w) insertCol(m, m.header.length);
      const all = [m.header, ...m.rows];
      for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) all[r0 + i][c0 + j] = fill ? rows[0][0] : rows[i][j] ?? "";
    });
  });
  wrap.addEventListener("focusout", (e) => {
    if (e.target !== wrap || cellSel?.wrap !== wrap) return;
    const next = e.relatedTarget as Node | null;
    // Toolbar buttons keep focus where it is; anything else ends the selection.
    if (next && !wrap.contains(next)) setCellSel(null);
  });
}

/** Wrap the selected text of a cell in `open`/`close`, keeping it selected. */
function wrapCellSelection(cell: HTMLElement, open: string, close: string): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!cell.contains(range.commonAncestorContainer)) return false;
  const pre = document.createRange();
  pre.selectNodeContents(cell);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const text = sel.toString();
  document.execCommand("insertText", false, open + text + close);
  selectOffsets(cell, start + open.length, start + open.length + text.length);
  return true;
}

function selectOffsets(el: HTMLElement, a: number, b: number) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  let pos = 0;
  let setStart = false;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.textContent!.length;
    if (!setStart && a <= pos + len) {
      r.setStart(n, a - pos);
      setStart = true;
    }
    if (setStart && b <= pos + len) {
      r.setEnd(n, b - pos);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    pos += len;
  }
}

// --------------------------------------------------------- events

function wire(wrap: HTMLElement) {
  wireCellSelection(wrap);
  wrap.addEventListener("focusin", (e) => {
    const cell = e.target as HTMLElement;
    if (!cell.classList?.contains("nz-cell")) return;
    setCurrentCell(cell);
    if (cell.classList.contains("editing")) return;
    cell.classList.add("editing");
    setRaw(cell, unesc(cell.dataset.raw ?? ""));
    caretToEnd(cell);
  });

  wrap.addEventListener("focusout", (e) => {
    const cell = e.target as HTMLElement;
    if (cell.classList?.contains("nz-cell")) {
      cell.classList.remove("editing");
      paint(cell);
    }
    // Leaving the table entirely: tidy the source (Advanced Tables style).
    const next = e.relatedTarget as Node | null;
    if (!(next as HTMLElement | null)?.classList?.contains("nz-cell")) setCurrentCell(null);
    if (!next || !wrap.contains(next)) {
      const st = live.get(wrap);
      if (st && wrap.isConnected) queueMicrotask(() => wrap.isConnected && commit(wrap, parse(st.src)));
    }
  });

  wrap.addEventListener("input", (e) => {
    const cell = e.target as HTMLElement;
    if (cell.classList?.contains("nz-cell")) writeCell(cell);
  });

  wrap.addEventListener("paste", (e) => {
    const cell = (e.target as HTMLElement).closest?.(".nz-cell") as HTMLElement | null;
    if (!cell) return;
    e.preventDefault();
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) return void addFilesToCell(wrap, cell, files);
    let text = e.clipboardData?.getData("text/plain") ?? "";
    // An image copied from the editor arrives as HTML only.
    if (!text.trim()) text = imagesFromHtml(e.clipboardData?.getData("text/html") ?? "");
    document.execCommand("insertText", false, text.replace(/\r?\n/g, " "));
  });

  wrap.addEventListener("dragover", (e) => {
    if ((e.target as HTMLElement).closest?.(".nz-cell") && e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
  wrap.addEventListener("drop", (e) => {
    const cell = (e.target as HTMLElement).closest?.(".nz-cell") as HTMLElement | null;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!cell || !files.length) return;
    e.preventDefault();
    e.stopPropagation();
    void addFilesToCell(wrap, cell, files);
  });

  // Clicking an image selects it (outline); double-click / Enter edits.
  wrap.tabIndex = -1;
  wrap.addEventListener("dblclick", (e) => {
    const img = (e.target as HTMLElement).closest?.("img");
    const cell = img?.closest(".nz-cell") as HTMLElement | null;
    if (!img || !cell || cell.classList.contains("editing")) return;
    e.preventDefault();
    editAtImage(cell, imgIndex(cell, img));
  });
  wrap.addEventListener("keydown", (e) => {
    if (e.target !== wrap || !selImg || selImg.wrap !== wrap) return;
    const { cell, idx } = selImg;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removeImage(wrap, cell, idx);
    } else if (e.key === "Enter") {
      e.preventDefault();
      editAtImage(cell, idx);
    } else if (e.key === "Escape") {
      e.preventDefault();
      clearImgSel();
      leave(wrap, "after");
    }
  });
  const copyImg = (e: ClipboardEvent, cut: boolean) => {
    if (e.target !== wrap || !selImg || selImg.wrap !== wrap) return;
    const span = imageSpans(selImg.cell.dataset.raw ?? "")[selImg.idx];
    if (!span) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", unesc(span.text));
    if (cut) removeImage(wrap, selImg.cell, selImg.idx);
  };
  wrap.addEventListener("copy", (e) => copyImg(e, false));
  wrap.addEventListener("cut", (e) => copyImg(e, true));
  wrap.addEventListener("focusout", (e) => {
    if (e.target === wrap && selImg?.wrap === wrap) clearImgSel();
  });

  wrap.addEventListener("mousedown", (e) => {
    const img = (e.target as HTMLElement).closest?.("img");
    const imgCell = img?.closest(".nz-cell") as HTMLElement | null;
    if (img && imgCell && !imgCell.classList.contains("editing")) {
      e.preventDefault();
      selectImage(wrap, imgCell, img);
      return;
    }
    clearImgSel();
    const link = (e.target as HTMLElement).closest?.(".cm-nz-lp-link") as HTMLElement | null;
    const cell = (e.target as HTMLElement).closest?.(".nz-cell");
    if (link && cell && !cell.classList.contains("editing") && e.button === 0 && link.dataset.target) {
      e.preventDefault();
      getLiveOpts()?.openLink(link.dataset.target);
    }
  });

  wrap.addEventListener("keydown", (e) => {
    const cell = e.target as HTMLElement;
    if (!cell.classList?.contains("nz-cell")) return;
    const st = live.get(wrap);
    if (!st) return;
    const m = parse(st.src);
    const r = Number(cell.dataset.r);
    const c = Number(cell.dataset.c);
    const nRows = m.rows.length + 1; // incl. header
    const nCols = m.header.length;
    const mod = e.ctrlKey || e.metaKey;
    const handled = () => (e.preventDefault(), e.stopPropagation());

    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) return handled(), undo(st.view);
      if ((k === "z" && e.shiftKey) || k === "y") return handled(), redo(st.view);
      const wrapSel = (mark: string) => {
        const sel = window.getSelection()?.toString() ?? "";
        document.execCommand("insertText", false, mark + sel + mark);
      };
      if (k === "b") return handled(), wrapSel("**");
      if (k === "i") return handled(), wrapSel("*");
      if (k === "e") return handled(), wrapSel("`");
      return;
    }

    const close = WRAP_PAIRS[e.key];
    if (close && !e.altKey && wrapCellSelection(cell, e.key, close)) return handled();

    switch (e.key) {
      case "Tab": {
        handled();
        if (e.shiftKey) {
          if (c > 0) commit(wrap, m, { r, c: c - 1 });
          else if (r > 0) commit(wrap, m, { r: r - 1, c: nCols - 1 });
          return;
        }
        if (c < nCols - 1) return commit(wrap, m, { r, c: c + 1 });
        if (r === nRows - 1) m.rows.push(m.header.map(() => ""));
        return commit(wrap, m, { r: r + 1, c: 0 });
      }
      case "Enter": {
        handled();
        if (e.shiftKey) return void document.execCommand("insertText", false, "<br>");
        if (r === nRows - 1) m.rows.push(m.header.map(() => ""));
        return commit(wrap, m, { r: r + 1, c });
      }
      case "Escape":
        handled();
        return leave(wrap, "after");
      case "ArrowUp":
        handled();
        return r > 0 ? focusCell(wrap, r - 1, c) : leave(wrap, "before");
      case "ArrowDown":
        handled();
        return r < nRows - 1 ? focusCell(wrap, r + 1, c) : leave(wrap, "after");
      case "ArrowLeft":
      case "ArrowRight": {
        if (e.shiftKey) return;
        const at = caretAt(cell);
        const cellRtl = getComputedStyle(cell).direction === "rtl";
        const tableRtl = (cell.closest("table") as HTMLElement).dir === "rtl";
        const left = e.key === "ArrowLeft";
        const atEdge = left !== cellRtl ? at.start : at.end;
        if (!atEdge) return;
        const step = left !== tableRtl ? -1 : 1;
        const nc = c + step;
        if (nc < 0 || nc >= nCols) return;
        handled();
        return focusCell(wrap, r, nc);
      }
    }
  });

  wrap.addEventListener("contextmenu", (e) => {
    const cell = (e.target as HTMLElement).closest?.(".nz-cell") as HTMLElement | null;
    if (!cell) return;
    const r = Number(cell.dataset.r);
    const c = Number(cell.dataset.c);
    const st = live.get(wrap)!;
    const img = (e.target as HTMLElement).closest?.("img");
    if (img && !cell.classList.contains("editing")) {
      selectImage(wrap, cell, img);
      return openMenu(e, imageMenu(wrap, cell, imgIndex(cell, img)));
    }
    const m0 = parse(st.src);
    const body = r - 1; // body row index (-1 = header)
    // Right-click inside a selected range acts on the whole range.
    let sr = cellSel?.wrap === wrap ? rect(cellSel) : null;
    if (sr && !(r >= sr.r0 && r <= sr.r1 && c >= sr.c0 && c <= sr.c1)) {
      setCellSel(null);
      sr = null;
    }
    if (sr) e.preventDefault(); // keep the selection painted (no caret into the cell)
    const rows = sr ? { from: Math.max(1, sr.r0), to: sr.r1 } : { from: r, to: r };
    const cols = sr ? { from: sr.c0, to: sr.c1 } : { from: c, to: c };
    const nRowsSel = Math.max(0, rows.to - rows.from + 1);
    const nColsSel = cols.to - cols.from + 1;
    const items: (MenuItem | "-")[] = [
      ...(sr
        ? ([
            {
              label: "Clear cells",
              run: () =>
                editKeepSel(wrap, (m) => {
                  const all = [m.header, ...m.rows];
                  for (let i = sr!.r0; i <= sr!.r1; i++) for (let j = sr!.c0; j <= sr!.c1; j++) all[i][j] = "";
                }),
            },
            "-",
          ] as (MenuItem | "-")[])
        : []),
      { label: "Insert row above", run: () => edit(wrap, (m) => (r > 0 ? (m.rows.splice(body, 0, m.header.map(() => "")), { r, c }) : null)) },
      { label: "Insert row below", run: () => edit(wrap, (m) => (m.rows.splice(body + 1, 0, m.header.map(() => "")), { r: r + 1, c })) },
      { label: "Insert column before", run: () => edit(wrap, (m) => (insertCol(m, c), { r, c })) },
      { label: "Insert column after", run: () => edit(wrap, (m) => (insertCol(m, c + 1), { r, c: c + 1 })) },
      "-",
      { label: "Move row up", run: () => edit(wrap, (m) => (body > 0 ? ([m.rows[body - 1], m.rows[body]] = [m.rows[body], m.rows[body - 1]], { r: r - 1, c }) : null)) },
      { label: "Move row down", run: () => edit(wrap, (m) => (body >= 0 && body < m.rows.length - 1 ? ([m.rows[body + 1], m.rows[body]] = [m.rows[body], m.rows[body + 1]], { r: r + 1, c }) : null)) },
      { label: "Move column before", run: () => edit(wrap, (m) => (c > 0 ? (swapCols(m, c, c - 1), { r, c: c - 1 }) : null)) },
      { label: "Move column after", run: () => edit(wrap, (m) => (c < m.header.length - 1 ? (swapCols(m, c, c + 1), { r, c: c + 1 }) : null)) },
      "-",
      { label: "Align column: start", hint: m0.aligns[c] === "left" ? "✓" : "", run: () => edit(wrap, (m) => void (m.aligns[c] = "left")) },
      { label: "Align column: center", hint: m0.aligns[c] === "center" ? "✓" : "", run: () => edit(wrap, (m) => void (m.aligns[c] = "center")) },
      { label: "Align column: end", hint: m0.aligns[c] === "right" ? "✓" : "", run: () => edit(wrap, (m) => void (m.aligns[c] = "right")) },
      { label: "Sort by this column (A→Z)", run: () => edit(wrap, (m) => void m.rows.sort((a, b) => cmp(a[c], b[c]))) },
      { label: "Sort by this column (Z→A)", run: () => edit(wrap, (m) => void m.rows.sort((a, b) => cmp(b[c], a[c]))) },
      "-",
      { label: "Format table", run: () => edit(wrap, () => null) },
      { label: "Edit as Markdown", run: () => editRaw(wrap) },
      "-",
      {
        label: nRowsSel > 1 ? `Delete ${nRowsSel} rows` : "Delete row",
        danger: true,
        run: () => {
          setCellSel(null);
          edit(wrap, (m) => (rows.from >= 1 && nRowsSel > 0 ? (m.rows.splice(rows.from - 1, nRowsSel), null) : null));
        },
      },
      {
        label: nColsSel > 1 ? `Delete ${nColsSel} columns` : "Delete column",
        danger: true,
        run: () => {
          setCellSel(null);
          if (m0.header.length > nColsSel) {
            edit(wrap, (m) => {
              for (const row of [m.header, m.aligns, ...m.rows]) row.splice(cols.from, nColsSel);
            });
          } else deleteTable(wrap);
        },
      },
      { label: "Delete table", danger: true, run: () => deleteTable(wrap) },
    ];
    openMenu(e, items);
  });
}

// ------------------------------------------------------ images in cells

const IMG_MD = /!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)\s]+\)/g;

/** Image embeds in a cell's (escaped) source, in display order. */
function imageSpans(raw: string): { from: number; to: number; text: string }[] {
  return [...raw.matchAll(IMG_MD)].map((m) => ({ from: m.index!, to: m.index! + m[0].length, text: m[0] }));
}

let selImg: { wrap: HTMLElement; cell: HTMLElement; idx: number } | null = null;

function clearImgSel() {
  document.querySelectorAll(".nz-cell img.nz-img-selected").forEach((i) => i.classList.remove("nz-img-selected"));
  selImg = null;
}

const imgIndex = (cell: HTMLElement, img: Element) => [...cell.querySelectorAll("img")].indexOf(img as HTMLImageElement);

function selectImage(wrap: HTMLElement, cell: HTMLElement, img: HTMLImageElement) {
  clearImgSel();
  (document.activeElement as HTMLElement | null)?.closest?.(".nz-cell") && (document.activeElement as HTMLElement).blur();
  img.classList.add("nz-img-selected");
  selImg = { wrap, cell, idx: imgIndex(cell, img) };
  wrap.focus({ preventScroll: true });
}

/** Read/write one cell of the model by its (r, c) data attributes. */
function cellText(m: Model, cell: HTMLElement): string {
  const r = Number(cell.dataset.r);
  const c = Number(cell.dataset.c);
  return (r === 0 ? m.header[c] : m.rows[r - 1]?.[c]) ?? "";
}
function setCellText(m: Model, cell: HTMLElement, v: string) {
  const r = Number(cell.dataset.r);
  const c = Number(cell.dataset.c);
  if (r === 0) m.header[c] = v;
  else if (m.rows[r - 1]) m.rows[r - 1][c] = v;
}

function removeImage(wrap: HTMLElement, cell: HTMLElement, idx: number) {
  clearImgSel();
  edit(wrap, (m) => {
    const raw = cellText(m, cell);
    const span = imageSpans(raw)[idx];
    if (span) setCellText(m, cell, (raw.slice(0, span.from) + raw.slice(span.to)).replace(/ {2,}/g, " ").trim());
  });
}

function replaceImage(wrap: HTMLElement, cell: HTMLElement, idx: number, text: string) {
  edit(wrap, (m) => {
    const raw = cellText(m, cell);
    const span = imageSpans(raw)[idx];
    if (span) setCellText(m, cell, raw.slice(0, span.from) + text + raw.slice(span.to));
  });
}

/** Start editing the cell with the caret just after image `idx`'s source. */
function editAtImage(cell: HTMLElement, idx: number) {
  clearImgSel();
  const raw = cell.dataset.raw ?? "";
  const span = imageSpans(raw)[idx];
  cell.focus();
  if (!span) return;
  const off = unesc(raw.slice(0, span.to)).length;
  const node = cell.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  const sel = window.getSelection();
  const rg = document.createRange();
  rg.setStart(node, Math.min(off, node.textContent!.length));
  rg.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(rg);
}

/** `![[x|300]]` / `![alt|300](u)` → width; `null` when none. */
function imageWidth(md: string): string | null {
  const w = /^!\[\[[^\]|\\]*(?:\\?\|(\d+)(?:x\d+)?)?\]\]$/.exec(md)?.[1] ?? /^!\[[^\]]*?\|(\d+)(?:x\d+)?\]/.exec(md)?.[1];
  return w ?? null;
}

function withWidth(md: string, w: string): string {
  const px = w.trim().replace(/px$/, "");
  if (md.startsWith("![[")) {
    const target = md.slice(3, -2).split(/\\?\|/)[0];
    return px ? `![[${target}\\|${px}]]` : `![[${target}]]`;
  }
  return md.replace(/^!\[([^\]|]*)(?:\|[^\]]*)?\]/, (_, alt) => (px ? `![${alt}|${px}]` : `![${alt}]`));
}

function imageTarget(md: string): string {
  return md.startsWith("![[") ? md.slice(3, -2).split(/\\?\|/)[0] : decodeURI(/\(([^)\s]+)\)$/.exec(md)?.[1] ?? "");
}

function imageMenu(wrap: HTMLElement, cell: HTMLElement, idx: number): (MenuItem | "-")[] {
  const span = imageSpans(cell.dataset.raw ?? "")[idx];
  if (!span) return [];
  const md = span.text;
  return [
    {
      label: "Open image",
      run: async () => {
        const o = getLiveOpts();
        const abs = await o?.resolveAsset?.(o.notePath() ?? "", imageTarget(md));
        if (abs) void openPath(abs);
      },
    },
    { label: "Copy image link", run: () => void navigator.clipboard.writeText(unesc(md)) },
    {
      label: "Resize…",
      hint: imageWidth(md) ? `${imageWidth(md)}px` : "",
      run: async () => {
        const w = await askText("Image width in pixels (empty = original size)", imageWidth(md) ?? "", "e.g. 300");
        if (w === null || (w.trim() && !/^\d+(px)?$/.test(w.trim()))) return;
        replaceImage(wrap, cell, idx, withWidth(md, w));
      },
    },
    { label: "Edit source", run: () => editAtImage(cell, idx) },
    "-",
    { label: "Remove image", danger: true, run: () => removeImage(wrap, cell, idx) },
  ];
}

/** `<img src="notez-asset://local/abs">` (copied from the editor) → links. */
function imagesFromHtml(html: string): string {
  const base = root();
  const out: string[] = [];
  for (const m of html.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    let src = m[1].replace(/&amp;/g, "&");
    if (src.startsWith("notez-asset://local")) {
      const abs = decodeURIComponent(src.slice("notez-asset://local".length));
      src = base && abs.startsWith(base + "/") ? abs.slice(base.length + 1) : abs;
      out.push(`![](${encodeURI(src)})`);
    } else if (/^https?:/.test(src)) out.push(`![](${src})`);
  }
  return out.join(" ");
}

async function addFilesToCell(wrap: HTMLElement, cell: HTMLElement, files: File[]) {
  const links = (await saveFiles(files)).map(esc).join(" ");
  if (!links || !wrap.isConnected) return;
  if (document.activeElement === cell && cell.classList.contains("editing")) {
    document.execCommand("insertText", false, links);
    return;
  }
  edit(wrap, (m) => {
    const raw = cellText(m, cell);
    setCellText(m, cell, raw ? `${raw} ${links}` : links);
  });
}

function insertCol(m: Model, at: number) {
  m.header.splice(at, 0, "");
  m.aligns.splice(at, 0, "");
  m.rows.forEach((r) => r.splice(at, 0, ""));
}

function swapCols(m: Model, a: number, b: number) {
  for (const row of [m.header, m.aligns as string[], ...m.rows]) [row[a], row[b]] = [row[b], row[a]];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const cmp = (a = "", b = "") => (!a && b ? 1 : a && !b ? -1 : collator.compare(a, b));

function editRaw(wrap: HTMLElement) {
  const st = live.get(wrap);
  const range = rangeOf(wrap);
  if (!st || !range) return;
  st.view.dispatch({ effects: setRawTable.of(range.from), selection: { anchor: range.from } });
  st.view.focus();
}

function deleteTable(wrap: HTMLElement) {
  const st = live.get(wrap);
  const range = rangeOf(wrap);
  if (!st || !range) return;
  const doc = st.view.state.doc;
  const to = range.to < doc.length ? range.to + 1 : range.to;
  st.view.dispatch({ changes: { from: range.from, to, insert: "" }, selection: { anchor: range.from } });
  st.view.focus();
}
