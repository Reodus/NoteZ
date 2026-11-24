import { onCleanup, onMount, createEffect, on } from "solid-js";
import { Compartment, EditorState, Extension, Prec, Transaction } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, dropCursor,
  highlightSpecialChars, rectangularSelection, crosshairCursor, placeholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { footnoteDefinitions } from "./footnotes";
import { footnoteComposer } from "./footnoteComposer";
import { languages } from "@codemirror/language-data";
import { codeLanguage } from "./asm";
import { bracketMatching, indentOnInput, indentUnit } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, CompletionContext, completionKeymap } from "@codemirror/autocomplete";
import { setDiagnostics, lintGutter, Diagnostic as CmDiagnostic } from "@codemirror/lint";

import { app } from "../core/app";
import {
  state, prefs, updateContent, setEditorView, setCursor, activeTheme,
  isDark, notesList, openNote, root,
  editorView, allFiles, setPdfJump, keepFocusOnOpen,
} from "../core/store";
import { dirname, ipc, isNotePath, stem, LinkInfo } from "../core/ipc";
import { frontmatterRange } from "../core/frontmatter";
import { preview, schedulePreview } from "../core/render";
import { bidi } from "./bidi";
import { typst } from "./typst-lang";
import { styling, themeCss } from "./styling";
import { blockPreviews } from "./widgets";
import { livePreview } from "./livepreview";
import { delimiterBackspace, markdownCodeAutoPair, mathAutoPair, wrapSelection } from "./autopair";
import { richPaste } from "./paste";
import { pointerHold } from "./pointer";
import { slashCompletion, slashIconRender, slashKeymap, slashGhost } from "./slash";
import { COMPLETION_SOURCES } from "./completions";
import { tagExtension } from "./tags";
import { blockExtensions, blockRefCompletion, liveEmbeds } from "./blocks";
import { commentExtension, refreshComments } from "./comments";
import { blockTools } from "./handle";
import { revealInOpenNote } from "../core/blocks";
import { searchFor } from "../ui/SidebarPanes";
import { attachmentDrop } from "./attachments";
import { trailingLine } from "./trailing";
import { tableKeys, skipTableCaret } from "./tables";
import { editorContextMenu, clipboard } from "./contextmenu";
import { openUrl } from "../core/native";
import { toggleInline, setBlockStyle, setTitle, insertLink, BlockStyle } from "./format";

const lineNumbersComp = new Compartment();
const previewsComp = new Compartment();
const pluginComp = new Compartment();
const liveComp = new Compartment();
const commentsComp = new Compartment();
/** Settings → Editor: tab size, bracket pairing, spellcheck, Vim. */
const prefsComp = new Compartment();
const vimComp = new Compartment();
let vimExt: Extension | null = null;

function editorPrefs(): Extension {
  return [
    EditorState.tabSize.of(prefs.tabSize),
    indentUnit.of(" ".repeat(prefs.tabSize)),
    prefs.autoPair ? [markdownCodeAutoPair, closeBrackets(), wrapSelection] : [],
    EditorView.contentAttributes.of({ spellcheck: prefs.spellcheck ? "true" : "false" }),
  ];
}

/** Vim keys, loaded on first use. */
async function vimMode(): Promise<Extension> {
  if (!prefs.vimMode) return [];
  if (!vimExt) vimExt = (await import("@replit/codemirror-vim")).vim();
  return vimExt;
}

// Note names, aliases and headings for [[ completion; refreshed when the vault changes.
let linkInfo: Promise<LinkInfo[]> | null = null;
app.events.on("vault:changed", () => (linkInfo = null));
app.events.on("vault:opened", () => (linkInfo = null));
app.events.on("note:saved", () => (linkInfo = null));
const getLinkInfo = () => (linkInfo ??= ipc.linkInfo().catch(() => []));

/** Insert `text`, then "]]" unless the brackets were already auto-closed. */
const closeLink = (text: string) => (view: EditorView, _c: unknown, from: number, to: number) => {
  const closed = view.state.sliceDoc(to, to + 2) === "]]";
  view.dispatch({
    changes: { from, to, insert: text + (closed ? "" : "]]") },
    selection: { anchor: from + text.length + 2 },
  });
};

async function wikilinkCompletion(ctx: CompletionContext) {
  const m = ctx.matchBefore(/\[\[[^\]\n]*/);
  if (!m) return null;
  const typed = m.text.slice(2);
  const hash = typed.indexOf("#");
  if (hash >= 0) {
    // [[note#heading
    const name = typed.slice(0, hash).trim();
    const info = await getLinkInfo();
    const note = name
      ? info.find((n) => n.path === name || stem(n.path) === name.replace(/\.(md|typ)$/, "") || n.path.replace(/\.(md|typ)$/, "") === name)
      : info.find((n) => n.path === state.active);
    if (!note) return null;
    return {
      from: m.from + 2 + hash + 1,
      options: note.headings.map((h) => ({ label: h, type: "heading", apply: closeLink(h) })),
      validFor: /^[^\]\n#|]*$/,
    };
  }
  if (typed.includes("|")) return null;
  const info = await getLinkInfo();
  const folder = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const counts = new Map<string, number>();
  for (const n of info) counts.set(stem(n.path), (counts.get(stem(n.path)) ?? 0) + 1);
  // Duplicate names link by path, like Obsidian.
  const target = (p: string) => ((counts.get(stem(p)) ?? 0) > 1 ? p.replace(/\.md$/, "") : stem(p));
  const notes = info.length ? info.map((n) => n.path) : notesList();
  return {
    from: m.from + 2,
    options: [
      ...notes.map((p) => ({ label: stem(p), detail: folder(p), apply: closeLink(target(p)), boost: p === state.active ? -1 : 0 })),
      ...info.flatMap((n) =>
        n.aliases.map((a) => ({ label: a, detail: `→ ${stem(n.path)}`, apply: closeLink(`${target(n.path)}|${a}`), boost: -2 })),
      ),
    ],
    validFor: /^[^\]\n#|]*$/,
  };
}

/** Open a link target: a note name/path (with `#Heading` or `#^block`), or an external URL. */
export function openLinkTarget(target: string, markdown = false): boolean {
  if (/^(https?:|mailto:)/i.test(target)) {
    void openUrl(target);
    return true;
  }
  const clean = target.split("|")[0].trim();
  let name = clean.split("#")[0];
  const sub = clean.includes("#") ? clean.slice(clean.indexOf("#") + 1) : "";
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep as typed */
  }
  if (!name) return sub ? revealInOpenNote(sub) : false;
  const files = allFiles();
  const local = dirname(state.active ?? "");
  const resolvePath = (path: string) => {
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) return null;
        parts.pop();
      } else parts.push(part);
    }
    return parts.join("/");
  };
  const relative = resolvePath(`${local}/${name}`);
  const absolute = resolvePath(name);
  const explicit = name.startsWith("/") || /^\.\.?\//.test(name);
  const candidates = name.startsWith("/") ? [absolute]
    : explicit ? [relative] : markdown ? [relative, absolute] : [absolute, relative];
  const exact = candidates.flatMap((p) => p ? [p, `${p}.md`, `${p}.typ`] : [])
    .map((p) => files.find((f) => f === p) ?? notesList().find((f) => f === p))
    .find(Boolean);
  const hit = exact ?? (explicit ? undefined :
    notesList().find((p) => p === name) ??
    notesList().find((p) => p.replace(/\.(md|typ)$/, "") === name.replace(/\.(md|typ)$/, "")) ??
    notesList().find((p) => stem(p) === name.replace(/\.(md|typ)$/, "")) ??
    notesList().find((p) => p.endsWith("/" + name)));
  if (hit && isNotePath(hit)) {
    void openNote(hit).then(() => sub && whenShown(hit, () => revealInOpenNote(sub)));
    return true;
  }
  // A PDF, image or other file: [[paper.pdf#page=3&annotation=id]]
  const lower = name.toLowerCase();
  const file = hit ?? (!explicit ? files.find((p) => p.toLowerCase() === lower) ?? files.find((p) => p.toLowerCase().endsWith("/" + lower)) : undefined);
  if (!file) return false;
  void openNote(file).then(() => {
    if (!/\.pdf$/i.test(file) || !sub) return;
    const q = new URLSearchParams(/^\d+$/.test(sub) ? `page=${sub}` : sub);
    const page = Number(q.get("page")) || undefined;
    setPdfJump({ path: file, page, annotation: q.get("annotation") ?? undefined, n: Date.now() });
  });
  return true;
}

/** Run `fn` once the editor shows note `path` (right after opening it). */
function whenShown(path: string, fn: () => void, tries = 20) {
  if (state.active !== path) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = app.events.on("note:opened", () => { clearTimeout(timer); cancel(); });
  const check = () => {
    const view = editorView();
    if (state.active !== path) { cancel(); return; }
    if (view && view.state.doc.toString() === editorText(state.buffers[path]?.content ?? "")) { cancel(); fn(); }
    else if (tries-- > 0) timer = setTimeout(check, 25);
    else cancel();
  };
  check();
}

/** Ctrl+click on [[wikilinks]] and [text](target) links opens them. */
const linkClick = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (!(e.ctrlKey || e.metaKey)) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return false;
    const line = view.state.doc.lineAt(pos);
    const off = pos - line.from;
    for (const m of line.text.matchAll(/\[\[([^\]]+)\]\]|\]\(([^)\s]+)[^)]*\)/g)) {
      if (off >= m.index! && off <= m.index! + m[0].length) {
        if (openLinkTarget(m[1] ?? m[2], m[1] === undefined)) {
          e.preventDefault();
          return true;
        }
      }
    }
    return false;
  },
});

function formattingKeymap() {
  const style = (s: BlockStyle) => (v: EditorView) => (setBlockStyle(v, s), true);
  return keymap.of([
    { key: "Mod-b", run: (v) => (toggleInline(v, "bold"), true) },
    { key: "Mod-i", run: (v) => (toggleInline(v, "italic"), true) },
    { key: "Mod-u", run: (v) => (toggleInline(v, "underline"), true) },
    { key: "Mod-Shift-x", run: (v) => (toggleInline(v, "strike"), true) },
    { key: "Mod-e", run: (v) => (toggleInline(v, "code"), true) },
    { key: "Mod-k", run: (v) => (insertLink(v), true) },
    { key: "Mod-Shift-t", run: (v) => (setTitle(v), true) },
    // Paste exactly as copied: no HTML → Markdown, no PDF re-flow.
    { key: "Mod-Shift-v", run: (v) => (void clipboard(v, "plain"), true) },
    { key: "Mod-0", run: style("p") },
    { key: "Mod-1", run: style("h1") },
    { key: "Mod-2", run: style("h2") },
    { key: "Mod-3", run: style("h3") },
    { key: "Mod-4", run: style("h4") },
  ]);
}

function languageFor(path: string): Extension {
  if (path.endsWith(".typ")) return typst;
  return markdown({ base: markdownLanguage, codeLanguages: codeLanguage(languages), extensions: [footnoteDefinitions] });
}

/** Editor state per open tab (undo history, cursor), kept while the editor
 * is unmounted, e.g. while an image or PDF tab is shown. */
const states = new Map<string, EditorState>();
interface ReadingPosition { pos: number; offset: number; left: number }
const scrolls = new Map<string, ReadingPosition>();
app.events.on("vault:opened", () => { states.clear(); scrolls.clear(); });

/** Patch disk changes without resetting the cursor, history or viewport anchor. */
const editorText = (text: string) => text.replace(/\r\n?/g, "\n");

function textChange(before: string, after: string) {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let suffix = 0;
  while (suffix < before.length - from && suffix < after.length - from && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { from, to: before.length - suffix, insert: after.slice(from, after.length - suffix) };
}

export default function Editor() {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  /** Editor state per open tab: keeps undo history and cursor when switching. */
  let current: string | null = null;
  let focusFrame = 0;
  let restore: { position: ReadingPosition; frame: number } | null = null;

  function readingPosition(v: EditorView): ReadingPosition {
    if (restore) return restore.position;
    const { scrollTop, scrollLeft } = v.scrollDOM;
    const y = scrollTop + 12 - v.documentPadding.top;
    const block = v.viewportLineBlocks.find(({ top, bottom }) => top <= y && y <= bottom) ?? v.lineBlockAtHeight(y);
    return { pos: block.from, offset: scrollTop - block.top, left: scrollLeft };
  }

  function cancelRestore() {
    if (restore) cancelAnimationFrame(restore.frame);
    restore = null;
  }

  function restoreReadingPosition(v: EditorView, position: ReadingPosition) {
    cancelRestore();
    const apply = () => {
      v.scrollDOM.scrollTop = v.lineBlockAt(position.pos).top + position.offset;
      v.scrollDOM.scrollLeft = position.left;
    };
    // Let the destination view measure its layout first. The first scroll
    // brings the anchor into the viewport, where its height is then measured.
    restore = { position, frame: requestAnimationFrame(() => {
      apply();
      if (restore) restore.frame = requestAnimationFrame(() => {
        apply();
        restore = null;
      });
    }) };
  }
  const live = (path: string) => [
    prefs.editorMode === "live" && !path.endsWith(".typ") ? liveEmbeds : [],
    livePreview(prefs.editorMode === "live", path.endsWith(".typ"), {
      openLink: (target, markdown) => void openLinkTarget(target, markdown),
      notePath: () => current,
      vaultRoot: () => root(),
      resolveAsset: (note, url) => ipc.resolveAsset(note, url),
    }),
  ];

  const makeState = (path: string, doc: string) =>
    EditorState.create({
      doc,
      // Start below the frontmatter so it shows as the Properties card.
      selection: { anchor: path.toLowerCase().endsWith(".md") ? frontmatterRange(doc)?.bodyStart ?? 0 : 0 },
      extensions: [
        vimComp.of(vimExt && prefs.vimMode ? vimExt : []),
        prefsComp.of(editorPrefs()),
        lineNumbersComp.of(prefs.lineNumbers ? lineNumbers() : []),
        history(),
        drawSelection(),
        dropCursor(),
        highlightSpecialChars(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        rectangularSelection(),
        crosshairCursor(),
        indentOnInput(),
        bracketMatching(),
        mathAutoPair,
        Prec.high(delimiterBackspace),
        EditorView.lineWrapping,
        autocompletion({ override: [wikilinkCompletion, blockRefCompletion, slashCompletion, ...COMPLETION_SOURCES], icons: false, addToOptions: [slashIconRender], maxRenderedOptions: 80 }),
        slashKeymap,
        slashGhost,
        tagExtension((tag) => searchFor(`tag:${tag}`)),
        path.endsWith(".typ") ? [] : [blockExtensions(), blockTools()],
        footnoteComposer,
        commentsComp.of(prefs.disabledBuiltins.includes("core.comments") ? [] : commentExtension(path)),
        Prec.high(formattingKeymap()),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
        languageFor(path),
        styling(path.endsWith(".typ")),
        bidi,
        lintGutter(),
        linkClick,
        editorContextMenu(openLinkTarget),
        tableKeys,
        skipTableCaret,
        pointerHold,
        attachmentDrop,
        richPaste,
        trailingLine(path.endsWith(".typ")),
        placeholder(path.endsWith(".typ") ? "= Start writing Typst…" : "شروع به نوشتن کنید… / Start writing…"),
        previewsComp.of(blockPreviews(prefs.inlinePreviews, isDark())),
        liveComp.of(live(path)),
        pluginComp.of(app.editorExtensions.items()),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet || u.transactions.some((tr) => tr.scrollIntoView)) cancelRestore();
          if (u.docChanged && !u.transactions.some((tr) => tr.annotation(Transaction.userEvent) === "notez.reload")) {
            const text = u.state.doc.toString();
            const b = state.buffers[path];
            updateContent(path, /\r\n/.test(b?.content ?? "") || /\r\n/.test(b?.saved ?? "") ? text.replace(/\n/g, "\r\n") : text);
          }
          if (u.docChanged || u.selectionSet) {
            const sel = u.state.selection.main;
            const line = u.state.doc.lineAt(sel.head);
            setCursor({ line: line.number, col: sel.head - line.from + 1, selected: Math.abs(sel.to - sel.from) });
          }
        }),
      ],
    });

  function show(path: string | null) {
    if (!view) return;
    if (path && current === path && view.state.doc.toString() === editorText(state.buffers[path]?.content ?? "")) return;
    cancelAnimationFrame(focusFrame);
    if (current && current !== path) {
      states.set(current, view.state);
      scrolls.set(current, readingPosition(view));
    }
    cancelRestore();
    // Drop states of closed tabs.
    for (const p of [...states.keys()]) if (!state.tabs.includes(p)) { states.delete(p); scrolls.delete(p); }
    current = path;
    if (!path) return;
    const doc = editorText(state.buffers[path]?.content ?? "");
    let st = states.get(path);
    if (!st) st = makeState(path, doc);
    else if (st.doc.toString() !== doc) {
      const tr = st.update({ changes: textChange(st.doc.toString(), doc), effects: refreshComments.of(), annotations: Transaction.addToHistory.of(false) });
      const reading = scrolls.get(path);
      if (reading) scrolls.set(path, { ...reading, pos: tr.changes.mapPos(reading.pos, 1) });
      st = tr.state;
    }
    view.scrollDOM.scrollTop = 0;
    view.scrollDOM.scrollLeft = 0;
    view.setState(st);
    // Re-apply dynamic config that may have changed while the tab was hidden.
    view.dispatch({
      effects: [
        refreshComments.of(),
        commentsComp.reconfigure(prefs.disabledBuiltins.includes("core.comments") ? [] : commentExtension(path)),
        lineNumbersComp.reconfigure(prefs.lineNumbers ? lineNumbers() : []),
        previewsComp.reconfigure(blockPreviews(prefs.inlinePreviews, isDark())),
        liveComp.reconfigure(live(path)),
        pluginComp.reconfigure(app.editorExtensions.items()),
        prefsComp.reconfigure(editorPrefs()),
        vimComp.reconfigure(vimExt && prefs.vimMode ? vimExt : []),
      ],
    });
    const reading = scrolls.get(path);
    if (reading) restoreReadingPosition(view, reading);
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.head);
    setCursor({ line: line.number, col: sel.head - line.from + 1, selected: 0 });
    if (!keepFocusOnOpen(path)) {
      focusFrame = requestAnimationFrame(() => { if (current === path && state.active === path) view?.focus(); });
    }
  }

  onMount(() => {
    view = new EditorView({ parent: host });
    view.scrollDOM.addEventListener("wheel", cancelRestore, { passive: true, capture: true });
    view.scrollDOM.addEventListener("pointerdown", cancelRestore, { capture: true });
    setEditorView(view);
    show(state.active);
  });

  // A note changed on disk: patch only the differing middle so the cursor
  // and scroll position stay put. (Hidden tabs rebuild in show().)
  onCleanup(app.events.on("note:reloaded", ({ path, content }) => {
    if (!view || path !== current) return;
    const old = view.state.doc.toString();
    const doc = editorText(content);
    if (old === doc) return;
    const tr = view.state.update({ changes: textChange(old, doc), effects: refreshComments.of(),
      annotations: [Transaction.addToHistory.of(false), Transaction.userEvent.of("notez.reload")] });
    const reading = readingPosition(view);
    view.dispatch(tr);
    restoreReadingPosition(view, { ...reading, pos: tr.changes.mapPos(reading.pos, 1) });
  }));

  createEffect(on(() => state.active, (path) => show(path)));

  createEffect(on(() => [prefs.lineNumbers, prefs.inlinePreviews, isDark()] as const, ([ln, pv, dark]) => {
    view?.dispatch({
      effects: [
        lineNumbersComp.reconfigure(ln ? lineNumbers() : []),
        previewsComp.reconfigure(blockPreviews(pv, dark)),
      ],
    });
  }, { defer: true }));

  createEffect(on(() => [prefs.tabSize, prefs.autoPair, prefs.spellcheck] as const, () => {
    view?.dispatch({ effects: prefsComp.reconfigure(editorPrefs()) });
  }, { defer: true }));

  createEffect(on(() => prefs.vimMode, async () => {
    const ext = await vimMode();
    view?.dispatch({ effects: vimComp.reconfigure(ext) });
  }));

  createEffect(on(() => prefs.disabledBuiltins.includes("core.comments"), disabled => {
    if (view && current) view.dispatch({ effects: commentsComp.reconfigure(disabled ? [] : commentExtension(current)) });
  }, { defer: true }));

  createEffect(on(() => prefs.editorMode, () => {
    if (view && current) view.dispatch({ effects: liveComp.reconfigure(live(current)) });
  }, { defer: true }));

  createEffect(on(app.editorExtensions.items, (exts) => {
    view?.dispatch({ effects: pluginComp.reconfigure(exts) });
  }, { defer: true }));

  createEffect(() => {
    const vars = themeCss(activeTheme());
    host.style.cssText = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";");
  });

  // Compiler diagnostics → inline markers.
  createEffect(() => {
    const p = preview();
    if (!view || p.path !== state.active) return;
    const doc = view.state.doc;
    const diags: CmDiagnostic[] = p.diagnostics
      .filter((d) => d.line != null && d.line <= doc.lines)
      .map((d) => {
        const line = doc.line(d.line!);
        const from = d.column ? Math.min(line.from + d.column - 1, line.to) : line.from;
        return {
          from,
          to: d.column ? Math.min(from + 1, line.to) : line.to,
          severity: d.severity,
          message: d.message + (d.hints.length ? `\nHint: ${d.hints.join("\nHint: ")}` : ""),
        };
      });
    view.dispatch(setDiagnostics(view.state, diags));
  });

  // Live preview follows typing.
  createEffect(on(() => [state.active ? state.buffers[state.active]?.content : undefined, prefs.commentsInPdf], () => schedulePreview(), { defer: false }));

  onCleanup(() => {
    cancelAnimationFrame(focusFrame);
    if (view && current) { states.set(current, view.state); scrolls.set(current, readingPosition(view)); }
    cancelRestore();
    setEditorView(null);
    view?.destroy();
    view = undefined;
  });

  return (
    <div
      class="editor"
      classList={{ readable: prefs.readableWidth }}
      style={{
        "--editor-size": `${prefs.editorFontSize}px`,
        "--editor-line-height": String(prefs.lineHeight),
        ...(prefs.editorFont ? { "--font-editor": `"${prefs.editorFont.replace(/"/g, "")}", "Inter Variable", var(--font-scripts), sans-serif` } : {}),
      }}
    >
      <div class="editor-host" ref={host} />
    </div>
  );
}
