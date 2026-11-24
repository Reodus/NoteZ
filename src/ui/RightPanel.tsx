import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { startResize } from "./resize";
import {
  Eye, Palette, ZoomIn, ZoomOut, AlertTriangle, CheckCircle2, Loader2, FileDown,
  FileCode, Pencil, Plus, Ellipsis, ArrowUp, ArrowDown, X,
} from "lucide-solid";
import { app, Panel } from "../core/app";
import {
  state, rightTab, setRightTab, goToLine, activeTheme, setDialog, prefs, setPrefs, compactWorkspace, showRightPanel, CALENDAR_PANEL,
} from "../core/store";
import { preview, exportPdf, showGeneratedTypst, runPreview } from "../core/render";
import { isTypst } from "../editor/format";
import { previewCss } from "./Toolbar";
import { Modal, SvgIcon, openMenuAt } from "./primitives";
import { exportItems } from "./fileMenu";
import { isNotePath } from "../core/ipc";

import { t, tn } from "../core/i18n";
// --------------------------------------------------------------- preview

function PreviewPane() {
  const [zoom, setZoom] = createSignal<number | "fit">(prefs.previewZoom > 0 ? prefs.previewZoom : "fit");
  const [width, setWidth] = createSignal(500);
  let scroller!: HTMLDivElement;

  let resizeFrame = 0;
  const ro = new ResizeObserver(([e]) => {
    const width = e.contentRect.width;
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; setWidth(width); });
  });
  createEffect(() => scroller && ro.observe(scroller));
  onCleanup(() => { ro.disconnect(); cancelAnimationFrame(resizeFrame); });

  // A4 is 595pt wide; Typst SVGs carry pt-based width. "Fit" fills the
  // pane but never grows past real size (100%), so a wide pane doesn't blow
  // pages up. contentRect already excludes the scroller's padding.
  const A4 = 595 * 1.333;
  const pageWidth = () => (zoom() === "fit" ? Math.min(A4, Math.max(200, width())) : A4 * (zoom() as number));
  const errors = () => preview().diagnostics.filter((d) => d.severity === "error");
  const warnings = () => preview().diagnostics.filter((d) => d.severity === "warning");
  const stale = () => preview().path !== state.active;

  createEffect(on(() => state.active, () => runPreview()));

  const step = (d: number) => {
    const z = zoom() === "fit" ? pageWidth() / A4 : (zoom() as number);
    setZoom(Math.min(3, Math.max(0.3, Math.round((z + d) * 10) / 10)));
  };

  return (
    <div class="preview-pane">
      <div class="preview-bar">
        <span class="preview-status" classList={{ err: errors().length > 0 }}>
          <Show
            when={!preview().busy}
            fallback={<><Loader2 size={14} class="spin" /> {t("Rendering…")}</>}
          >
            <Show when={errors().length} fallback={<><CheckCircle2 size={14} /> {t("{pages} pages · {ms} ms", { pages: preview().pages.length, ms: preview().millis })}</>}>
              <AlertTriangle size={14} /> {tn(errors().length, "{n} error", "{n} errors")}
            </Show>
          </Show>
        </span>
        <div class="spacer" />
        <button class="icon-btn" title={t("Zoom out")} onClick={() => step(-0.1)}><ZoomOut size={15} /></button>
        <button class="zoom-label" title={t("Fit width")} onClick={() => setZoom("fit")}>
          {zoom() === "fit" ? t("Fit") : `${Math.round((zoom() as number) * 100)}%`}
        </button>
        <button class="icon-btn" title={t("Zoom in")} onClick={() => step(0.1)}><ZoomIn size={15} /></button>
        <button class="icon-btn" title={t("View generated Typst")} onClick={async () => {
          const src = await showGeneratedTypst();
          if (src) setDialog({ kind: "typst", source: src });
        }}><FileCode size={15} /></button>
        <Show when={app.commands.has("pdf.export")}>
          <button class="icon-btn" title={t("Export")} onClick={(e) => {
            const p = state.active;
            if (!p) return void exportPdf();
            const r = e.currentTarget.getBoundingClientRect();
            openMenuAt(Math.max(8, r.right - 220), r.bottom + 4, exportItems(p));
          }}><FileDown size={15} /></button>
        </Show>
      </div>

      <Show when={errors().length || warnings().length || preview().notes.length}>
        <div class="diag-list">
          <For each={preview().notes}>{(n) => <div class="diag warning"><AlertTriangle size={13} /> {n}</div>}</For>
          <For each={[...errors(), ...warnings()].slice(0, 6)}>
            {(d) => (
              <div class={`diag ${d.severity}`} onClick={() => d.line && goToLine(d.line)} classList={{ link: !!d.line }}>
                <AlertTriangle size={13} />
                <span>
                  <Show when={d.line}><b>{t("Line {line}:", { line: d.line! })} </b></Show>
                  {d.message}
                  <Show when={d.hints.length}><em> — {d.hints[0]}</em></Show>
                  <Show when={d.file}><small> ({d.file})</small></Show>
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <div class="preview-scroll" ref={scroller} classList={{ dim: stale() || errors().length > 0 }}>
        <Show
          when={preview().pages.length}
          fallback={
            <div class="preview-empty">
              <Show when={state.active} fallback={t("Open a note to see its PDF preview")}>
                <Show when={preview().busy} fallback={t("Nothing to show yet")}>
                  <Loader2 size={22} class="spin" />
                </Show>
              </Show>
            </div>
          }
        >
          <For each={preview().pages}>
            {(svg, i) => (
              <div class="page-wrap">
                <div class="page" style={{ width: `${pageWidth()}px` }}>
                  <PageImage svg={svg} />
                </div>
                <div class="page-num">{i() + 1}</div>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

/** A preview page as an <img>: the browser rasterizes it once and scrolling
 *  only moves pixels (inline SVG pages were re-painted on every frame). */
function PageImage(props: { svg: string }) {
  const url = URL.createObjectURL(new Blob([props.svg], { type: "image/svg+xml" }));
  onCleanup(() => URL.revokeObjectURL(url));
  return <img src={url} decoding="async" draggable={false} alt="" />;
}

// ----------------------------------------------------------------- styles

export const STYLE_LABELS: [string, string][] = [
  ["body", t("Normal text")],
  ["title", "Title"],
  ["subtitle", "Subtitle"],
  ["h1", t("Heading 1")],
  ["h2", t("Heading 2")],
  ["h3", t("Heading 3")],
  ["h4", t("Heading 4")],
  ["h5", t("Heading 5")],
  ["h6", t("Heading 6")],
  ["quote", "Quote"],
  ["code", "Code"],
  ["link", "Link"],
  ["caption", "Caption"],
];

function StylesPane() {
  const theme = activeTheme;
  const bodyPt = () => Number(/^([\d.]+)pt$/.exec(theme()?.styles.body?.size ?? "")?.[1] ?? 11);
  const desc = (k: string) => {
    const s = theme()?.styles[k];
    if (!s) return "Inherits";
    return [s.font ?? Object.values(s.fonts ?? {})[0] ?? s["font-fa"], s.size, s.weight, s.color, s.numbering && `№ ${s.numbering}`].filter(Boolean).join(" · ");
  };
  return (
    <div class="styles-pane">
      <div class="pane-intro">
        {t("Click a style to modify it — like Word's")} <b>{t("Modify Style")}</b>. {isTypst() ? t("Changes apply to the theme.") : t("Changes apply to this note (or its theme).")}
      </div>
      <For each={STYLE_LABELS}>
        {([key, label]) => (
          <button class="style-card" onClick={() => setDialog({ kind: "style", key, scope: isTypst() ? "theme" : "note" })}>
            <span class="style-card-sample" style={previewCss(theme()?.styles[key], bodyPt())} dir="auto">{label}</span>
            <span class="style-card-desc">{desc(key)}</span>
            <Pencil size={14} class="style-card-edit" />
          </button>
        )}
      </For>
      <div class="row gap">
        <button class="btn" onClick={() => setDialog({ kind: "page" })}>{t("Page setup…")}</button>
        <button class="btn" onClick={() => setDialog({ kind: "themes" })}>{t("Themes…")}</button>
      </div>
    </div>
  );
}

function PluginPanel(props: { panel: Panel }) {
  let el!: HTMLDivElement;
  createEffect(() => {
    const cleanup = props.panel.mount(el);
    onCleanup(() => typeof cleanup === "function" && cleanup());
  });
  return <div class="plugin-panel" ref={el} />;
}

export default function RightPanel(props: { fullWidth: boolean; onDismiss: () => void }) {
  const builtins = [
    { id: "preview", title: t("Preview"), label: true, icon: () => <Eye size={16} /> },
    { id: "styles", title: t("Styles"), label: true, icon: () => <Palette size={16} /> },
  ];
  const plugins = () => app.panels.items();
  const tabs = createMemo(() => [...builtins, ...plugins().map((panel) => ({
    id: panel.id, title: panel.title, label: panel.label || panel.id === CALENDAR_PANEL, icon: () => <SvgIcon svg={panel.icon} size={16} />,
  }))]);
  const pinned = createMemo(() => prefs.pinnedPanels.flatMap((id) => tabs().find((tab) => tab.id === id) ?? []));
  const [visibleCount, setVisibleCount] = createSignal(0);
  const [managing, setManaging] = createSignal(false);
  let strip!: HTMLDivElement;
  let measure!: HTMLDivElement;
  const measureTabs = () => {
    const gap = parseFloat(getComputedStyle(strip).columnGap) || 0;
    let width = 0;
    let count = 0;
    for (const tab of measure.children) {
      width += tab.getBoundingClientRect().width + (count ? gap : 0);
      if (width > strip.clientWidth) break;
      count++;
    }
    setVisibleCount(count);
  };
  onMount(() => {
    const observer = new ResizeObserver(measureTabs);
    observer.observe(strip);
    observer.observe(measure);
    measureTabs();
    onCleanup(() => observer.disconnect());
  });
  createEffect(() => {
    if (!tabs().some((tab) => tab.id === rightTab())) setRightTab("preview");
  });
  const shown = createMemo(() => pinned().slice(0, visibleCount()));
  const overflow = createMemo(() => [...pinned().slice(visibleCount()), ...tabs().filter((tab) => !prefs.pinnedPanels.includes(tab.id))]);
  const togglePin = (id: string) => setPrefs("pinnedPanels", (ids) => ids.includes(id) ? ids.filter((p) => p !== id) : [...ids, id]);
  const movePin = (id: string, direction: -1 | 1) => {
    const ordered = pinned();
    const neighbor = ordered[ordered.findIndex((tab) => tab.id === id) + direction];
    if (!neighbor) return;
    setPrefs("pinnedPanels", (ids) => ids.map((p) => p === id ? neighbor.id : p === neighbor.id ? id : p));
  };
  const selectTab = (id: string) => prefs.layout === "preview" ? showRightPanel(id) : setRightTab(id);
  const openOverflow = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenuAt(r.left, r.bottom + 4, overflow().map((tab) => ({
      label: tab.title, icon: rightTab() === tab.id ? "✓" : undefined, run: () => selectTab(tab.id),
    })));
  };
  return (
    <section id="workspace-tools" class="right-panel" classList={{ "full-preview": props.fullWidth }} aria-label={t("Tools panel")} style={{ width: `${prefs.previewWidth}px` }}>
      <Show when={!props.fullWidth && !compactWorkspace()}>
        <div
          class="resizer"
          onPointerDown={(e) =>
            startResize(e, e.currentTarget.parentElement!, -1, (w) =>
              setPrefs("previewWidth", Math.max(320, Math.min(window.innerWidth * 0.7, w))),
            )
          }
          onDblClick={() => setPrefs("previewWidth", 520)}
        />
      </Show>
      <div class="panel-tabs">
        <div class="panel-tab-strip" ref={strip} role="group" aria-label={t("Panel tabs")}>
          <For each={shown()}>{(tab) => (
            <button data-panel-tab={tab.id} classList={{ active: rightTab() === tab.id }} aria-pressed={rightTab() === tab.id}
              onClick={() => selectTab(tab.id)} title={tab.title}>{tab.icon()} <Show when={tab.label}><span>{tab.title}</span></Show></button>
          )}</For>
        </div>
        <div class="panel-tab-measure" ref={measure} aria-hidden="true" inert>
          <For each={pinned()}>{(tab) => <button>{tab.icon()} <Show when={tab.label}><span>{tab.title}</span></Show></button>}</For>
        </div>
        <button class="panel-more icon-btn" title={t("More panels")} aria-haspopup="menu" disabled={!overflow().length}
          classList={{ active: overflow().some((tab) => tab.id === rightTab()) }} onClick={openOverflow}><Ellipsis size={17} /></button>
        <button class="panel-manage icon-btn" title={t("Manage panel tabs")} aria-haspopup="dialog" onClick={() => setManaging(true)}><Plus size={17} /></button>
        <Show when={compactWorkspace() && !props.fullWidth}>
          <button class="icon-btn" title={t("Close tools panel")} onClick={props.onDismiss}><X size={16} /></button>
        </Show>
      </div>
      <div class="panel-body">
        <Show when={rightTab() === "preview"}>
          <Show when={isNotePath(state.active)} fallback={<div class="pane-empty">{t("Open a note to see its PDF preview")}</div>}><PreviewPane /></Show>
        </Show>
        <Show when={rightTab() === "styles"}>
          <Show when={isNotePath(state.active)} fallback={<div class="pane-empty">{t("Open a note to edit its styles")}</div>}><StylesPane /></Show>
        </Show>
        <For each={plugins()}>{(p) => <Show when={rightTab() === p.id}><PluginPanel panel={p} /></Show>}</For>
      </div>
      <Show when={managing()}>
        <Modal title={t("Manage panel tabs")} width="430px" onClose={() => setManaging(false)}>
          <div class="panel-manager">
            <For each={[...pinned(), ...tabs().filter((tab) => !prefs.pinnedPanels.includes(tab.id))]}>{(tab) => {
              const index = () => pinned().findIndex((item) => item.id === tab.id);
              return (
                <div class="panel-manager-row">
                  <label>
                    <input type="checkbox" data-panel-pin={tab.id} checked={index() >= 0} onChange={() => togglePin(tab.id)} />
                    {tab.icon()} <span>{tab.title}</span>
                  </label>
                  <Show when={index() >= 0}>
                    <button class="icon-btn" title={t("Move {name} up", { name: tab.title })} disabled={index() === 0} onClick={() => movePin(tab.id, -1)}><ArrowUp size={15} /></button>
                    <button class="icon-btn" title={t("Move {name} down", { name: tab.title })} disabled={index() === pinned().length - 1} onClick={() => movePin(tab.id, 1)}><ArrowDown size={15} /></button>
                  </Show>
                </div>
              );
            }}</For>
          </div>
        </Modal>
      </Show>
    </section>
  );
}

