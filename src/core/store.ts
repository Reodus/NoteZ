// Global app state: vault, open tabs, buffers, layout and preferences.
import { createSignal, createRoot, createEffect } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { EditorView } from "@codemirror/view";
import { ask } from "./native";
import { app, notify } from "./app";
import { ipc, Entry, Theme, dirname, join } from "./ipc";

// ------------------------------------------------------------ preferences

export type ThemeMode = "system" | "light" | "dark";
export type Layout = "editor" | "split" | "preview";

export interface Prefs {
  themeMode: ThemeMode;
  accent: string;
  editorFontSize: number;
  lineNumbers: boolean;
  readableWidth: boolean;
  inlinePreviews: boolean;
  /** "live" hides Markdown syntax off the cursor line; "source" shows it all. */
  editorMode: "live" | "source";
  autosaveMs: number;
  layout: Layout;
  sidebarWidth: number;
  previewWidth: number;
  recentVaults: string[];
  lastVault: string | null;
  enabledPlugins: string[];
  newNoteTheme: string;
}

const DEFAULT_PREFS: Prefs = {
  themeMode: "system",
  accent: "#6d5efc",
  editorFontSize: 16,
  lineNumbers: false,
  readableWidth: true,
  inlinePreviews: true,
  editorMode: "live",
  autosaveMs: 600,
  layout: "split",
  sidebarWidth: 264,
  previewWidth: 520,
  recentVaults: [],
  lastVault: null,
  enabledPlugins: [],
  newNoteTheme: "default",
};

const PREFS_KEY = "notez.prefs.v1";

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    /* fall through */
  }
  return { ...DEFAULT_PREFS };
}

export const [prefs, setPrefs] = createStore<Prefs>(loadPrefs());

createRoot(() => {
  createEffect(() => {
    const snapshot = JSON.stringify(prefs);
    try {
      localStorage.setItem(PREFS_KEY, snapshot);
    } catch {
      /* non-essential */
    }
  });
});

// System dark mode tracking.
const media = window.matchMedia("(prefers-color-scheme: dark)");
const [systemDark, setSystemDark] = createSignal(media.matches);
media.addEventListener("change", (e) => setSystemDark(e.matches));
export const isDark = () => (prefs.themeMode === "system" ? systemDark() : prefs.themeMode === "dark");

// ------------------------------------------------------------------ vault

export const [root, setRoot] = createSignal<string | null>(null);
export const [tree, setTree] = createSignal<Entry[]>([]);
export const [notesList, setNotesList] = createSignal<string[]>([]);

export interface Buffer {
  content: string;
  saved: string;
}

interface State {
  tabs: string[];
  active: string | null;
  buffers: Record<string, Buffer>;
}

export const [state, setState] = createStore<State>({ tabs: [], active: null, buffers: {} });

/** The CodeMirror view of the active note (set by the editor). */
export const [editorView, setEditorView] = createSignal<EditorView | null>(null);
/** Effective theme of the active note (for WYSIWYM styling + styles panel). */
export const [activeTheme, setActiveTheme] = createSignal<Theme | null>(null);
/** Cursor info for the status bar. */
export const [cursor, setCursor] = createSignal({ line: 1, col: 1, selected: 0 });

export const activeBuffer = () => (state.active ? state.buffers[state.active] : undefined);
export const isDirty = (path: string) => {
  const b = state.buffers[path];
  return !!b && b.content !== b.saved;
};

const saveTimers = new Map<string, number>();

export function rememberVault(path: string) {
  setPrefs("lastVault", path);
  setPrefs("recentVaults", (r) => [path, ...r.filter((p) => p !== path)].slice(0, 8));
}

export async function refreshTree() {
  try {
    setTree(await ipc.tree());
    setNotesList(await ipc.notes());
    app.events.emit("vault:changed", undefined);
  } catch (e) {
    notify(String(e), "error");
  }
}

export async function openVault(path: string) {
  await saveAll();
  try {
    setTree(await ipc.openVault(path));
    setNotesList(await ipc.notes());
  } catch (e) {
    notify(`Cannot open vault: ${e}`, "error");
    setPrefs("recentVaults", (r) => r.filter((p) => p !== path));
    if (prefs.lastVault === path) setPrefs("lastVault", null);
    return;
  }
  setState({ tabs: [], active: null, buffers: {} });
  setRoot(path);
  rememberVault(path);
  app.events.emit("vault:opened", { root: path });
}

export function closeVault() {
  saveAll();
  setRoot(null);
  setState({ tabs: [], active: null, buffers: {} });
  setPrefs("lastVault", null);
}

export async function openNote(path: string, opts: { line?: number } = {}) {
  if (!state.buffers[path]) {
    try {
      const content = await ipc.read(path);
      setState("buffers", path, { content, saved: content });
    } catch (e) {
      notify(String(e), "error");
      return;
    }
  }
  setState(
    produce((s) => {
      if (!s.tabs.includes(path)) {
        const at = s.active ? s.tabs.indexOf(s.active) + 1 : s.tabs.length;
        s.tabs.splice(at, 0, path);
      }
      s.active = path;
    }),
  );
  app.events.emit("note:opened", { path });
  if (opts.line) queueMicrotask(() => setTimeout(() => goToLine(opts.line!), 30));
}

export function goToLine(line: number) {
  const view = editorView();
  if (!view) return;
  const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
  view.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
  view.focus();
}

export function updateContent(path: string, content: string) {
  if (!state.buffers[path]) return;
  setState("buffers", path, "content", content);
  app.events.emit("note:changed", { path, content });
  clearTimeout(saveTimers.get(path));
  saveTimers.set(path, window.setTimeout(() => save(path), prefs.autosaveMs));
}

export async function save(path: string) {
  clearTimeout(saveTimers.get(path));
  const b = state.buffers[path];
  if (!b || b.content === b.saved) return;
  const content = b.content;
  try {
    await ipc.write(path, content);
    if (state.buffers[path]) setState("buffers", path, "saved", content);
    app.events.emit("note:saved", { path });
  } catch (e) {
    notify(`Save failed: ${e}`, "error");
  }
}

export async function saveAll() {
  await Promise.all(Object.keys(state.buffers).map(save));
}

export async function closeTab(path: string) {
  await save(path);
  setState(
    produce((s) => {
      const i = s.tabs.indexOf(path);
      if (i < 0) return;
      s.tabs.splice(i, 1);
      delete s.buffers[path];
      if (s.active === path) s.active = s.tabs[Math.min(i, s.tabs.length - 1)] ?? null;
    }),
  );
}

const TEMPLATE_MD = (title: string, theme: string) =>
  `---\ntitle: ${title}\ntheme: ${theme}\n---\n\n`;

export async function createNote(dir = "", name?: string, ext: "md" | "typ" = "md") {
  let base = name ?? "Untitled";
  let path = join(dir, `${base}.${ext}`);
  for (let n = 1; notesList().includes(path); n++) path = join(dir, `${base} ${n}.${ext}`);
  try {
    await ipc.createNote(path);
    const title = path.slice(path.lastIndexOf("/") + 1).replace(/\.(md|typ)$/, "");
    const initial =
      ext === "md" ? TEMPLATE_MD(title, prefs.newNoteTheme) : `// theme: ${prefs.newNoteTheme}\n= ${title}\n\n`;
    await ipc.write(path, initial);
    await refreshTree();
    await openNote(path);
    const view = editorView();
    if (view) view.dispatch({ selection: { anchor: view.state.doc.length } });
    return path;
  } catch (e) {
    notify(String(e), "error");
  }
}

export async function createFolder(dir: string, name: string) {
  try {
    await ipc.createFolder(join(dir, name));
    await refreshTree();
  } catch (e) {
    notify(String(e), "error");
  }
}

/** Re-key open tabs/buffers after a rename of a file or folder. */
function moveOpen(from: string, to: string) {
  const remap = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
  setState(
    produce((s) => {
      s.tabs = s.tabs.map(remap);
      if (s.active) s.active = remap(s.active);
      const nb: Record<string, Buffer> = {};
      for (const [k, v] of Object.entries(s.buffers)) nb[remap(k)] = v;
      s.buffers = nb;
    }),
  );
}

export async function renameEntry(path: string, newName: string) {
  const to = join(dirname(path), newName);
  if (to === path) return;
  try {
    await saveAll();
    await ipc.rename(path, to);
    moveOpen(path, to);
    await refreshTree();
  } catch (e) {
    notify(String(e), "error");
  }
}

export async function moveEntry(path: string, toDir: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const to = join(toDir, name);
  if (to === path || toDir === path || toDir.startsWith(path + "/")) return;
  try {
    await saveAll();
    await ipc.rename(path, to);
    moveOpen(path, to);
    await refreshTree();
  } catch (e) {
    notify(String(e), "error");
  }
}

export async function deleteEntry(path: string) {
  const ok = await ask(`Delete "${path}"? This cannot be undone.`, { title: "Delete", kind: "warning" });
  if (!ok) return;
  try {
    for (const t of state.tabs.filter((t) => t === path || t.startsWith(path + "/"))) {
      clearTimeout(saveTimers.get(t));
      setState("buffers", t, { content: "", saved: "" });
      await closeTab(t);
    }
    await ipc.remove(path);
    await refreshTree();
  } catch (e) {
    notify(String(e), "error");
  }
}

// ------------------------------------------------------------- UI state

export type Dialog =
  | null
  | { kind: "palette"; mode: "files" | "commands" }
  | { kind: "settings"; tab?: string }
  | { kind: "style"; key: string; scope: "note" | "theme" }
  | { kind: "page" }
  | { kind: "themes" }
  | { kind: "diagrams" }
  | { kind: "typst"; source: string };

export const [dialog, setDialog] = createSignal<Dialog>(null);
export const [sidebarTab, setSidebarTab] = createSignal<string>("files");
export const [rightTab, setRightTab] = createSignal<string>("preview");
export const [sidebarOpen, setSidebarOpen] = createSignal(true);
