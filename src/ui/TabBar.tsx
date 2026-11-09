import { noteIcon } from "../core/meta";
import { For, Show } from "solid-js";
import { X, FileText, FileCode2, FileImage, FileType2, Columns2, PanelRight, Square, BookOpen, Code2, Maximize2, Table2 } from "lucide-solid";
import { state, setState, isDirty, closeTab, prefs, setPrefs, setFocusMode } from "../core/store";
import { stem, basename, fileKind, isNotePath } from "../core/ipc";
import { fileMenu, entryFor } from "./fileMenu";
import { openMenu } from "./primitives";
import { NoteMenuButton } from "./NoteMenu";

export default function TabBar() {
  let dragFrom = -1;
  return (
    <div class="tabbar">
      <div class="tabs">
        <For each={state.tabs}>
          {(path, i) => (
            <div
              class="tab"
              classList={{ active: state.active === path, dirty: isDirty(path) }}
              title={path}
              draggable={true}
              onDragStart={() => (dragFrom = i())}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragFrom < 0 || dragFrom === i()) return;
                const tabs = [...state.tabs];
                const [moved] = tabs.splice(dragFrom, 1);
                tabs.splice(i(), 0, moved);
                setState("tabs", tabs);
                dragFrom = -1;
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(path);
                }
              }}
              onClick={() => setState("active", path)}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: "Close", run: () => closeTab(path) },
                  { label: "Close others", run: () => state.tabs.filter((t) => t !== path).forEach(closeTab) },
                  { label: "Close tabs to the right", run: () => state.tabs.slice(state.tabs.indexOf(path) + 1).forEach(closeTab) },
                  { label: "Close all", run: () => [...state.tabs].forEach(closeTab) },
                  "-",
                  ...fileMenu(entryFor(path), "tab"),
                ])
              }
            >
              {noteIcon(path) ? <span class="note-icon">{noteIcon(path)}</span>
                : path.endsWith(".typ") ? <FileCode2 size={14} class="tab-icon-file typ" />
                : fileKind(path) === "image" ? <FileImage size={14} class="tab-icon-file image" />
                : fileKind(path) === "pdf" ? <FileType2 size={14} class="tab-icon-file pdf" />
                : fileKind(path) === "base" ? <Table2 size={14} class="tab-icon-file base" />
                : <FileText size={14} class="tab-icon-file" />}
              <span class="tab-title" dir="auto">{fileKind(path) === "note" ? stem(path) : basename(path)}</span>
              <button
                class="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(path);
                }}
              >
                <Show when={isDirty(path)} fallback={<X size={13} />}>
                  <span class="dot" />
                </Show>
              </button>
            </div>
          )}
        </For>
      </div>
      <Show when={prefs.layout !== "preview" && isNotePath(state.active) && !state.active!.endsWith(".typ")}>
        <div class="layout-switch mode-switch">
          <button classList={{ active: prefs.editorMode === "live" }} title="Live preview (Ctrl+Shift+M)" onClick={() => setPrefs("editorMode", "live")}>
            <BookOpen size={15} />
          </button>
          <button classList={{ active: prefs.editorMode === "source" }} title="Source mode (Ctrl+Shift+M)" onClick={() => setPrefs("editorMode", "source")}>
            <Code2 size={15} />
          </button>
        </div>
      </Show>
      <button class="icon-btn" title="Focus mode — text only (Ctrl+Shift+Enter)" onClick={() => setFocusMode(true)}>
        <Maximize2 size={16} />
      </button>
      <div class="layout-switch">
        <button classList={{ active: prefs.layout === "editor" }} title="Editor only" onClick={() => setPrefs("layout", "editor")}>
          <Square size={15} />
        </button>
        <button classList={{ active: prefs.layout === "split" }} title="Editor + Preview (Ctrl+Shift+E)" onClick={() => setPrefs("layout", "split")}>
          <Columns2 size={15} />
        </button>
        <button classList={{ active: prefs.layout === "preview" }} title="Preview only" onClick={() => setPrefs("layout", "preview")}>
          <PanelRight size={15} />
        </button>
      </div>
      <NoteMenuButton />
    </div>
  );
}
