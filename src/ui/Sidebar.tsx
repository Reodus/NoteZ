import { createSignal, For, Show, createEffect, on, createRoot, Switch, Match } from "solid-js";
import {
  Files, Search, FilePlus, FolderPlus, ChevronRight, ChevronDown, Folder, FolderOpen, FileText, FileCode2,
  FolderInput, Settings, Sun, Moon, Monitor, ArrowLeftRight, ChevronsDownUp, Waypoints, File, FileImage, FileType2,
} from "lucide-solid";
import { fileMenu, newNoteIn, newFolderIn } from "./fileMenu";
import { graphOpen, setGraphOpen } from "./GraphView";
import { app } from "../core/app";
import { Entry, dirname, ipc, SearchHit, stem, fileKind } from "../core/ipc";
import {
  tree, root, state, openNote, moveEntry,
  sidebarTab, setSidebarTab, setDialog, prefs, setPrefs, closeVault, newNoteDir,
} from "../core/store";
import { openMenu, Popover } from "./primitives";
import { Logo } from "./Logo";
import { chooseVault } from "./Welcome";

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
  return k === "note" || (k === "other" ? prefs.showAllFiles : prefs.showAttachments || prefs.showAllFiles);
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
            <p>This vault is empty.</p>
            <button class="btn" onClick={() => newNoteIn("")}>
              <FilePlus size={15} /> Create a note
            </button>
          </div>
        }
      >
        {(entry) => <TreeNode entry={entry} depth={0} />}
      </For>
    </div>
  );
}

function SearchPane() {
  const [q, setQ] = createSignal("");
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const [busy, setBusy] = createSignal(false);
  let timer: number | undefined;
  let input!: HTMLInputElement;

  createEffect(on(q, (query) => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      if (!query.trim()) return setHits([]);
      setBusy(true);
      try {
        setHits(await ipc.search(query, [...prefs.excludedFolders]));
      } finally {
        setBusy(false);
      }
    }, 180);
  }));

  createEffect(() => sidebarTab() === "search" && setTimeout(() => input?.focus()));

  const grouped = () => {
    const m = new Map<string, SearchHit[]>();
    for (const h of hits()) m.set(h.path, [...(m.get(h.path) ?? []), h]);
    return [...m.entries()];
  };

  const mark = (text: string) => {
    const query = q().trim();
    if (!query) return text;
    const i = text.toLowerCase().indexOf(query.toLowerCase());
    if (i < 0) return text;
    return (
      <>
        {text.slice(0, i)}
        <mark>{text.slice(i, i + query.length)}</mark>
        {text.slice(i + query.length)}
      </>
    );
  };

  return (
    <div class="search-pane">
      <div class="search-box">
        <Search size={15} />
        <input ref={input} dir="auto" placeholder="Search notes… / جستجو" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
      </div>
      <div class="search-meta">
        <Show when={q().trim()}>{busy() ? "Searching…" : `${hits().length} results`}</Show>
      </div>
      <div class="search-results">
        <For each={grouped()}>
          {([path, list]) => (
            <div class="search-group">
              <div class="search-file" onClick={() => openNote(path)}>
                <FileText size={14} /> <span dir="auto">{stem(path)}</span>
                <span class="search-dir">{dirname(path)}</span>
              </div>
              <For each={list.filter((h) => h.line > 0).slice(0, 8)}>
                {(h) => (
                  <div class="search-hit" dir="auto" onClick={() => openNote(path, { line: h.line })}>
                    <span class="ln">{h.line}</span>
                    {mark(h.snippet)}
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

export default function Sidebar() {
  const vaultName = () => root()?.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const panes = () => [
    { id: "files", title: "Files", icon: <Files size={17} /> },
    { id: "search", title: "Search (Ctrl+Shift+F)", icon: <Search size={17} /> },
  ];
  return (
    <aside class="sidebar" style={{ width: `${prefs.sidebarWidth}px` }}>
      <div
        class="resizer end"
        title="Drag to resize · double-click to reset"
        onMouseDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startW = prefs.sidebarWidth;
          const onDrag = (m: MouseEvent) => setPrefs("sidebarWidth", Math.round(Math.max(200, Math.min(520, startW + m.clientX - startX))));
          const stop = () => {
            window.removeEventListener("mousemove", onDrag);
            window.removeEventListener("mouseup", stop);
            document.body.classList.remove("resizing");
          };
          document.body.classList.add("resizing");
          window.addEventListener("mousemove", onDrag);
          window.addEventListener("mouseup", stop);
        }}
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
              <div class="menu-title">Vaults</div>
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
                <span class="menu-label">Open another vault…</span>
              </button>
              <div class="menu-sep" />
              <button class="menu-item" onClick={() => (close(), closeVault())}>
                <span class="menu-icon"><Logo size={15} /></span>
                <span class="menu-label">Back to start screen</span>
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
        <button class="tab-icon" classList={{ active: graphOpen() }} title="Graph view (Ctrl+G)" onClick={() => setGraphOpen(!graphOpen())}>
          <Waypoints size={17} />
        </button>
        <div class="spacer" />
        <Show when={sidebarTab() === "files"}>
          <button class="icon-btn" title="New note (Ctrl+N)" onClick={() => newNoteIn(newNoteDir())}><FilePlus size={16} /></button>
          <button class="icon-btn" title="New folder" onClick={() => newFolderIn("")}><FolderPlus size={16} /></button>
          <button class="icon-btn" title="Collapse all" onClick={() => {
            setExpanded(new Set());
          }}><ChevronsDownUp size={16} /></button>
        </Show>
      </div>

      <div class="sidebar-body">
        <Show when={sidebarTab() === "files"}>
          <FilesPane />
        </Show>
        <Show when={sidebarTab() === "search"}>
          <SearchPane />
        </Show>
      </div>

      <div class="sidebar-foot">
        <button class="icon-btn" title="Settings (Ctrl+,)" onClick={() => setDialog({ kind: "settings" })}>
          <Settings size={17} />
        </button>
        <div class="spacer" />
        <div class="theme-switch" title="Appearance">
          <button classList={{ active: prefs.themeMode === "light" }} onClick={() => setPrefs("themeMode", "light")} title="Light"><Sun size={14} /></button>
          <button classList={{ active: prefs.themeMode === "system" }} onClick={() => setPrefs("themeMode", "system")} title="System"><Monitor size={14} /></button>
          <button classList={{ active: prefs.themeMode === "dark" }} onClick={() => setPrefs("themeMode", "dark")} title="Dark"><Moon size={14} /></button>
        </div>
      </div>
    </aside>
  );
}

app.commands.register({ id: "search.focus", title: "Search in vault", key: "Mod-Shift-f", run: () => setSidebarTab("search") });
