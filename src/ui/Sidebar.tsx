import { createSignal, For, Show, createEffect, on, createRoot, Switch, Match } from "solid-js";
import { startResize } from "./resize";
import {
  Files, Search, FilePlus, FolderPlus, ChevronRight, ChevronDown, Folder, FolderOpen, FileText, FileCode2,
  FolderInput, Settings, Sun, Moon, Monitor, ArrowLeftRight, ChevronsDownUp, Waypoints, File, FileImage, FileType2,
  Hash, Bookmark,
} from "lucide-solid";
import { noteIcon } from "../core/meta";
import { SearchPane, TagsPane, BookmarksPane, newBookmarkGroup, searchFor, openReplace } from "./SidebarPanes";
import { fileMenu, newNoteIn, newFolderIn } from "./fileMenu";
import { graphOpen, setGraphOpen } from "./GraphView";
import { app } from "../core/app";
import { Entry, stem, fileKind } from "../core/ipc";
import {
  tree, root, state, openNote, moveEntry,
  sidebarTab, setSidebarTab, setDialog, prefs, setPrefs, closeVault, newNoteDir,
} from "../core/store";
import { openMenu, Popover } from "./primitives";
import { Logo } from "./Logo";
import { chooseVault } from "./Welcome";

import { t } from "../core/i18n";
// Folders start collapsed; which ones are open is remembered per vault.
const [expanded, setExpandedRaw] = createSignal<Set<string>>(new Set());
const expandKey = () => `notez.tree.${root() ?? ""}`;
function setExpanded(next: Set<string>) {
  setExpandedRaw(next);
  try {
    localStorage.setItem(expandKey(), JSON.stringify([...next]));
  } catch {
    /* storage unavailable */
  }
}
createRoot(() => {
  createEffect(on(root, () => {
    try {
      setExpandedRaw(new Set<string>(JSON.parse(localStorage.getItem(expandKey()) ?? "[]")));
    } catch {
      setExpandedRaw(new Set<string>());
    }
  }));
  // Reveal the active note: open its parent folders.
  createEffect(on(() => state.active, (path) => {
    if (!path || !path.includes("/")) return;
    const parts = path.split("/").slice(0, -1);
    const next = new Set(expanded());
    let changed = false;
    parts.forEach((_, i) => {
      const dir = parts.slice(0, i + 1).join("/");
      if (!next.has(dir)) (next.add(dir), (changed = true));
    });
    if (changed) setExpanded(next);
  }));
});
const toggleDir = (p: string) => {
  const n = new Set(expanded());
  n.has(p) ? n.delete(p) : n.add(p);
  setExpanded(n);
};

function entryMenu(e: MouseEvent, entry: Entry | null) {
  openMenu(e, fileMenu(entry, "tree"));
}

/** Which tree entries are shown (notes always; attachments and other files per settings). */
function visible(e: Entry): boolean {
  if (e.is_dir) return true;
  const k = fileKind(e.path);
  return k === "note" || k === "base" || (k === "other" ? prefs.showAllFiles : prefs.showAttachments || prefs.showAllFiles);
}

/** Open every folder up to `path`, then scroll its row into view and flash it. */
export function revealInTree(path: string) {
  const parts = path.split("/").slice(0, -1);
  const next = new Set(expanded());
  parts.forEach((_, i) => next.add(parts.slice(0, i + 1).join("/")));
  setExpanded(next);
  setTimeout(() => {
    const row = [...document.querySelectorAll<HTMLElement>(".tree-item")].find((r) => r.dataset.path === path);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.classList.remove("flash");
    void row.offsetWidth;
    row.classList.add("flash");
  }, 60);
}

export const collapseAll = () => setExpanded(new Set());
export function expandAll() {
  const all = new Set<string>();
  const walk = (es: Entry[]) => es.forEach((e) => e.is_dir && (all.add(e.path), walk(e.children)));
  walk(tree());
  setExpanded(all);
}

function FileIcon(props: { path: string }) {
  const k = () => fileKind(props.path);
  return (
    <Switch fallback={<File size={15} class="ti other" />}>
      <Match when={noteIcon(props.path)}>{(i) => <span class="note-icon">{i()}</span>}</Match>
      <Match when={props.path.endsWith(".typ")}><FileCode2 size={15} class="ti typ" /></Match>
      <Match when={k() === "note"}><FileText size={15} class="ti" /></Match>
      <Match when={k() === "image"}><FileImage size={15} class="ti image" /></Match>
      <Match when={k() === "pdf"}><FileType2 size={15} class="ti pdf" /></Match>
    </Switch>
  );
}

function TreeNode(props: { entry: Entry; depth: number }) {
  const e = () => props.entry;
  const [dragOver, setDragOver] = createSignal(false);
  const open = () => expanded().has(e().path);
  const pad = () => ({ "padding-inline-start": `${10 + props.depth * 14 + (e().is_dir ? 0 : 20)}px` });

  const dropProps = (target: string) => ({
    onDragOver: (ev: DragEvent) => {
      ev.preventDefault();
      setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (ev: DragEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      setDragOver(false);
      const from = ev.dataTransfer?.getData("text/notez-path");
      if (from) moveEntry(from, target);
    },
  });

  return (
    <Show
      when={e().is_dir}
      fallback={
        <div
          class="tree-item file"
          classList={{ active: state.active === e().path, open: state.tabs.includes(e().path) }}
          style={pad()}
          draggable={true}
          onDragStart={(ev) => ev.dataTransfer?.setData("text/notez-path", e().path)}
          onClick={() => openNote(e().path)}
          onContextMenu={(ev) => entryMenu(ev, e())}
          title={e().path}
          data-path={e().path}
        >
          <FileIcon path={e().path} />
          <span class="tree-label" dir="auto">{fileKind(e().path) === "note" ? stem(e().name) : e().name.replace(/\.[^.]+$/, "")}</span>
          <Show when={fileKind(e().path) !== "note" || e().name.endsWith(".typ")}>
            <span class="badge">{e().name.includes(".") ? e().name.slice(e().name.lastIndexOf(".") + 1).toLowerCase() : ""}</span>
          </Show>
        </div>
      }
    >
      <div
        class="tree-item dir"
        classList={{ "drag-over": dragOver() }}
        style={pad()}
        draggable={true}
        onDragStart={(ev) => ev.dataTransfer?.setData("text/notez-path", e().path)}
        onClick={() => toggleDir(e().path)}
        onContextMenu={(ev) => entryMenu(ev, e())}
        data-path={e().path}
        {...dropProps(e().path)}
      >
        <ChevronRight size={13} class="ti chev" classList={{ open: open() }} />
        {open() ? <FolderOpen size={15} class="ti folder" /> : <Folder size={15} class="ti folder" />}
        <span class="tree-label" dir="auto">{e().name}</span>
        <span class="count">{e().children.filter(visible).length || ""}</span>
      </div>
      <Show when={open()}>
        <div class="tree-children" style={{ "--guide": `${17 + props.depth * 14}px` }}>
          <For each={e().children.filter(visible)}>{(c) => <TreeNode entry={c} depth={props.depth + 1} />}</For>
        </div>
      </Show>
    </Show>
  );
}

function FilesPane() {
  const [rootOver, setRootOver] = createSignal(false);
  return (
    <div
      class="tree"
      classList={{ "drag-over": rootOver() }}
      onContextMenu={(e) => entryMenu(e, null)}
      onDragOver={(e) => (e.preventDefault(), setRootOver(true))}
      onDragLeave={() => setRootOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setRootOver(false);
        const from = e.dataTransfer?.getData("text/notez-path");
        if (from && from.includes("/")) moveEntry(from, "");
      }}
    >
      <For
        each={tree().filter(visible)}
        fallback={
          <div class="empty-hint">
            <p>{t("This vault is empty.")}</p>
            <button class="btn" onClick={() => newNoteIn("")}>
              <FilePlus size={15} /> {t("Create a note")}
            </button>
          </div>
        }
      >
        {(entry) => <TreeNode entry={entry} depth={0} />}
      </For>
    </div>
  );
}

export default function Sidebar() {
  const vaultName = () => root()?.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const panes = () => [
    { id: "files", title: t("Files"), icon: <Files size={17} /> },
    { id: "search", title: t("Search (Ctrl+Shift+F)"), icon: <Search size={17} /> },
    { id: "tags", title: t("Tags"), icon: <Hash size={17} /> },
    { id: "bookmarks", title: t("Bookmarks"), icon: <Bookmark size={17} /> },
  ];
  return (
    <aside class="sidebar" style={{ width: `${prefs.sidebarWidth}px` }}>
      <div
        class="resizer end"
        title={t("Drag to resize · double-click to reset")}
        onPointerDown={(e) =>
          startResize(e, e.currentTarget.parentElement!, 1, (w) => setPrefs("sidebarWidth", Math.max(200, Math.min(520, w))))
        }
        onDblClick={() => setPrefs("sidebarWidth", 264)}
      />
      <div class="sidebar-head">
        <Popover
          class="vault-switch"
          title={root() ?? ""}
          trigger={() => (
            <>
              <Logo size={22} />
              <span class="vault-name" dir="auto">{vaultName()}</span>
              <ChevronDown size={14} class="muted" />
            </>
          )}
        >
          {(close) => (
            <div class="menu">
              <div class="menu-title">{t("Vaults")}</div>
              <For each={prefs.recentVaults.filter((v) => v !== root())}>
                {(v) => (
                  <button class="menu-item" onClick={() => (close(), import("../core/store").then((s) => s.openVault(v)))}>
                    <span class="menu-icon"><ArrowLeftRight size={15} /></span>
                    <span class="menu-label" dir="auto">{v.split(/[\\/]/).filter(Boolean).pop()}</span>
                  </button>
                )}
              </For>
              <button class="menu-item" onClick={() => (close(), chooseVault())}>
                <span class="menu-icon"><FolderInput size={15} /></span>
                <span class="menu-label">{t("Open another vault…")}</span>
              </button>
              <div class="menu-sep" />
              <button class="menu-item" onClick={() => (close(), closeVault())}>
                <span class="menu-icon"><Logo size={15} /></span>
                <span class="menu-label">{t("Back to start screen")}</span>
              </button>
            </div>
          )}
        </Popover>
      </div>

      <div class="sidebar-tabs">
        <For each={panes()}>
          {(p) => (
            <button class="tab-icon" classList={{ active: sidebarTab() === p.id }} title={p.title} onClick={() => setSidebarTab(p.id)}>
              {p.icon}
            </button>
          )}
        </For>
        <button class="tab-icon" classList={{ active: graphOpen() }} title={t("Graph view (Ctrl+G)")} onClick={() => setGraphOpen(!graphOpen())}>
          <Waypoints size={17} />
        </button>
        <div class="spacer" />
        <Show when={sidebarTab() === "files"}>
          <button class="icon-btn" title={t("New note (Ctrl+N)")} onClick={() => newNoteIn(newNoteDir())}><FilePlus size={16} /></button>
          <button class="icon-btn" title={t("New folder")} onClick={() => newFolderIn("")}><FolderPlus size={16} /></button>
          <button class="icon-btn" title={t("Collapse all")} onClick={() => {
            setExpanded(new Set());
          }}><ChevronsDownUp size={16} /></button>
        </Show>
        <Show when={sidebarTab() === "bookmarks"}>
          <button class="icon-btn" title={t("New bookmark group")} onClick={() => newBookmarkGroup()}><FolderPlus size={16} /></button>
        </Show>
      </div>

      <div class="sidebar-body">
        <Show when={sidebarTab() === "files"}>
          <FilesPane />
        </Show>
        <Show when={sidebarTab() === "search"}>
          <SearchPane />
        </Show>
        <Show when={sidebarTab() === "tags"}>
          <TagsPane />
        </Show>
        <Show when={sidebarTab() === "bookmarks"}>
          <BookmarksPane />
        </Show>
      </div>

      <div class="sidebar-foot">
        <button class="icon-btn" title={t("Settings (Ctrl+,)")} onClick={() => setDialog({ kind: "settings" })}>
          <Settings size={17} />
        </button>
        <div class="spacer" />
        <div class="theme-switch" title={t("Appearance")}>
          <button classList={{ active: prefs.themeMode === "light" }} onClick={() => setPrefs("themeMode", "light")} title={t("Light")}><Sun size={14} /></button>
          <button classList={{ active: prefs.themeMode === "system" }} onClick={() => setPrefs("themeMode", "system")} title={t("System")}><Monitor size={14} /></button>
          <button classList={{ active: prefs.themeMode === "dark" }} onClick={() => setPrefs("themeMode", "dark")} title={t("Dark")}><Moon size={14} /></button>
        </div>
      </div>
    </aside>
  );
}

app.commands.register({ id: "search.focus", title: t("Search in vault"), key: "Mod-Shift-f", run: () => setSidebarTab("search") });
app.commands.register({ id: "search.replace", title: t("Replace in vault"), key: "Mod-Shift-h", run: () => openReplace() });
app.commands.register({ id: "tags.show", title: t("Show tags"), run: () => setSidebarTab("tags") });
app.commands.register({ id: "bookmarks.show", title: t("Show bookmarks"), run: () => setSidebarTab("bookmarks") });
export { searchFor };
