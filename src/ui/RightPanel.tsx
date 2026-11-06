import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { startResize } from "./resize";
import {
  Eye, Palette, ZoomIn, ZoomOut, AlertTriangle, CheckCircle2, Loader2, FileDown,
  FileCode, Pencil,
} from "lucide-solid";
import { app, Panel } from "../core/app";
import {
  state, rightTab, setRightTab, goToLine, activeTheme, setDialog, prefs, setPrefs,
} from "../core/store";
import { preview, exportPdf, showGeneratedTypst, runPreview } from "../core/render";
import { isTypst } from "../editor/format";
import { previewCss } from "./Toolbar";
import { SvgIcon } from "./primitives";

// --------------------------------------------------------------- preview

function PreviewPane() {
  const [zoom, setZoom] = createSignal<number | "fit">(prefs.previewZoom > 0 ? prefs.previewZoom : "fit");
  const [width, setWidth] = createSignal(500);
  let scroller!: HTMLDivElement;

  const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
  createEffect(() => scroller && ro.observe(scroller));
  onCleanup(() => ro.disconnect());

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
            fallback={<><Loader2 size={14} class="spin" /> Rendering…</>}
          >
            <Show when={errors().length} fallback={<><CheckCircle2 size={14} /> {preview().pages.length} pages · {preview().millis} ms</>}>
              <AlertTriangle size={14} /> {errors().length} error{errors().length > 1 ? "s" : ""}
            </Show>
          </Show>
        </span>
        <div class="spacer" />
        <button class="icon-btn" title="Zoom out" onClick={() => step(-0.1)}><ZoomOut size={15} /></button>
        <button class="zoom-label" title="Fit width" onClick={() => setZoom("fit")}>
          {zoom() === "fit" ? "Fit" : `${Math.round((zoom() as number) * 100)}%`}
        </button>
        <button class="icon-btn" title="Zoom in" onClick={() => step(0.1)}><ZoomIn size={15} /></button>
        <button class="icon-btn" title="View generated Typst" onClick={async () => {
          const src = await showGeneratedTypst();
          if (src) setDialog({ kind: "typst", source: src });
        }}><FileCode size={15} /></button>
        <Show when={app.commands.has("pdf.export")}>
          <button class="icon-btn" title="Export PDF" onClick={() => exportPdf()}><FileDown size={15} /></button>
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
                  <Show when={d.line}><b>Line {d.line}: </b></Show>
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
              <Show when={state.active} fallback="Open a note to see its PDF preview">
                <Show when={preview().busy} fallback="Nothing to show yet">
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
  ["body", "Normal text"],
  ["title", "Title"],
  ["subtitle", "Subtitle"],
  ["h1", "Heading 1"],
  ["h2", "Heading 2"],
  ["h3", "Heading 3"],
  ["h4", "Heading 4"],
  ["h5", "Heading 5"],
  ["h6", "Heading 6"],
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
    return [s.font ?? s["font-fa"], s.size, s.weight, s.color, s.numbering && `№ ${s.numbering}`].filter(Boolean).join(" · ");
  };
  return (
    <div class="styles-pane">
      <div class="pane-intro">
        Click a style to modify it — like Word's <b>Modify Style</b>. Changes apply to {isTypst() ? "the theme" : "this note (or its theme)"}.
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
        <button class="btn" onClick={() => setDialog({ kind: "page" })}>Page setup…</button>
        <button class="btn" onClick={() => setDialog({ kind: "themes" })}>Themes…</button>
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

export default function RightPanel() {
  const builtins = [
    { id: "preview", title: "Preview", icon: () => <Eye size={16} /> },
    { id: "styles", title: "Styles", icon: () => <Palette size={16} /> },
  ];
  const plugins = () => app.panels.items();
  return (
    <section class="right-panel" style={prefs.layout === "split" ? { width: `${prefs.previewWidth}px` } : {}}>
      <Show when={prefs.layout === "split"}>
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
        <For each={builtins}>
          {(t) => (
            <button classList={{ active: rightTab() === t.id }} onClick={() => setRightTab(t.id)} title={t.title}>
              {t.icon()} <span>{t.title}</span>
            </button>
          )}
        </For>
        <For each={plugins()}>
          {(p) => (
            <button classList={{ active: rightTab() === p.id }} onClick={() => setRightTab(p.id)} title={p.title}>
              <SvgIcon svg={p.icon} size={16} />
              <Show when={p.label}><span>{p.title}</span></Show>
            </button>
          )}
        </For>
      </div>
      <div class="panel-body">
        <Show when={rightTab() === "preview"}><PreviewPane /></Show>
        <Show when={rightTab() === "styles"}><StylesPane /></Show>
        <For each={plugins()}>{(p) => <Show when={rightTab() === p.id}><PluginPanel panel={p} /></Show>}</For>
      </div>
    </section>
  );
}

