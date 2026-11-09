// Right-click menu in the editor (like Obsidian's): clipboard, formatting,
// paragraph styles, callouts, inserts, link/image actions and — through the
// Electron shell — spelling suggestions for a misspelled word.
import { isBookmarked, toggleBookmark } from "../core/bookmarks";
import { EditorView } from "@codemirror/view";
import { openMenu, MenuItem } from "../ui/primitives";
import { onSpellMenu, openPath, replaceMisspelling, addToDictionary } from "../core/native";
import { ipc } from "../core/ipc";
import { root, state } from "../core/store";
import { exportPdf } from "../core/render";
import {
  toggleInline, setBlockStyle, toggleList, insertLink, insertTable, insertMath, insertFootnote,
  insertFenced, insertBlock, insertCallout, isTypst, BlockStyle,
} from "./format";
import { CALLOUTS } from "./livepreview";

type Item = MenuItem | "-";

interface Hit {
  kind: "wiki" | "md" | "url" | "wikiImage" | "mdImage";
  target: string;
  from: number;
  to: number;
}

/** The link or image under `pos`, if any. */
function hitAt(view: EditorView, pos: number): Hit | null {
  const line = view.state.doc.lineAt(pos);
  const off = pos - line.from;
  const re = /(!?)\[\[([^\]]+)\]\]|(!?)\[([^\]]*)\]\(([^)\s]+)[^)]*\)|(https?:\/\/[^\s)>\]]+)/g;
  for (const m of line.text.matchAll(re)) {
    const a = m.index!;
    if (off < a || off > a + m[0].length) continue;
    const span = { from: line.from + a, to: line.from + a + m[0].length };
    if (m[2] !== undefined) return { kind: m[1] ? "wikiImage" : "wiki", target: m[2].split("|")[0], ...span };
    if (m[5] !== undefined) return { kind: m[3] ? "mdImage" : "md", target: decodeURI(m[5]), ...span };
    return { kind: "url", target: m[6], ...span };
  }
  return null;
}

function wrapSel(view: EditorView, mark: string) {
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to);
  if (text.startsWith(mark) && text.endsWith(mark) && text.length >= mark.length * 2) {
    view.dispatch({ changes: { from, to, insert: text.slice(mark.length, -mark.length) } });
  } else {
    view.dispatch({ changes: { from, to, insert: mark + text + mark }, selection: { anchor: from + mark.length, head: to + mark.length } });
  }
  view.focus();
}

/** Strip Markdown inline marks from the selection. */
function clearFormatting(view: EditorView) {
  const { from, to } = view.state.selection.main;
  if (from === to) return;
  const text = view.state
    .sliceDoc(from, to)
    .replace(/\[([^\]]*)\]\{[^}]*\}/g, "$1")
    .replace(/<\/?(u|mark|span)[^>]*>/g, "")
    .replace(/(\*\*|__|~~|==|\*|_|`)(.+?)\1/g, "$2");
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from, head: from + text.length } });
  view.focus();
}

export async function clipboard(view: EditorView, op: "cut" | "copy" | "paste" | "plain") {
  view.focus();
  const { from, to } = view.state.selection.main;
  if (op === "copy" || op === "cut") {
    await navigator.clipboard.writeText(view.state.sliceDoc(from, to));
    if (op === "cut") view.dispatch({ changes: { from, to }, userEvent: "delete.cut" });
    return;
  }
  if (op === "paste") {
    // Goes through the editor's paste handling (images → attachments, etc.).
    if (document.execCommand("paste")) return;
  }
  const text = await navigator.clipboard.readText();
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.paste" });
}

function linkItems(view: EditorView, hit: Hit, openLink: (t: string) => boolean): Item[] {
  const isImage = hit.kind === "wikiImage" || hit.kind === "mdImage";
  const absOf = async () => {
    if (/^https?:/.test(hit.target)) return hit.target;
    return ipc.resolveAsset(state.active ?? "", hit.target).catch(() => null);
  };
  if (isImage) {
    return [
      {
        label: "Open image",
        run: async () => {
          const abs = await absOf();
          if (abs) void openPath(abs);
        },
      },
      { label: "Copy image path", run: () => void navigator.clipboard.writeText(hit.target) },
      { label: "Remove image", danger: true, run: () => view.dispatch({ changes: { from: hit.from, to: hit.to } }) },
      "-",
    ];
  }
  const external = hit.kind === "url" || /^[a-z]+:/i.test(hit.target);
  return [
    { label: external ? "Open link in browser" : "Open link", run: () => (external ? window.open(hit.target) : void openLink(hit.target)) },
    { label: "Copy link", run: () => void navigator.clipboard.writeText(hit.target) },
    { label: "Edit link", run: () => view.dispatch({ selection: { anchor: hit.from, head: hit.to } }) },
    "-",
  ];
}

function buildMenu(view: EditorView, pos: number, openLink: (t: string) => boolean, spell?: SpellInfo | null): Item[] {
  const typ = isTypst();
  const sel = view.state.selection.main;
  const items: Item[] = [];
  if (spell?.word) {
    for (const s of spell.suggestions.slice(0, 6)) items.push({ label: s, run: () => replaceMisspelling(s) });
    if (!spell.suggestions.length) items.push({ label: "No spelling suggestions", run: () => {} });
    items.push({ label: `Add “${spell.word}” to dictionary`, run: () => addToDictionary(spell.word) }, "-");
  }
  const hit = hitAt(view, pos);
  if (hit) items.push(...linkItems(view, hit, openLink));

  items.push(
    { label: "Cut", hint: "Ctrl+X", run: () => void clipboard(view, "cut") },
    { label: "Copy", hint: "Ctrl+C", run: () => void clipboard(view, "copy") },
    { label: "Paste", hint: "Ctrl+V", run: () => void clipboard(view, "paste") },
    { label: "Paste as plain text", hint: "Ctrl+Shift+V", run: () => void clipboard(view, "plain") },
    { label: "Select all", hint: "Ctrl+A", run: () => (view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }), view.focus()) },
    "-",
  );

  const fmt: Item[] = [
    { label: "Bold", hint: "Ctrl+B", run: () => toggleInline(view, "bold") },
    { label: "Italic", hint: "Ctrl+I", run: () => toggleInline(view, "italic") },
    { label: "Underline", hint: "Ctrl+U", run: () => toggleInline(view, "underline") },
    { label: "Strikethrough", run: () => toggleInline(view, "strike") },
    { label: "Inline code", hint: "Ctrl+E", run: () => toggleInline(view, "code") },
  ];
  if (!typ) fmt.push({ label: "Highlight", run: () => wrapSel(view, "==") }, { label: "Inline math", run: () => insertMath(view, false) });
  if (!typ && !sel.empty) fmt.push({ label: "Clear formatting", run: () => clearFormatting(view) });
  items.push({ label: "Format", run: () => {}, items: fmt });

  const style = (s: BlockStyle) => () => setBlockStyle(view, s);
  items.push({
    label: "Paragraph",
    run: () => {},
    items: [
      { label: "Normal text", hint: "Ctrl+0", run: style("p") },
      ...([1, 2, 3, 4, 5, 6] as const).map((n): MenuItem => ({ label: `Heading ${n}`, hint: n <= 4 ? `Ctrl+${n}` : "", run: style(`h${n}` as BlockStyle) })),
      "-",
      { label: "Bulleted list", run: () => toggleList(view, "bullet") },
      { label: "Numbered list", run: () => toggleList(view, "number") },
      ...(typ ? [] : [{ label: "Task list", run: () => toggleList(view, "task") }]),
      { label: "Quote", run: style("quote") },
    ],
  });
  items.push({
    label: "Callout",
    run: () => {},
    items: Object.entries(CALLOUTS).map(([type, c]): MenuItem => ({ label: `${c.icon}  ${c.label}`, run: () => insertCallout(view, type) })),
  });
  items.push({
    label: "Insert",
    run: () => {},
    items: [
      { label: "Link", hint: "Ctrl+K", run: () => insertLink(view) },
      { label: "Table", run: () => insertTable(view, 3, 3) },
      { label: "Footnote", run: () => insertFootnote(view) },
      { label: "Horizontal rule", run: () => insertBlock(view, typ ? "#line(length: 100%)" : "---") },
      ...(typ ? [] : [{ label: "Code block", run: () => insertFenced(view, "", "") }]),
      { label: "Math block", run: () => insertMath(view, true) },
    ],
  });
  // On a heading: bookmark it.
  const lineText = view.state.doc.lineAt(view.state.selection.main.head).text;
  const heading = /^#{1,6}\s+(.*?)\s*(\{[^}]*\})?\s*$/.exec(lineText);
  if (heading && state.active && !typ) {
    const b = { type: "file" as const, path: state.active, subpath: `#${heading[1].trim()}` };
    items.push("-", { label: isBookmarked(b) ? "Remove heading bookmark" : "Bookmark this heading", run: () => toggleBookmark(b) });
  }
  items.push(
    "-",
    { label: "Copy note path", run: () => void navigator.clipboard.writeText(state.active ?? "") },
    {
      label: "Show note in file manager",
      run: () => {
        const r = root();
        const a = state.active;
        if (r && a) void openPath(`${r}/${a.includes("/") ? a.slice(0, a.lastIndexOf("/")) : ""}`);
      },
    },
    { label: "Export PDF", hint: "Ctrl+Shift+S", run: () => void exportPdf() },
  );
  return items;
}

interface SpellInfo {
  word: string;
  suggestions: string[];
}

/**
 * The DOM event fires first; Electron then reports whether a misspelled word
 * was hit. Wait briefly for that report so both end up in one menu.
 */
let pending: { e: MouseEvent; build: (s: SpellInfo | null) => Item[]; timer: number } | null = null;

function flush(spell: SpellInfo | null) {
  if (!pending) return;
  const { e, build, timer } = pending;
  clearTimeout(timer);
  pending = null;
  openMenu(e, build(spell));
}

onSpellMenu((info) => {
  if (pending) return flush(info.word ? info : null);
  // A misspelled word outside the editor (e.g. a text field).
  if (info.word) {
    const fake = new MouseEvent("contextmenu", { clientX: info.x, clientY: info.y });
    const items: Item[] = info.suggestions.slice(0, 6).map((s) => ({ label: s, run: () => replaceMisspelling(s) }));
    if (!items.length) items.push({ label: "No spelling suggestions", run: () => {} });
    items.push("-", { label: `Add “${info.word}” to dictionary`, run: () => addToDictionary(info.word) });
    openMenu(fake, items);
  }
});

export function editorContextMenu(openLink: (t: string) => boolean) {
  return EditorView.domEventHandlers({
    contextmenu(e, view) {
      // Table cells, properties etc. have their own menus.
      if ((e.target as HTMLElement).closest?.(".nz-edit-table, .nz-props-wrap")) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
      const sel = view.state.selection.main;
      if (pos < sel.from || pos > sel.to) view.dispatch({ selection: { anchor: pos } });
      // Not prevented, so Electron reports spelling (see electron/main.mjs).
      const snapshot = new MouseEvent("contextmenu", { clientX: e.clientX, clientY: e.clientY });
      if (pending) clearTimeout(pending.timer);
      pending = { e: snapshot, build: (s) => buildMenu(view, pos, openLink, s), timer: window.setTimeout(() => flush(null), 150) };
      return true;
    },
  });
}
