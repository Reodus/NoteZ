// Global app state: vault, open tabs, buffers, layout and preferences.
import { createSignal, createRoot, createEffect } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { EditorView } from "@codemirror/view";
import { ask, onVaultFs, trashPath } from "./native";
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
  sidebarOpen: boolean;
  previewWidth: number;
  recentVaults: string[];
  lastVault: string | null;
  enabledPlugins: string[];
  newNoteTheme: string;
  /** Rewrite links in other notes when a note or folder is renamed/moved. */
  updateLinks: "always" | "ask" | "never";
  /** Where pasted/dropped files go: a vault folder, or "./x" relative to the note. */
  attachmentFolder: string;
  /** Built-in plugins switched off. */
  disabledBuiltins: string[];
  /** Folder with note templates ("" = find a top-level "Templates" folder). */
  templatesFolder: string;
  // editor
  /** Editor font family ("" = Vazirmatn/Inter). Note themes may override it. */
  editorFont: string;
  lineHeight: number;
  spellcheck: boolean;
  tabSize: number;
  autoPair: boolean;
  vimMode: boolean;
  // files
  newNoteLocation: "root" | "current" | "folder";
  newNoteFolder: string;
  defaultNoteType: "md" | "typ";
  deleteToTrash: boolean;
  confirmDelete: boolean;
  /** Folders left out of search and the graph. */
  excludedFolders: string[];
  // PDF & preview
  /** Where Export PDF suggests saving: "" = vault root, "./" = next to the note, else an absolute folder. */
  pdfFolder: string;
  openAfterExport: boolean;
  previewDelayMs: number;
  /** Initial preview zoom: 0 = fit width, else a factor. */
  previewZoom: number;
  // appearance
  uiZoom: number;
  showTabBar: boolean;
  showStatusBar: boolean;
  animations: boolean;
  /** Custom shortcuts by command id ("" = none). */
  hotkeys: Record<string, string>;
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
  sidebarOpen: true,
  previewWidth: 520,
  recentVaults: [],
  lastVault: null,
  enabledPlugins: [],
  newNoteTheme: "default",
  updateLinks: "ask",
  attachmentFolder: "attachments",
  disabledBuiltins: [],
  templatesFolder: "",
  editorFont: "",
  lineHeight: 1.85,
  spellcheck: false,
  tabSize: 4,
  autoPair: true,
  vimMode: false,
  newNoteLocation: "root",
  newNoteFolder: "",
  defaultNoteType: "md",
  deleteToTrash: true,
  confirmDelete: true,
  excludedFolders: [],
  pdfFolder: "",
  openAfterExport: false,
  previewDelayMs: 350,
  previewZoom: 0,
  uiZoom: 1,
  showTabBar: true,
  showStatusBar: true,
  animations: true,
  hotkeys: {},
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
app.commands.setOverrides(() => prefs.hotkeys);

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

export async function createNote(dir = "", name?: string, ext: "md" | "typ" = "md", content?: (title: string) => string) {
  let base = name ?? "Untitled";
  let path = join(dir, `${base}.${ext}`);
  for (let n = 1; notesList().includes(path); n++) path = join(dir, `${base} ${n}.${ext}`);
  try {
    await ipc.createNote(path);
    const title = path.slice(path.lastIndexOf("/") + 1).replace(/\.(md|typ)$/, "");
    const initial = content
      ? content(title)
      : ext === "md" ? TEMPLATE_MD(title, prefs.newNoteTheme) : `// theme: ${prefs.newNoteTheme}\n= ${title}\n\n`;
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

/** Rename or move `path` to `to`, updating links per the preference. */
async function relocate(path: string, to: string) {
  try {
    await saveAll();
    let update = prefs.updateLinks === "always";
    if (prefs.updateLinks === "ask") {
      const n = await ipc.linkRefs(path).catch(() => 0);
      update = n > 0 && (await ask(`Update links in ${n} note${n > 1 ? "s" : ""} that point to "${path}"?`, {
        title: "Update links", okLabel: "Update links", cancelLabel: "Don't update",
      }));
    }
    const changed = await ipc.rename(path, to, update);
    moveOpen(path, to);
    // Rewritten notes that are open: take the new text (no unsaved edits — saveAll above).
    for (const p of changed.filter((c) => state.buffers[c])) {
      const content = await ipc.read(p);
      setState("buffers", p, { content, saved: content });
      app.events.emit("note:reloaded", { path: p, content });
    }
    await refreshTree();
    if (changed.length) notify(`Updated links in ${changed.length} note${changed.length > 1 ? "s" : ""}`, "success");
  } catch (e) {
    notify(String(e), "error");
  }
}

export async function renameEntry(path: string, newName: string) {
  const to = join(dirname(path), newName);
  if (to !== path) await relocate(path, to);
}

export async function moveEntry(path: string, toDir: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const to = join(toDir, name);
  if (to === path || toDir === path || toDir.startsWith(path + "/")) return;
  await relocate(path, to);
}

/** Folder for a new note, per the "new note location" setting. */
export function newNoteDir(): string {
  if (prefs.newNoteLocation === "folder") return prefs.newNoteFolder.trim().replace(/^\/+|\/+$/g, "");
  if (prefs.newNoteLocation === "current" && state.active) return dirname(state.active);
  return "";
}

export async function deleteEntry(path: string) {
  if (prefs.confirmDelete) {
    const ok = await ask(
      prefs.deleteToTrash ? `Move "${path}" to the trash?` : `Delete "${path}"? This cannot be undone.`,
      { title: "Delete", kind: "warning", okLabel: prefs.deleteToTrash ? "Move to trash" : "Delete", cancelLabel: "Cancel" },
    );
    if (!ok) return;
  }
  try {
    for (const t of state.tabs.filter((t) => t === path || t.startsWith(path + "/"))) {
      clearTimeout(saveTimers.get(t));
      setState("buffers", t, { content: "", saved: "" });
      await closeTab(t);
    }
    let trashed = false;
    if (prefs.deleteToTrash) {
      try {
        await trashPath(`${root()}/${path}`);
        trashed = true;
        await ipc.indexUpdate([path]);
      } catch (e) {
        const ok = await ask(`Could not move "${path}" to the trash (${e}). Delete it permanently?`, {
          title: "Delete", kind: "warning", okLabel: "Delete permanently", cancelLabel: "Cancel",
        });
        if (!ok) return;
      }
    }
    if (!trashed) await ipc.remove(path);
    await refreshTree();
  } catch (e) {
    notify(String(e), "error");
  }
}

// ------------------------------------------------- changes made on disk

let fsTreeTimer: number | undefined;

/** Files changed outside the app: refresh the tree and open notes. */
async function vaultChanged(paths: string[]) {
  if (!root()) return;
  if (paths.some((p) => !p.startsWith("."))) {
    clearTimeout(fsTreeTimer);
    fsTreeTimer = window.setTimeout(refreshTree, 100);
  }
  const hit = (t: string) => paths.some((p) => t === p || t.startsWith(p + "/"));
  for (const t of state.tabs.filter(hit)) {
    const b = state.buffers[t];
    if (!b) continue;
    let disk: string;
    try {
      disk = await ipc.read(t);
    } catch {
      // Deleted (or moved) outside the app.
      if (b.content === b.saved) await closeTab(t);
      else notify(`"${t}" was deleted on disk. Save (Ctrl+S) to keep your version.`, "error", undefined, 15000);
      if (b.content !== b.saved) setState("buffers", t, "saved", "");
      continue;
    }
    if (disk === b.saved || disk === b.content) {
      if (disk !== b.saved) setState("buffers", t, "saved", disk);
      continue; // our own save, or nothing new
    }
    const reload = () => {
      clearTimeout(saveTimers.get(t));
      setState("buffers", t, { content: disk, saved: disk });
      app.events.emit("note:reloaded", { path: t, content: disk });
    };
    if (b.content === b.saved) reload();
    else {
      clearTimeout(saveTimers.get(t)); // don't overwrite the disk version silently
      notify(`"${t}" changed on disk while you were editing.`, "error", { label: "Reload from disk", run: reload }, 20000);
    }
  }
}

onVaultFs((paths) => void vaultChanged(paths));

// ------------------------------------------------------------- UI state

export type Dialog =
  | null
  | { kind: "palette"; mode: "files" | "commands" }
  | { kind: "pick"; placeholder: string; items: PickItem[] }
  | { kind: "settings"; tab?: string }
  | { kind: "style"; key: string; scope: "note" | "theme" }
  | { kind: "page" }
  | { kind: "themes" }
  | { kind: "diagrams" }
  | { kind: "typst"; source: string };

export interface PickItem {
  label: string;
  detail?: string;
  run: () => void;
}

export const [dialog, setDialog] = createSignal<Dialog>(null);
/** Let the user choose one of `items` (a palette-style list). */
export const pick = (placeholder: string, items: PickItem[]) => setDialog({ kind: "pick", placeholder, items });
export const [sidebarTab, setSidebarTab] = createSignal<string>("files");
export const [rightTab, setRightTab] = createSignal<string>("preview");
export const sidebarOpen = () => prefs.sidebarOpen;
export const setSidebarOpen = (v: boolean) => setPrefs("sidebarOpen", v);
/** Focus mode: only the text — no sidebar, tabs, toolbar or preview. */
export const [focusMode, setFocusMode] = createSignal(false);
/** Layout actually shown (focus mode forces the editor alone). */
export const viewLayout = (): Layout => (focusMode() ? "editor" : prefs.layout);
