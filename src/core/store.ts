// Global app state: vault, open tabs, buffers, layout and preferences.
import { createSignal, createRoot, createEffect } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { EditorView } from "@codemirror/view";
import { ask, onVaultFs, openPath, trashPath } from "./native";
import { renameBookmarkPaths } from "./bookmarks";
import { app, notify } from "./app";
import { ipc, Entry, Theme, dirname, join, fileKind } from "./ipc";

// ------------------------------------------------------------ preferences

export type ThemeMode = "system" | "light" | "dark";
export type Layout = "editor" | "split" | "preview";

export interface Prefs {
  themeMode: ThemeMode;
  /** UI theme used in light mode (src/core/uithemes.ts ids). */
  uiThemeLight: string;
  /** UI theme used in dark mode. */
  uiThemeDark: string;
  /** CSS snippets switched on (ids = file names without .css). */
  enabledSnippets: string[];
  /** Accent color; "" = the theme's own accent. */
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
  /** Where pasted/dropped files go (like Obsidian's "Default location for new attachments"). */
  attachmentMode: "root" | "folder" | "same" | "subfolder";
  /** The vault folder ("folder" mode) or the subfolder name ("subfolder" mode). */
  attachmentFolder: string;
  /** File name for pasted images without a name; `{{date:FMT}}` and `{{note}}` are filled in. */
  attachmentName: string;
  /** File tree: show images and PDFs next to notes. */
  showAttachments: boolean;
  /** File tree: show every file type (others open in their default app). */
  showAllFiles: boolean;
  /** Built-in plugins switched off. */
  disabledBuiltins: string[];
  /** Folder with note templates ("" = find a top-level "Templates" folder). */
  templatesFolder: string;
  /** Daily notes: folder ("" = vault root). */
  dailyFolder: string;
  /** Daily notes: file name as a date format (may contain "/" for subfolders). */
  dailyFormat: string;
  /** Daily notes: template note ("" = none). */
  dailyTemplate: string;
  /** First day of the week in the calendar: 0 = Sunday, 1 = Monday, 6 = Saturday. */
  weekStart: number;
  /** Quick capture: global shortcut ("" = off), Electron accelerator syntax. */
  captureShortcut: string;
  /** Quick capture: where captured text goes: "daily" or a note path. */
  captureTarget: string;
  /** Quick capture: line format; {{text}}, {{date:…}}, {{time:…}}. */
  captureFormat: string;
  // editor
  /** Editor font family ("" = Inter, with a bundled font for every other script). Note themes may override it. */
  editorFont: string;
  lineHeight: number;
  spellcheck: boolean;
  /** Spell-checker dictionaries, e.g. ["en-US", "de", "fa"] (empty = system language + English). */
  spellcheckLanguages: string[];
  /**
   * Language of new notes ("" = detect from the text). Written to the new
   * note's frontmatter as `lang:`; sets direction, fonts and digits.
   */
  defaultLanguage: string;
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
  /** Graph view options (see GraphView.tsx; missing keys take the defaults). */
  graph: Record<string, unknown>;
  // flashcards (src/ui/ReviewView.tsx)
  /** Wanted chance of remembering a card when it comes due. */
  srsRetention: number;
  srsNewPerDay: number;
  /** Days. */
  srsMaxInterval: number;
  /** Minutes, space-separated ("1 10"). */
  srsLearningSteps: string;
  srsRelearningSteps: string;
  // history
  historyEnabled: boolean;
  /** Minutes: saves within this window make one version. */
  historyInterval: number;
  historyKeepDays: number;
  historyMaxVersions: number;
  /** Take a vault snapshot once a day (when the vault is open). */
  snapshotDaily: boolean;
  /** Automatic snapshots kept. */
  snapshotKeep: number;
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
  uiThemeLight: "light",
  uiThemeDark: "dark",
  enabledSnippets: [],
  accent: "",
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
  attachmentMode: "folder",
  attachmentFolder: "attachments",
  attachmentName: "Pasted image {{date:YYYYMMDDHHmmss}}",
  showAttachments: true,
  showAllFiles: false,
  disabledBuiltins: [],
  templatesFolder: "",
  dailyFolder: "Daily",
  dailyFormat: "YYYY-MM-DD",
  dailyTemplate: "",
  weekStart: 1,
  captureShortcut: "",
  captureTarget: "daily",
  captureFormat: "- {{time}} {{text}}",
  editorFont: "",
  lineHeight: 1.85,
  spellcheck: false,
  spellcheckLanguages: [],
  defaultLanguage: "",
  tabSize: 4,
  autoPair: true,
  vimMode: false,
  newNoteLocation: "root",
  newNoteFolder: "",
  defaultNoteType: "md",
  deleteToTrash: true,
  confirmDelete: true,
  excludedFolders: [],
  graph: {},
  srsRetention: 0.9,
  srsNewPerDay: 20,
  srsMaxInterval: 36500,
  srsLearningSteps: "1 10",
  srsRelearningSteps: "10",
  historyEnabled: true,
  historyInterval: 10,
  historyKeepDays: 60,
  historyMaxVersions: 300,
  snapshotDaily: true,
  snapshotKeep: 14,
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
    if (raw) {
      const saved = JSON.parse(raw);
      // Before 0.5: one field, "./x" meaning "x next to the note".
      if (!saved.attachmentMode && typeof saved.attachmentFolder === "string") {
        const f = saved.attachmentFolder.trim();
        if (f.startsWith(".")) {
          const sub = f.replace(/^\.\/?/, "").replace(/\/+$/, "");
          saved.attachmentMode = sub ? "subfolder" : "same";
          saved.attachmentFolder = sub || "attachments";
        } else saved.attachmentMode = "folder";
      }
      // Before 0.6 the accent was always set; the old default now means "the theme's accent".
      if (saved.accent === "#6d5efc" && !("uiThemeLight" in saved)) saved.accent = "";
      return { ...DEFAULT_PREFS, ...saved };
    }
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

/** Every file in the vault tree (notes, PDFs, images…). */
export function allFiles(): string[] {
  const out: string[] = [];
  const walk = (es: Entry[]) => es.forEach((e) => (e.is_dir ? walk(e.children) : out.push(e.path)));
  walk(tree());
  return out;
}

/** A PDF link to follow: the PDF view scrolls to the page / annotation. `n` makes repeats distinct. */
export const [pdfJump, setPdfJump] = createSignal<{ path: string; page?: number; annotation?: string; n: number } | null>(null);

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

/**
 * Reload the file tree. Saving a note also reaches here (through the vault
 * watcher), but leaves the tree as it was: keep the old one then, so the
 * list isn't rebuilt (rows re-rendered, hover and scroll lost) on every save.
 * "vault:changed" still fires: plugins may care about content changes.
 */
export async function refreshTree() {
  try {
    const [t, n] = await Promise.all([ipc.tree(), ipc.notes()]);
    const sameTree = JSON.stringify(t) === JSON.stringify(tree());
    const sameNotes = JSON.stringify(n) === JSON.stringify(notesList());
    if (!sameTree) setTree(t);
    if (!sameNotes) setNotesList(n);
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

/**
 * Open a path handed over by the OS (macOS Finder / Dock). A folder becomes
 * the vault; a file opens in the current vault when it lives there, otherwise
 * its folder is opened as the vault first.
 */
export async function openOsPath(p: string) {
  const path = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (!base.includes(".")) return openVault(path);
  const r = root();
  if (!r || !path.startsWith(r + "/")) await openVault(dirname(path) || "/");
  const now = root();
  if (now && path.startsWith(now + "/")) await openNote(path.slice(now.length + 1));
}

/** Bumped when files change on disk, so image/PDF tabs reload. */
export const [fileRev, setFileRev] = createSignal(0);

/** Open a vault file: notes in the editor, images and PDFs in a viewer tab, anything else in its default app. */
export async function openNote(path: string, opts: { line?: number } = {}) {
  const kind = fileKind(path);
  if (kind === "other") {
    if (root()) await openPath(`${root()}/${path}`).catch((e) => notify(String(e), "error"));
    return;
  }
  if (kind === "note" && !state.buffers[path]) {
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
  `---\ntitle: ${title}\ntheme: ${theme}\n${prefs.defaultLanguage ? `lang: ${prefs.defaultLanguage}\n` : ""}---\n\n`;

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
    renameBookmarkPaths(path, to);
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
    // History keeps the notes (Recover deleted notes), also from the trash.
    await ipc.historyKeep(path, "deleted").catch(() => {});
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

/** Take an open note's text from disk (after the app rewrote it, e.g. replace). */
export async function reloadFromDisk(path: string) {
  if (!state.buffers[path]) return;
  const content = await ipc.read(path);
  clearTimeout(saveTimers.get(path));
  setState("buffers", path, { content, saved: content });
  app.events.emit("note:reloaded", { path, content });
}

let fsTreeTimer: number | undefined;

/** Files changed outside the app: refresh the tree and open notes. */
async function vaultChanged(paths: string[]) {
  if (!root()) return;
  if (paths.some((p) => !p.startsWith("."))) {
    clearTimeout(fsTreeTimer);
    fsTreeTimer = window.setTimeout(refreshTree, 100);
  }
  const hit = (t: string) => paths.some((p) => t === p || t.startsWith(p + "/"));
  if (state.tabs.some((t) => fileKind(t) !== "note" && hit(t))) setFileRev((n) => n + 1);
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
  | { kind: "help"; doc?: string; anchor?: string }
  | { kind: "themes" }
  | { kind: "diagrams" }
  | { kind: "typst"; source: string }
  | { kind: "history"; tab?: "note" | "deleted" | "snapshots"; path?: string }
  /** deck: open a session for that deck (null = all); missing = the deck list. */
  | { kind: "review"; deck?: string | null };

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
