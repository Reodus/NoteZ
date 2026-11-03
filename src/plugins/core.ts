// Built-in plugin: the app's standard commands and status items.
import type { BuiltinPlugin } from "../core/plugins";
import {
  state, setState, setDialog, closeTab, saveAll, prefs, setPrefs, setSidebarOpen, sidebarOpen, createNote,
  setRightTab, focusMode, setFocusMode, newNoteDir,
} from "../core/store";
import { chooseVault } from "../ui/Welcome";
import { graphOpen, setGraphOpen } from "../ui/GraphView";

export const corePlugin: BuiltinPlugin = {
  id: "core.commands",
  name: "Core commands",
  description: "New note, export, layout, dialogs and navigation commands.",
  onload(api) {
    const c = api.commands.register;
    c({ id: "note.new", title: "New note", key: "Mod-n", run: () => void createNote(newNoteDir(), undefined, prefs.defaultNoteType) });
    c({ id: "note.newTypst", title: "New Typst note", run: () => void createNote(newNoteDir(), "Untitled", "typ") });
    c({ id: "note.save", title: "Save all", key: "Mod-s", run: saveAll });
    c({ id: "note.close", title: "Close tab", key: "Mod-w", run: () => state.active && closeTab(state.active) });
    c({
      id: "tab.next",
      title: "Next tab",
      key: "Ctrl-Tab",
      palette: false,
      run: () => {
        const i = state.tabs.indexOf(state.active ?? "");
        if (state.tabs.length) setState("active", state.tabs[(i + 1) % state.tabs.length]);
      },
    });
    c({
      id: "tab.prev",
      title: "Previous tab",
      key: "Ctrl-Shift-Tab",
      palette: false,
      run: () => {
        const i = state.tabs.indexOf(state.active ?? "");
        if (state.tabs.length) setState("active", state.tabs[(i - 1 + state.tabs.length) % state.tabs.length]);
      },
    });
    c({ id: "vault.open", title: "Open vault…", key: "Mod-o", run: chooseVault });
    c({
      id: "layout.preview",
      title: "Toggle PDF preview",
      key: "Mod-Shift-e",
      run: () => setPrefs("layout", prefs.layout === "editor" ? "split" : "editor"),
    });
    c({ id: "layout.sidebar", title: "Toggle sidebar", key: "Mod-\\", run: () => setSidebarOpen(!sidebarOpen()) });
    const zoom = (f: number) => setPrefs("uiZoom", Math.round(Math.min(1.5, Math.max(0.75, f)) * 100) / 100);
    c({ id: "view.zoomIn", title: "Zoom in", key: "Mod-=", run: () => zoom(prefs.uiZoom + 0.05) });
    c({ id: "view.zoomOut", title: "Zoom out", key: "Mod-minus", run: () => zoom(prefs.uiZoom - 0.05) });
    c({ id: "view.zoomReset", title: "Reset zoom", run: () => zoom(1) });
    c({ id: "layout.focus", title: "Toggle focus mode (text only)", key: "Mod-Shift-Enter", run: () => setFocusMode(!focusMode()) });
    c({ id: "graph.toggle", title: "Toggle graph view", key: "Mod-g", run: () => setGraphOpen(!graphOpen()) });
    c({ id: "settings.open", title: "Settings", key: "Mod-,", run: () => setDialog({ kind: "settings" }) });
    c({ id: "doc.themes", title: "Choose document theme…", run: () => setDialog({ kind: "themes" }) });
    c({ id: "doc.page", title: "Page setup…", run: () => setDialog({ kind: "page" }) });
    c({ id: "doc.styles", title: "Show styles panel", run: () => (setPrefs("layout", "split"), setRightTab("styles")) });
    c({
      id: "editor.mode",
      title: "Toggle live preview / source mode",
      key: "Mod-Shift-m",
      run: () => setPrefs("editorMode", prefs.editorMode === "live" ? "source" : "live"),
    });
    c({ id: "editor.lineNumbers", title: "Toggle line numbers", run: () => setPrefs("lineNumbers", !prefs.lineNumbers) });
    c({ id: "editor.previews", title: "Toggle inline diagram previews", run: () => setPrefs("inlinePreviews", !prefs.inlinePreviews) });
    c({
      id: "theme.toggle",
      title: "Toggle dark mode",
      run: () => setPrefs("themeMode", document.documentElement.dataset.theme === "dark" ? "light" : "dark"),
    });
  },
};

export const readingTimePlugin: BuiltinPlugin = {
  id: "core.reading-time",
  name: "Reading time",
  description: "Shows the estimated reading time in the status bar.",
  onload(api) {
    api.statusBar.addItem({
      id: "reading-time",
      priority: 10,
      title: "Estimated reading time (~200 words/min)",
      render: () => {
        const note = api.notes.active();
        if (!note) return "";
        const words = (note.content.match(/[\p{L}\p{N}‌]+/gu) ?? []).length;
        const min = Math.max(1, Math.round(words / 200));
        return `${min} min read`;
      },
    });
  },
};
