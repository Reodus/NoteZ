import { onCleanup, onMount, createEffect, on } from "solid-js";
import { Compartment, EditorState, Extension, Prec } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, dropCursor,
  highlightSpecialChars, rectangularSelection, crosshairCursor, placeholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, CompletionContext, completionKeymap } from "@codemirror/autocomplete";
import { setDiagnostics, lintGutter, Diagnostic as CmDiagnostic } from "@codemirror/lint";

import { app } from "../core/app";
import {
  state, prefs, updateContent, setEditorView, setCursor, setActiveTheme, activeTheme,
  isDark, notesList, openNote, root,
} from "../core/store";
import { ipc, stem } from "../core/ipc";
import { preview, schedulePreview } from "../core/render";
import { bidi } from "./bidi";
import { typst } from "./typst-lang";
import { styling, themeCss } from "./styling";
import { blockPreviews } from "./widgets";
import { livePreview } from "./livepreview";
import { mathAutoPair } from "./autopair";
import { slashCompletion, slashIconRender } from "./slash";
import { openUrl } from "../core/native";
import { toggleInline, setBlockStyle, setTitle, insertLink, BlockStyle } from "./format";

const lineNumbersComp = new Compartment();
const previewsComp = new Compartment();
const pluginComp = new Compartment();
const liveComp = new Compartment();

function wikilinkCompletion(ctx: CompletionContext) {
  const m = ctx.matchBefore(/\[\[[^\]\n]*/);
  if (!m) return null;
  return {
    from: m.from + 2,
    options: notesList().map((p) => ({ label: stem(p), detail: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "", apply: stem(p) + "]]" })),
    validFor: /^[^\]\n]*$/,
  };
}

/** Open a link target: a note name/path, or an external URL. */
export function openLinkTarget(target: string): boolean {
  if (/^(https?:|mailto:)/i.test(target)) {
    void openUrl(target);
    return true;
  }
  const name = decodeURI(target.split("#")[0].split("|")[0].trim());
  if (!name) return false;
  const hit =
    notesList().find((p) => p === name) ??
    notesList().find((p) => stem(p) === name.replace(/\.(md|typ)$/, "")) ??
    notesList().find((p) => p.endsWith("/" + name));
  if (hit) openNote(hit);
  return !!hit;
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
        if (openLinkTarget(m[1] ?? m[2])) {
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
    { key: "Mod-0", run: style("p") },
    { key: "Mod-1", run: style("h1") },
    { key: "Mod-2", run: style("h2") },
    { key: "Mod-3", run: style("h3") },
    { key: "Mod-4", run: style("h4") },
  ]);
}

function languageFor(path: string): Extension {
  if (path.endsWith(".typ")) return typst;
  return markdown({ base: markdownLanguage, codeLanguages: languages });
}

export default function Editor() {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  /** Editor state per open tab: keeps undo history and cursor when switching. */
  const states = new Map<string, EditorState>();
  let current: string | null = null;
  const live = (path: string) =>
    livePreview(prefs.editorMode === "live", path.endsWith(".typ"), {
      openLink: (t) => void openLinkTarget(t),
      notePath: () => current,
      vaultRoot: () => root(),
      resolveAsset: (note, url) => ipc.resolveAsset(note, url),
    });

  const makeState = (path: string, doc: string) =>
    EditorState.create({
      doc,
      // Start below the frontmatter so it shows as the Properties card.
      selection: { anchor: Math.min(doc.length, /^---\r?\n[\s\S]*?\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/.exec(doc)?.[0].length ?? 0) },
      extensions: [
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
        closeBrackets(),
        mathAutoPair,
        EditorView.lineWrapping,
        autocompletion({ override: [wikilinkCompletion, slashCompletion], icons: false, addToOptions: [slashIconRender], maxRenderedOptions: 60 }),
        Prec.high(formattingKeymap()),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
        languageFor(path),
        styling(path.endsWith(".typ")),
        bidi,
        lintGutter(),
        linkClick,
        placeholder(path.endsWith(".typ") ? "= Start writing Typst…" : "شروع به نوشتن کنید… / Start writing…"),
        previewsComp.of(blockPreviews(prefs.inlinePreviews, isDark())),
        liveComp.of(live(path)),
        pluginComp.of(app.editorExtensions.items()),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) updateContent(path, u.state.doc.toString());
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
    if (current && current !== path) states.set(current, view.state);
    // Drop states of closed tabs.
    for (const p of [...states.keys()]) if (!state.tabs.includes(p)) states.delete(p);
    current = path;
    if (!path) return;
    const buf = state.buffers[path];
    let st = states.get(path);
    if (!st || st.doc.toString() !== buf?.content) st = makeState(path, buf?.content ?? "");
    view.setState(st);
    // Re-apply dynamic config that may have changed while the tab was hidden.
    view.dispatch({
      effects: [
        lineNumbersComp.reconfigure(prefs.lineNumbers ? lineNumbers() : []),
        previewsComp.reconfigure(blockPreviews(prefs.inlinePreviews, isDark())),
        liveComp.reconfigure(live(path)),
        pluginComp.reconfigure(app.editorExtensions.items()),
      ],
    });
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.head);
    setCursor({ line: line.number, col: sel.head - line.from + 1, selected: 0 });
    requestAnimationFrame(() => view?.focus());
  }

  onMount(() => {
    view = new EditorView({ parent: host });
    setEditorView(view);
    show(state.active);
  });

  createEffect(on(() => state.active, (path) => show(path)));

  createEffect(on(() => [prefs.lineNumbers, prefs.inlinePreviews, isDark()] as const, ([ln, pv, dark]) => {
    view?.dispatch({
      effects: [
        lineNumbersComp.reconfigure(ln ? lineNumbers() : []),
        previewsComp.reconfigure(blockPreviews(pv, dark)),
      ],
    });
  }, { defer: true }));

  createEffect(on(() => prefs.editorMode, () => {
    if (view && current) view.dispatch({ effects: liveComp.reconfigure(live(current)) });
  }, { defer: true }));

  createEffect(on(app.editorExtensions.items, (exts) => {
    view?.dispatch({ effects: pluginComp.reconfigure(exts) });
  }, { defer: true }));

  // Note theme → CSS variables (WYSIWYM). Refetch when the frontmatter changes.
  let themeTimer: number | undefined;
  let lastFm = "";
  createEffect(() => {
    const path = state.active;
    const text = path ? state.buffers[path]?.content ?? "" : "";
    const fm = path?.endsWith(".typ") ? text.split("\n", 1)[0] : (/^---\n[\s\S]*?\n---/.exec(text)?.[0] ?? "");
    const key = `${path}\u0000${fm}`;
    if (key === lastFm) return;
    lastFm = key;
    clearTimeout(themeTimer);
    themeTimer = window.setTimeout(async () => {
      if (!path) return setActiveTheme(null);
      try {
        setActiveTheme(await ipc.noteTheme(path, text));
      } catch {
        setActiveTheme(null);
      }
    }, 250);
  });

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
  createEffect(on(() => (state.active ? state.buffers[state.active]?.content : undefined), () => schedulePreview(), { defer: false }));

  onCleanup(() => {
    setEditorView(null);
    view?.destroy();
  });

  return (
    <div
      class="editor"
      classList={{ readable: prefs.readableWidth }}
      style={{ "--editor-size": `${prefs.editorFontSize}px` }}
    >
      <div class="editor-host" ref={host} />
    </div>
  );
}
