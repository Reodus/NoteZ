import { noteIcon } from "../core/meta";
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { X, FileText, FileCode2, FileImage, FileType2, Columns2, PanelRight, Square, BookOpen, Code2, Maximize2, Table2 } from "lucide-solid";
import { state, setState, openNote, isDirty, closeTab, prefs, setPrefs, setFocusMode, setWorkspaceLayout, compactWorkspace, compactPanel, setCompactPanel, showRightPanel, rightTab } from "../core/store";
import { stem, basename, fileKind, isNotePath } from "../core/ipc";
import { fileMenu, entryFor } from "./fileMenu";
import { openMenu } from "./primitives";
import { NoteMenuButton } from "./NoteMenu";
import { DragProjection, dragItems, endNativeDrag, nativeDropRect, settleDragItems, startNativeDrag } from "./dragMotion";

import { t, uiRtl } from "../core/i18n";
export default function TabBar() {
  let dragged: string | null = null;
  let strip!: HTMLDivElement;
  const projection = new DragProjection();
  const items = () => dragItems(strip, ".tab", el => el.title);
  const clear = () => { projection.clear(); setDropAt(-1); };
  onCleanup(() => {
    if (dragged) endNativeDrag(items().get(dragged));
    projection.clear();
  });
  // The tab a dragged tab is over: the dropped tab lands on its far side.
  const [dropAt, setDropAt] = createSignal(-1);
  createEffect(on(() => [state.active, prefs.showTabBar], () => {
    if (!prefs.showTabBar) return;
    strip?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }));
  return (
    <div class="tabbar">
      <div class="tabs" hidden={!prefs.showTabBar} role="tablist" ref={strip}
        onDragLeave={(e) => { if (!strip.contains(e.relatedTarget as Node | null)) clear(); }}
        onWheel={(e) => {
          if (e.ctrlKey || e.deltaX || !e.deltaY || strip.scrollWidth <= strip.clientWidth) return;
          e.preventDefault();
          const delta = e.deltaY * (e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 18 : 1);
          strip.scrollBy({ left: uiRtl ? -delta : delta });
        }}>
        <For each={state.tabs}>
          {(path, i) => (
            <div
              class="tab"
              classList={{
                active: state.active === path,
                dirty: isDirty(path),
                "drop-before": dropAt() === i() && dragged !== null && state.tabs.indexOf(dragged) > i(),
                "drop-after": dropAt() === i() && dragged !== null && state.tabs.indexOf(dragged) < i(),
              }}
              role="tab"
              tabindex={state.active === path ? 0 : -1}
              aria-selected={state.active === path}
              title={path}
              draggable={true}
              onDragStart={(e) => {
                dragged = path;
                e.dataTransfer?.setData("text/notez-tab", path);
                startNativeDrag(e, e.currentTarget);
              }}
              onDragEnd={(e) => { endNativeDrag(e.currentTarget); dragged = null; projection.cancel(items()); clear(); }}
              onDragOver={(e) => {
                if (!dragged || !e.dataTransfer?.types.includes("text/notez-tab")) return;
                e.preventDefault();
                if (dropAt() === i()) return;
                const from = state.tabs.indexOf(dragged), to = i();
                setDropAt(to);
                const nodes = items();
                const source = nodes.get(dragged);
                if (!source || from < 0) return clear();
                const sign = getComputedStyle(strip).direction === "rtl" ? -1 : 1;
                const step = (source.offsetWidth + (parseFloat(getComputedStyle(strip).columnGap) || 0)) * sign;
                const offsets = new Map<HTMLElement, { x: number; y: number }>();
                state.tabs.forEach((tab, index) => {
                  const el = nodes.get(tab);
                  if (el && (from < index && index <= to || to <= index && index < from))
                    offsets.set(el, { x: from < to ? -step : step, y: 0 });
                });
                projection.show(offsets, strip.getBoundingClientRect());
              }}
              onDrop={(e) => {
                if (!dragged || !e.dataTransfer?.types.includes("text/notez-tab")) return;
                e.preventDefault();
                const from = state.tabs.indexOf(dragged), to = i();
                const moved = { key: dragged, rect: nativeDropRect(e) };
                const before = projection.capture(items());
                clear();
                endNativeDrag();
                dragged = null;
                if (from < 0 || from === to) return;
                const tabs = [...state.tabs];
                tabs.splice(to, 0, tabs.splice(from, 1)[0]);
                setState("tabs", tabs);
                requestAnimationFrame(() => { if (strip.isConnected) settleDragItems(before, items(), moved); });
              }}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault();
              }}
              onMouseUp={(e) => {
                // Chromium pastes the primary selection on middle-button release.
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                void closeTab(path).catch(() => {});
              }}
              onClick={() => void openNote(path)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void openNote(path);
                  return;
                }
                const step = uiRtl ? -1 : 1;
                const last = state.tabs.length - 1;
                const next = e.key === "Home" ? 0 : e.key === "End" ? last
                  : e.key === "ArrowRight" ? i() + step : e.key === "ArrowLeft" ? i() - step : null;
                if (next === null) return;
                e.preventDefault();
                const destination = state.tabs[Math.max(0, Math.min(last, next))];
                if (destination === path) return;
                items().get(destination)?.focus();
                void openNote(destination, { keepFocus: true });
              }}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: t("Close"), run: () => closeTab(path).catch(() => {}) },
                  { label: t("Close others"), run: () => state.tabs.filter((t) => t !== path).forEach(p => void closeTab(p).catch(() => {})) },
                  { label: t("Close tabs to the right"), run: () => state.tabs.slice(state.tabs.indexOf(path) + 1).forEach(p => void closeTab(p).catch(() => {})) },
                  { label: t("Close all"), run: () => [...state.tabs].forEach(p => void closeTab(p).catch(() => {})) },
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
                tabindex={state.active === path ? 0 : -1}
                title={isDirty(path) ? t("Unsaved changes — close (saves first)") : t("Close")}
                aria-label={t("Close")}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(path).catch(() => {});
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
          <button classList={{ active: prefs.editorMode === "live" }} aria-pressed={prefs.editorMode === "live"} title={t("Live preview (Ctrl+Shift+M)")} onClick={() => setPrefs("editorMode", "live")}>
            <BookOpen size={15} />
          </button>
          <button classList={{ active: prefs.editorMode === "source" }} aria-pressed={prefs.editorMode === "source"} title={t("Source mode (Ctrl+Shift+M)")} onClick={() => setPrefs("editorMode", "source")}>
            <Code2 size={15} />
          </button>
        </div>
      </Show>
      <button class="icon-btn" title={t("Focus mode — text only (Ctrl+Shift+Enter)")} onClick={() => setFocusMode(true)}>
        <Maximize2 size={16} />
      </button>
      <div class="layout-switch">
        <button classList={{ active: prefs.layout === "editor" && compactPanel() !== "right" }} title={t("Editor only")} onClick={() => setWorkspaceLayout("editor")}>
          <Square size={15} />
        </button>
        <Show when={!compactWorkspace()} fallback={
          <button class="workspace-panel-toggle" classList={{ active: compactPanel() === "right" }} aria-expanded={compactPanel() === "right"} aria-controls="workspace-tools" title={t("Toggle tools panel")} onClick={() => {
            if (compactPanel() === "right") setCompactPanel(null);
            else showRightPanel(rightTab());
          }}><Columns2 size={15} /></button>
        }>
          <button class="workspace-panel-toggle" classList={{ active: prefs.layout === "split" }} aria-expanded={prefs.layout === "split"} aria-controls="workspace-tools" title={t("Show tools panel")} onClick={() => {
            setWorkspaceLayout("split");
            showRightPanel(rightTab());
          }}>
            <Columns2 size={15} />
          </button>
        </Show>
        <button classList={{ active: prefs.layout === "preview" }} title={t("Preview only")} onClick={() => setWorkspaceLayout("preview")}>
          <PanelRight size={15} />
        </button>
      </div>
      <NoteMenuButton />
    </div>
  );
}
