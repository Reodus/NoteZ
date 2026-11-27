// User preferences, compatibility with saved settings, and system appearance.
import { createEffect, createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { app } from "./app";

export type ThemeMode = "system" | "light" | "dark";
export type EditorMode = "live" | "source" | "read";
export type Layout = "editor" | "split" | "preview";
export const CALENDAR_PANEL = "core.daily-notes.calendar";

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
  editorMode: EditorMode;
  autosaveMs: number;
  layout: Layout;
  sidebarWidth: number;
  sidebarOpen: boolean;
  previewWidth: number;
  pinnedPanels: string[];
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
  /** Include open Markdown comments as render-only PDF margin notes. */
  commentsInPdf: boolean;
  /** Where Export PDF suggests saving: "" = vault root, "./" = next to the note, else an absolute folder. */
  pdfFolder: string;
  openAfterExport: boolean;
  /** Look for a new NoteZ release on GitHub at startup. */
  checkUpdates: boolean;
  /** Language of menus and dialogs: "auto" (system) or a code from UI_LANGUAGES. */
  uiLanguage: string;
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
  pinnedPanels: ["preview", CALENDAR_PANEL],
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
  commentsInPdf: false,
  pdfFolder: "",
  openAfterExport: false,
  checkUpdates: true,
  uiLanguage: "auto",
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
      if (Array.isArray(saved.pinnedPanels)) saved.pinnedPanels = [...new Set(saved.pinnedPanels.filter((id: unknown) => typeof id === "string"))];
      else delete saved.pinnedPanels;
      return { ...DEFAULT_PREFS, ...saved };
    }
  } catch {
    /* fall through */
  }
  return { ...DEFAULT_PREFS };
}

export const [prefs, setPrefs] = createStore<Prefs>(loadPrefs());
app.commands.setOverrides(() => prefs.hotkeys);

/** Persist synchronously when the UI is about to reload. */
export function persistPreferences() {
  const snapshot = JSON.stringify(prefs);
  try {
    localStorage.setItem(PREFS_KEY, snapshot);
  } catch {
    /* preferences remain available in memory */
  }
}

createRoot(() => createEffect(persistPreferences));

// System dark mode tracking.
const media = window.matchMedia("(prefers-color-scheme: dark)");
const [systemDark, setSystemDark] = createSignal(media.matches);
media.addEventListener("change", (e) => setSystemDark(e.matches));
export const isDark = () => (prefs.themeMode === "system" ? systemDark() : prefs.themeMode === "dark");

export function rememberVault(path: string) {
  setPrefs("lastVault", path);
  setPrefs("recentVaults", (r) => [path, ...r.filter((p) => p !== path)].slice(0, 8));
}
