import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { AlertTriangle, CheckCircle2, FileCode, FileDown, Loader2, ZoomIn, ZoomOut } from "lucide-solid";
import { app } from "../core/app";
import { t, tn } from "../core/i18n";
import { exportPdf, preview, showGeneratedTypst } from "../core/render";
import { goToPreviewDiagnostic, prefs, setDialog, state } from "../core/store";
import { exportItems } from "./fileMenu";
import { openMenuAt } from "./primitives";

export function PreviewPane() {
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
  const current = () => preview().path === state.active;
  const pages = () => current() ? preview().pages : [];
  const notes = () => current() ? preview().notes : [];
  const diagnostics = () => current() ? preview().diagnostics : [];
  const errors = () => diagnostics().filter((d) => d.severity === "error");
  const warnings = () => diagnostics().filter((d) => d.severity === "warning");

  createEffect(on(() => state.active, () => { if (scroller) scroller.scrollTop = scroller.scrollLeft = 0; }));

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
            <Show when={errors().length} fallback={<><CheckCircle2 size={14} /> {t("{pages} pages · {ms} ms", { pages: pages().length, ms: preview().millis })}</>}>
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

      <Show when={errors().length || warnings().length || notes().length}>
        <div class="diag-list">
          <For each={notes()}>{(n) => <div class="diag warning"><AlertTriangle size={13} /> {n}</div>}</For>
          <For each={[...errors(), ...warnings()].slice(0, 6)}>
            {(d) => (
              <div class={`diag ${d.severity}`} onClick={() => d.line && goToPreviewDiagnostic(d.line)} classList={{ link: !!d.line }}>
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

      <div class="preview-scroll" ref={scroller} tabIndex={0} aria-label={t("Preview")} classList={{ dim: errors().length > 0 }}>
        <Show
          when={pages().length}
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
          <For each={pages()}>
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
