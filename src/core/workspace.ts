// Workspace layouts, drawers, and panel navigation.
import { batch, createSignal } from "solid-js";
import { isNotePath } from "./ipc";
import { prefs, setPrefs, type Layout } from "./preferences";
import { root, state } from "./vaultState";

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
const SIDEBAR_TAB_KEY = "notez.sidebarTab";
const [sidebarTabRaw, setSidebarTabRaw] = createSignal<string>(
  (() => {
    try {
      return localStorage.getItem(SIDEBAR_TAB_KEY) || "files";
    } catch {
      return "files";
    }
  })(),
);
const [paneRequest, setPaneRequest] = createSignal(0);
/** The sidebar pane shown (files, search, tags, bookmarks); remembered between sessions. */
export const sidebarTab = sidebarTabRaw;
/** Bumped each time a pane is asked for, so it can focus its input again. */
export const sidebarPaneRequest = paneRequest;
/** Show a sidebar pane — opening the sidebar (and leaving focus mode) if it is hidden. */
export function setSidebarTab(id: string) {
  setSidebarTabRaw(id);
  try {
    localStorage.setItem(SIDEBAR_TAB_KEY, id);
  } catch {
    /* storage unavailable */
  }
  if (focusMode()) setFocusMode(false);
  setSidebarOpen(true);
  setPaneRequest((n) => n + 1);
}
export const [rightTab, setRightTab] = createSignal<string>("preview");
export const [graphOpen, setGraphOpen] = createSignal(false);
const compactMedia = window.matchMedia("(max-width: 1000px)");
const [compactWorkspace, setCompactWorkspace] = createSignal(compactMedia.matches);
export { compactWorkspace };
const [compactPanel, setDrawer] = createSignal<"sidebar" | "right" | null>(null);
const [panelFile, setPanelFile] = createSignal<string | null>(null);
export { compactPanel };
export function setCompactPanel(panel: ReturnType<typeof compactPanel>) {
  if (compactPanel() === "right" && panel !== "right" && prefs.layout === "preview") setRightTab("preview");
  setDrawer(panel);
}
compactMedia.addEventListener("change", (event) => {
  batch(() => {
    setCompactPanel(null);
    setCompactWorkspace(event.matches);
  });
});

export const sidebarOpen = () => compactWorkspace() ? compactPanel() === "sidebar" : prefs.sidebarOpen;
export function setSidebarOpen(open: boolean) {
  if (!compactWorkspace()) setPrefs("sidebarOpen", open);
  else if (open || compactPanel() === "sidebar") setCompactPanel(open ? "sidebar" : null);
}

export function showRightPanel(id: string) {
  if (!root()) return;
  batch(() => {
    setFocusMode(false);
    setGraphOpen(false);
    setRightTab(id);
    if (compactWorkspace()) {
      setCompactPanel(id === "preview" && prefs.layout === "preview" && isNotePath(state.active) ? null : "right");
    } else {
      setPanelFile(state.active && !isNotePath(state.active) ? state.active : null);
      if (prefs.layout !== "split" && (prefs.layout !== "preview" || id !== "preview")) setPrefs("layout", "split");
    }
  });
}

export function setWorkspaceLayout(layout: Layout) {
  batch(() => {
    if (layout === "preview") setRightTab("preview");
    setCompactPanel(null);
    setPanelFile(null);
    setPrefs("layout", layout);
  });
}
/** Focus mode: only the text — no sidebar, tabs, toolbar or preview. */
export const [focusMode, setFocusMode] = createSignal(false);
/** Layout actually shown (focus mode forces the editor alone). */
export const viewLayout = (): Layout => {
  if (focusMode()) return "editor";
  if (prefs.layout === "preview" && compactPanel() === "right" && rightTab() !== "preview") return "split";
  return prefs.layout;
};
export const rightPanelOpen = () => !focusMode() && !graphOpen() && (compactWorkspace()
  ? compactPanel() === "right" || (viewLayout() === "preview" && isNotePath(state.active))
  : viewLayout() !== "editor" && (state.active === null || isNotePath(state.active) || panelFile() === state.active || rightTab() !== "preview"));

export const readingTypst = () => prefs.editorMode === "read" && !!state.active?.endsWith(".typ");

/** Whether the shared renderer has a visible preview surface. */
export const documentPreviewOpen = () =>
  (readingTypst() && (!graphOpen() || focusMode())) || (rightPanelOpen() && rightTab() === "preview");
