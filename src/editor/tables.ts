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
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { undo, redo } from "@codemirror/commands";
import { openMenu, MenuItem } from "../ui/primitives";
import { getLiveOpts, hydrateImages, hydrateMath, inlineHtml } from "./livepreview";

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
          cell.textContent = unesc(raw);
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

// --------------------------------------------------------- events

function wire(wrap: HTMLElement) {
  wrap.addEventListener("focusin", (e) => {
    const cell = e.target as HTMLElement;
    if (!cell.classList?.contains("nz-cell") || cell.classList.contains("editing")) return;
    cell.classList.add("editing");
    cell.textContent = unesc(cell.dataset.raw ?? "");
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
    const cell = e.target as HTMLElement;
    if (!cell.classList?.contains("nz-cell")) return;
    e.preventDefault();
    const text = (e.clipboardData?.getData("text/plain") ?? "").replace(/\r?\n/g, " ");
    document.execCommand("insertText", false, text);
  });

  wrap.addEventListener("mousedown", (e) => {
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
    const m0 = parse(st.src);
    const body = r - 1; // body row index (-1 = header)
    const items: (MenuItem | "-")[] = [
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
      { label: "Delete row", danger: true, run: () => edit(wrap, (m) => (body >= 0 ? (m.rows.splice(body, 1), null) : null)) },
      {
        label: "Delete column",
        danger: true,
        run: () =>
          m0.header.length > 1
            ? edit(wrap, (m) => {
                for (const row of [m.header, m.aligns, ...m.rows]) row.splice(c, 1);
              })
            : deleteTable(wrap),
      },
      { label: "Delete table", danger: true, run: () => deleteTable(wrap) },
    ];
    openMenu(e, items);
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
