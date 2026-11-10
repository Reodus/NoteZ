import { noteIcon } from "../core/meta";
import { createSignal, For, Show } from "solid-js";
import { X, FileText, FileCode2, FileImage, FileType2, Columns2, PanelRight, Square, BookOpen, Code2, Maximize2, Table2 } from "lucide-solid";
import { state, setState, isDirty, closeTab, prefs, setPrefs, setFocusMode } from "../core/store";
import { stem, basename, fileKind, isNotePath } from "../core/ipc";
import { fileMenu, entryFor } from "./fileMenu";
import { openMenu } from "./primitives";
import { NoteMenuButton } from "./NoteMenu";

import { t } from "../core/i18n";
export default function TabBar() {
  let dragFrom = -1;
  // The tab a dragged tab is over: the dropped tab lands on its far side.
  const [dropAt, setDropAt] = createSignal(-1);
  return (
    <div class="tabbar">
      <div class="tabs" role="tablist">
        <For each={state.tabs}>
          {(path, i) => (
            <div
              class="tab"
              classList={{
                active: state.active === path,
                dirty: isDirty(path),
                "drop-before": dropAt() === i() && dragFrom > i(),
                "drop-after": dropAt() === i() && dragFrom >= 0 && dragFrom < i(),
              }}
              role="tab"
              aria-selected={state.active === path}
              title={path}
              draggable={true}
              onDragStart={(e) => {
                dragFrom = i();
                e.dataTransfer?.setData("text/notez-tab", path);
              }}
              onDragEnd={() => ((dragFrom = -1), setDropAt(-1))}
              onDragOver={(e) => {
                if (dragFrom < 0) return;
                e.preventDefault();
                setDropAt(i());
              }}
              onDrop={() => {
                setDropAt(-1);
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
                  { label: t("Close"), run: () => closeTab(path) },
                  { label: t("Close others"), run: () => state.tabs.filter((t) => t !== path).forEach(closeTab) },
                  { label: t("Close tabs to the right"), run: () => state.tabs.slice(state.tabs.indexOf(path) + 1).forEach(closeTab) },
                  { label: t("Close all"), run: () => [...state.tabs].forEach(closeTab) },
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
                title={isDirty(path) ? t("Unsaved changes — close (saves first)") : t("Close")}
                aria-label={t("Close")}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(path);
                }}
              >
                {/* Dirty tabs show a dot; hovering the button turns it back into ×. */}
                <Show when={isDirty(path)}>
                  <span class="dot" />
                </Show>
                <X size={13} class="tab-x" />
              </button>
            </div>
          )}
        </For>
      </div>
      <Show when={prefs.layout !== "preview" && isNotePath(state.active) && !state.active!.endsWith(".typ")}>
        <div class="layout-switch mode-switch">
          <button classList={{ active: prefs.editorMode === "live" }} title={t("Live preview (Ctrl+Shift+M)")} onClick={() => setPrefs("editorMode", "live")}>
            <BookOpen size={15} />
          </button>
          <button classList={{ active: prefs.editorMode === "source" }} title={t("Source mode (Ctrl+Shift+M)")} onClick={() => setPrefs("editorMode", "source")}>
            <Code2 size={15} />
          </button>
        </div>
      </Show>
      <button class="icon-btn" title={t("Focus mode — text only (Ctrl+Shift+Enter)")} onClick={() => setFocusMode(true)}>
        <Maximize2 size={16} />
      </button>
      <div class="layout-switch">
        <button classList={{ active: prefs.layout === "editor" }} title={t("Editor only")} onClick={() => setPrefs("layout", "editor")}>
          <Square size={15} />
        </button>
        <button classList={{ active: prefs.layout === "split" }} title={t("Editor + Preview (Ctrl+Shift+E)")} onClick={() => setPrefs("layout", "split")}>
          <Columns2 size={15} />
        </button>
        <button classList={{ active: prefs.layout === "preview" }} title={t("Preview only")} onClick={() => setPrefs("layout", "preview")}>
          <PanelRight size={15} />
        </button>
      </div>
      <NoteMenuButton />
    </div>
  );
}
