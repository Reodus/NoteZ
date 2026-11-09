// Built-in plugin: the app's standard commands and status items.
import { checkForUpdates } from "../core/updates";
import type { BuiltinPlugin } from "../core/plugins";
import { activeWords } from "../core/words";
import {
  state, setState, setDialog, closeTab, saveAll, prefs, setPrefs, setSidebarOpen, sidebarOpen, createNote,
  setRightTab, focusMode, setFocusMode, newNoteDir,
} from "../core/store";
import { chooseVault } from "../ui/Welcome";
import { graphOpen, setGraphOpen } from "../ui/GraphView";
import { runSync, syncConfigured, takeSnapshot } from "../core/safety";

import { t } from "../core/i18n";
export const corePlugin: BuiltinPlugin = {
  id: "core.commands",
  name: t("Core commands"),
  description: t("New note, export, layout, dialogs and navigation commands."),
  onload(api) {
    const c = api.commands.register;
    c({ id: "note.new", title: t("New note"), key: "Mod-n", run: () => void createNote(newNoteDir(), undefined, prefs.defaultNoteType) });
    c({ id: "base.new", title: t("New database (.base)"), run: () => void import("../ui/fileMenu").then((m) => m.newBaseIn(newNoteDir())) });
    c({ id: "note.newTypst", title: t("New Typst note"), run: () => void createNote(newNoteDir(), "Untitled", "typ") });
    c({ id: "note.save", title: t("Save all"), key: "Mod-s", run: saveAll });
    c({ id: "note.close", title: t("Close tab"), key: "Mod-w", run: () => state.active && closeTab(state.active) });
    c({
      id: "tab.next",
      title: t("Next tab"),
      key: "Ctrl-Tab",
      palette: false,
      run: () => {
        const i = state.tabs.indexOf(state.active ?? "");
        if (state.tabs.length) setState("active", state.tabs[(i + 1) % state.tabs.length]);
      },
    });
    c({
      id: "tab.prev",
      title: t("Previous tab"),
      key: "Ctrl-Shift-Tab",
      palette: false,
      run: () => {
        const i = state.tabs.indexOf(state.active ?? "");
        if (state.tabs.length) setState("active", state.tabs[(i - 1 + state.tabs.length) % state.tabs.length]);
      },
    });
    c({ id: "vault.open", title: t("Open vault…"), key: "Mod-o", run: chooseVault });
    c({
      id: "layout.preview",
      title: t("Toggle PDF preview"),
      key: "Mod-Shift-e",
      run: () => setPrefs("layout", prefs.layout === "editor" ? "split" : "editor"),
    });
    c({ id: "layout.sidebar", title: t("Toggle sidebar"), key: "Mod-\\", run: () => setSidebarOpen(!sidebarOpen()) });
    const zoom = (f: number) => setPrefs("uiZoom", Math.round(Math.min(1.5, Math.max(0.75, f)) * 100) / 100);
    c({ id: "view.zoomIn", title: t("Zoom in"), key: "Mod-=", run: () => zoom(prefs.uiZoom + 0.05) });
    c({ id: "view.zoomOut", title: t("Zoom out"), key: "Mod-minus", run: () => zoom(prefs.uiZoom - 0.05) });
    c({ id: "view.zoomReset", title: t("Reset zoom"), run: () => zoom(1) });
    c({ id: "layout.focus", title: t("Toggle focus mode (text only)"), key: "Mod-Shift-Enter", run: () => setFocusMode(!focusMode()) });
    c({ id: "graph.toggle", title: t("Toggle graph view"), key: "Mod-g", run: () => setGraphOpen(!graphOpen()) });
    c({ id: "settings.open", title: t("Settings"), key: "Mod-,", run: () => setDialog({ kind: "settings" }) });
    c({ id: "help.open", title: t("Help: user guide"), key: "F1", run: () => setDialog({ kind: "help" }) });
    c({ id: "help.markdown", title: t("Help: Markdown syntax"), run: () => setDialog({ kind: "help", doc: "MARKDOWN" }) });
    c({ id: "help.themes", title: t("Help: UI themes"), run: () => setDialog({ kind: "help", doc: "UI-THEMES" }) });
    c({ id: "help.pdf-themes", title: t("Help: PDF themes"), run: () => setDialog({ kind: "help", doc: "PDF-THEMES" }) });
    c({ id: "help.languages", title: t("Help: languages"), run: () => setDialog({ kind: "help", doc: "LANGUAGES" }) });
    c({ id: "srs.review", title: t("Review flashcards"), key: "Mod-Shift-r", run: () => setDialog({ kind: "review", deck: null }) });
    c({ id: "srs.decks", title: t("Flashcards: decks and statistics"), run: () => setDialog({ kind: "review" }) });
    c({ id: "help.flashcards", title: t("Help: flashcards"), run: () => setDialog({ kind: "help", doc: "FLASHCARDS" }) });
    c({ id: "help.pdf", title: t("Help: PDF annotations"), run: () => setDialog({ kind: "help", doc: "PDF-ANNOTATIONS" }) });
    c({ id: "app.update", title: t("Check for updates"), run: () => void checkForUpdates() });
    c({ id: "help.export", title: t("Help: exporting"), run: () => setDialog({ kind: "help", doc: "EXPORT" }) });
    c({ id: "help.databases", title: t("Help: databases & queries"), run: () => setDialog({ kind: "help", doc: "DATABASES" }) });
    c({ id: "history.note", title: t("File history…"), run: () => setDialog({ kind: "history", tab: "note" }) });
    c({ id: "history.deleted", title: t("Recover deleted notes…"), run: () => setDialog({ kind: "history", tab: "deleted" }) });
    c({ id: "history.snapshots", title: t("Vault snapshots…"), run: () => setDialog({ kind: "history", tab: "snapshots" }) });
    c({ id: "history.snapshotNow", title: t("Take a vault snapshot now"), run: () => void takeSnapshot() });
    c({ id: "sync.now", title: t("Sync now"), run: () => void (syncConfigured() ? runSync(true) : setDialog({ kind: "settings", tab: "sync" })) });
    c({ id: "help.history", title: t("Help: history, snapshots & sync"), run: () => setDialog({ kind: "help", doc: "HISTORY" }) });
    c({ id: "doc.themes", title: t("Choose document theme…"), run: () => setDialog({ kind: "themes" }) });
    c({ id: "doc.page", title: t("Page setup…"), run: () => setDialog({ kind: "page" }) });
    c({ id: "doc.styles", title: t("Show styles panel"), run: () => (setPrefs("layout", "split"), setRightTab("styles")) });
    c({
      id: "editor.mode",
      title: t("Toggle live preview / source mode"),
      key: "Mod-Shift-m",
      run: () => setPrefs("editorMode", prefs.editorMode === "live" ? "source" : "live"),
    });
    c({ id: "editor.lineNumbers", title: t("Toggle line numbers"), run: () => setPrefs("lineNumbers", !prefs.lineNumbers) });
    c({ id: "editor.previews", title: t("Toggle inline diagram previews"), run: () => setPrefs("inlinePreviews", !prefs.inlinePreviews) });
    c({
      id: "theme.toggle",
      title: t("Toggle dark mode"),
      run: () => setPrefs("themeMode", document.documentElement.dataset.theme === "dark" ? "light" : "dark"),
    });
  },
};

export const readingTimePlugin: BuiltinPlugin = {
  id: "core.reading-time",
  name: t("Reading time"),
  description: t("Shows the estimated reading time in the status bar."),
  onload(api) {
    api.statusBar.addItem({
      id: "reading-time",
      priority: 10,
      title: t("Estimated reading time (~200 words/min)"),
      render: () => {
        const note = api.notes.active();
        if (!note) return "";
        const words = activeWords();
        const min = Math.max(1, Math.round(words / 200));
        return t("{n} min read", { n: min });
      },
    });
  },
};
