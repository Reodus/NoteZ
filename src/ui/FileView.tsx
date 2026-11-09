// Viewer tab for vault files that are not notes: images (zoom, fit, 1:1)
// and PDFs (pdf.js with annotations, src/ui/PdfView.tsx). The header has the same file
// actions as the file tree.
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import { ZoomIn, ZoomOut, Maximize, ExternalLink, FolderOpen, Link2, FileText, Image as ImageIcon } from "lucide-solid";
import { fileSrc, openPath, showInFolder } from "../core/native";
import { notify } from "../core/app";
import { basename, dirname, fileKind } from "../core/ipc";
import { fileRev, root } from "../core/store";
import PdfView from "./PdfView";

import { t } from "../core/i18n";
/** `![[name]]` (Obsidian style); the full path when the name isn't unique is left to the user. */
export const embedLink = (path: string) => `![[${basename(path)}]]`;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function FileView(props: { path: string }) {
  const abs = () => `${root()}/${props.path}`;
  const url = createMemo(() => `${fileSrc(abs())}?v=${fileRev()}`);
  const kind = () => fileKind(props.path);

  // Image state: "fit" scales down to the pane; a number is a zoom factor.
  const [zoom, setZoom] = createSignal<"fit" | number>("fit");
  const [natural, setNatural] = createSignal<{ w: number; h: number } | null>(null);
  const [bytes, setBytes] = createSignal<number | null>(null);
  const [missing, setMissing] = createSignal(false);

  createEffect(on(() => props.path, () => (setZoom("fit"), setNatural(null), setMissing(false))));
  createEffect(on(url, (u) => {
    setBytes(null);
    fetch(u)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("missing"))))
      .then((b) => setBytes(b.size))
      // Images report a missing file through <img onError>; PDFs only here.
      .catch((e) => kind() === "pdf" && e?.message === "missing" && setMissing(true));
  }));

  const [box, setBox] = createSignal({ w: 0, h: 0 });
  const observer = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
  onCleanup(() => observer.disconnect());
  const setStage = (el: HTMLDivElement) => observer.observe(el);
  /** Current scale relative to the image's natural size. */
  const scale = () => {
    const z = zoom();
    if (z !== "fit") return z;
    const n = natural();
    const b = box();
    if (!n || !b.w) return 1;
    return Math.min(1, b.w / n.w, b.h / n.h);
  };
  const zoomBy = (f: number) => setZoom(Math.max(0.05, Math.min(16, scale() * f)));

  const copyLink = () => {
    void navigator.clipboard.writeText(embedLink(props.path));
    notify(t("Copied {x}", { x: embedLink(props.path) }), "success");
  };

  return (
    <div class="file-view">
      <div class="file-view-bar">
        {kind() === "pdf" ? <FileText size={15} /> : <ImageIcon size={15} />}
        <span class="fv-name" dir="auto">{basename(props.path)}</span>
        <span class="fv-dir" dir="auto">{dirname(props.path)}</span>
        <span class="fv-meta">
          <Show when={natural()}>{(n) => `${n().w} × ${n().h} · `}</Show>
          <Show when={bytes() !== null}>{formatBytes(bytes()!)}</Show>
        </span>
        <div class="spacer" />
        <Show when={kind() === "image"}>
          <button class="icon-btn" title={t("Zoom out")} onClick={() => zoomBy(1 / 1.25)}><ZoomOut size={16} /></button>
          <button class="fv-zoom" title={t("Toggle fit / actual size")} onClick={() => setZoom(zoom() === "fit" ? 1 : "fit")}>
            {zoom() === "fit" ? t("Fit") : `${Math.round(scale() * 100)}%`}
          </button>
          <button class="icon-btn" title={t("Zoom in")} onClick={() => zoomBy(1.25)}><ZoomIn size={16} /></button>
          <button class="icon-btn" title={t("Fit to window")} onClick={() => setZoom("fit")}><Maximize size={15} /></button>
          <span class="fv-sep" />
        </Show>
        <button class="icon-btn" title={t("Copy embed link")} onClick={copyLink}><Link2 size={16} /></button>
        <button class="icon-btn" title={t("Show in system file manager")} onClick={() => void showInFolder(abs())}><FolderOpen size={16} /></button>
        <button class="icon-btn" title={t("Open in default app")} onClick={() => void openPath(abs()).catch((e) => notify(String(e), "error"))}><ExternalLink size={16} /></button>
      </div>
      <Show when={!missing()} fallback={<div class="pane-empty">{t("This file no longer exists.")}</div>}>
        <Show
          when={kind() === "image"}
          fallback={<Show when={`${props.path}\n${url()}`} keyed>{(_k: string) => <PdfView path={props.path} url={url()} />}</Show>}
        >
          <div
            ref={setStage}
            class="fv-stage"
            classList={{ fit: zoom() === "fit" }}
            onWheel={(e) => {
              if (!e.ctrlKey) return;
              e.preventDefault();
              zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
            }}
          >
            <img
              src={url()}
              alt={basename(props.path)}
              draggable={false}
              style={natural() ? { width: `${natural()!.w * scale()}px`, height: `${natural()!.h * scale()}px` } : {}}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 300, h: e.currentTarget.naturalHeight || 150 })}
              onError={() => setMissing(true)}
              onDblClick={() => setZoom(zoom() === "fit" ? 1 : "fit")}
            />
          </div>
        </Show>
      </Show>
    </div>
  );
}
