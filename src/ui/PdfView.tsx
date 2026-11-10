// PDF viewer (pdf.js) with annotations: highlights, notes and area
// selections, kept in .notez/annotations/<pdf path>.json. A link to an
// annotation is [[paper.pdf#page=3&annotation=id]]; opening it scrolls here.
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  Highlighter, MousePointer2, StickyNote, Square, PanelRight, Search, ZoomIn, ZoomOut, ChevronUp, ChevronDown, Link2, Quote, Trash2, Image as ImageIcon, X,
} from "lucide-solid";
import { ipc, basename, stem } from "../core/ipc";
import { app, notify } from "../core/app";
import { allFiles, openNote, pdfJump, prefs } from "../core/store";

import { t } from "../core/i18n";
import { modalOpen } from "./primitives";
// ------------------------------------------------------------------ model

export type AnnKind = "highlight" | "note" | "area";
/** Rects are fractions of the page (0–1, origin top-left), so zoom doesn't matter. */
export interface Annotation {
  id: string;
  page: number;
  kind: AnnKind;
  color: string;
  rects: [number, number, number, number][];
  /** The highlighted text. */
  text?: string;
  comment?: string;
  created: number;
  modified: number;
}

const COLORS = [
  ["yellow", "#ffd400"],
  ["red", "#ff6666"],
  ["green", "#5fb236"],
  ["blue", "#2ea8e5"],
  ["purple", "#a28ae5"],
] as const;
const colorOf = (c: string) => COLORS.find(([n]) => n === c)?.[1] ?? c;

const store = (path: string) => `.notez/annotations/${path}.json`;
const newId = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

async function loadAnnotations(path: string): Promise<Annotation[]> {
  try {
    const j = JSON.parse(await ipc.read(store(path)));
    return Array.isArray(j?.annotations) ? j.annotations : [];
  } catch {
    return [];
  }
}

/** The link text for this PDF: its file name, or the path when the name isn't unique. */
function linkName(path: string): string {
  const name = basename(path);
  return allFiles().filter((p) => basename(p).toLowerCase() === name.toLowerCase()).length > 1 ? path : name;
}
export const annotationLink = (path: string, a: Annotation, label?: string) =>
  `[[${linkName(path)}#page=${a.page}&annotation=${a.id}${label ? `|${label}` : ""}]]`;

// ------------------------------------------------------------------ pdf.js

type Viewer = any;
let pdfjsPromise: Promise<{ pdfjs: any; ui: any }> | null = null;
function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    const pdfjs = await import("pdfjs-dist");
    const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = worker;
    // pdf_viewer.mjs reads the library from this global
    (globalThis as any).pdfjsLib = pdfjs;
    await import("pdfjs-dist/web/pdf_viewer.css");
    const ui = await import("pdfjs-dist/web/pdf_viewer.mjs");
    return { pdfjs, ui };
  })();
  return pdfjsPromise;
}

// ------------------------------------------------------------------ view

export default function PdfView(props: { path: string; url: string }) {
  let container!: HTMLDivElement;
  let viewerEl!: HTMLDivElement;
  let viewer: Viewer = null;
  let eventBus: any = null;
  let doc: any = null;
  let resizer: ResizeObserver | undefined;

  const [anns, setAnns] = createSignal<Annotation[]>([]);
  const [tool, setTool] = createSignal<"select" | AnnKind>("select");
  const [color, setColor] = createSignal("yellow");
  const [page, setPage] = createSignal(1);
  const [pages, setPages] = createSignal(0);
  const [scale, setScale] = createSignal(1);
  const [panel, setPanel] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [selected, setSelected] = createSignal<string | null>(null);
  /** The floating box: for a text selection (create) or an annotation (edit). */
  const [pop, setPop] = createSignal<{ x: number; y: number; ann?: string; sel?: { page: number; rects: Annotation["rects"]; text: string } } | null>(null);
  const [finding, setFinding] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [findInfo, setFindInfo] = createSignal("");

  // ------------------------------------------------------- persistence
  let loadedFor = "";
  let saveTimer: number | undefined;
  const save = () => {
    clearTimeout(saveTimer);
    const path = props.path;
    const list = anns();
    saveTimer = window.setTimeout(() => {
      void ipc.write(store(path), JSON.stringify({ version: 1, pdf: path, annotations: list }, null, 1)).catch((e) => notify(t("Annotations not saved: {error}", { error: e }), "error"));
    }, 300);
  };
  const update = (f: (l: Annotation[]) => Annotation[]) => {
    setAnns(f(anns()));
    save();
    for (const p of new Set(anns().map((a) => a.page))) drawLayer(p);
  };
  const patch = (id: string, p: Partial<Annotation>) => update((l) => l.map((a) => (a.id === id ? { ...a, ...p, modified: Date.now() } : a)));
  const remove = (id: string) => {
    const a = anns().find((x) => x.id === id);
    update((l) => l.filter((x) => x.id !== id));
    setPop(null);
    if (a) drawLayer(a.page);
  };

  // Notes linking to this PDF (backlinks per annotation / page).
  const [tick, setTick] = createSignal(0);
  const offVault = app.events.on("vault:changed", () => setTick((t) => t + 1));
  onCleanup(offVault);
  const [links] = createResource(() => [props.path, tick()] as const, ([p]) => ipc.pdfLinks(p, [...prefs.excludedFolders]).catch(() => []));
  const linksOf = (id: string) => (links() ?? []).filter((l) => l.annotation === id);

  // ------------------------------------------------------- annotation layer

  const pageDiv = (n: number) => viewerEl?.querySelector<HTMLElement>(`.page[data-page-number="${n}"]`) ?? null;

  /** (Re)draw page `n`'s annotations into its layer. */
  function drawLayer(n: number) {
    const div = pageDiv(n);
    if (!div) return;
    let layer = div.querySelector<HTMLElement>(":scope > .nz-annot-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "nz-annot-layer";
      div.append(layer);
    }
    layer.replaceChildren();
    for (const a of anns().filter((x) => x.page === n)) {
      const c = colorOf(a.color);
      if (a.kind === "note") {
        const [x, y] = a.rects[0];
        const pin = document.createElement("div");
        pin.className = "nz-annot-note";
        pin.dataset.id = a.id;
        pin.style.left = `${x * 100}%`;
        pin.style.top = `${y * 100}%`;
        pin.style.setProperty("--c", c);
        pin.title = a.comment || "Note";
        pin.classList.toggle("selected", selected() === a.id);
        layer.append(pin);
        continue;
      }
      for (const [x0, y0, x1, y1] of a.rects) {
        const r = document.createElement("div");
        r.className = a.kind === "area" ? "nz-annot-area" : "nz-annot-hl";
        r.dataset.id = a.id;
        Object.assign(r.style, { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` });
        r.style.setProperty("--c", c);
        r.classList.toggle("selected", selected() === a.id);
        layer.append(r);
      }
      if (a.comment && a.kind !== "area") {
        const [x0, y0] = a.rects[0];
        const dot = document.createElement("div");
        dot.className = "nz-annot-dot";
        dot.dataset.id = a.id;
        dot.style.left = `${x0 * 100}%`;
        dot.style.top = `${y0 * 100}%`;
        dot.style.setProperty("--c", c);
        dot.title = a.comment;
        layer.append(dot);
      }
    }
  }
  createEffect(on(selected, () => anns().forEach((a) => drawLayer(a.page)), { defer: true }));

  /** Client point → (page, fraction x, fraction y). */
  function pointIn(e: { clientX: number; clientY: number }) {
    const div = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>(".page");
    if (!div) return null;
    const r = div.getBoundingClientRect();
    return { page: Number(div.dataset.pageNumber), x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, div };
  }

  /** The annotation at a client point (topmost: notes, then areas, then highlights). */
  function hit(e: { clientX: number; clientY: number }): Annotation | null {
    const p = pointIn(e);
    if (!p) return null;
    const on = anns().filter((a) => a.page === p.page);
    const div = p.div.getBoundingClientRect();
    const near = (x: number, y: number) => Math.abs((x - p.x) * div.width) < 12 && Math.abs((y - p.y) * div.height) < 14;
    return (
      on.find((a) => a.kind === "note" && near(a.rects[0][0], a.rects[0][1])) ??
      on.find((a) => a.comment && a.kind === "highlight" && near(a.rects[0][0], a.rects[0][1])) ??
      on.find((a) => a.kind !== "note" && a.rects.some(([x0, y0, x1, y1]) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1)) ??
      null
    );
  }

  /** The current text selection as page rects (merged per line). */
  function selectionRects() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const start = (range.startContainer.parentElement ?? (range.startContainer as HTMLElement))?.closest?.(".page") as HTMLElement | null;
    if (!start || !viewerEl.contains(start)) return null;
    const pr = start.getBoundingClientRect();
    const raw = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1 && r.top >= pr.top - 2 && r.bottom <= pr.bottom + 2);
    if (!raw.length) return null;
    // merge rects on the same line
    const lines: DOMRect[][] = [];
    for (const r of raw.sort((a, b) => a.top - b.top || a.left - b.left)) {
      const l = lines.find((g) => Math.abs(g[0].top - r.top) < r.height * 0.5 && Math.abs(g[0].height - r.height) < r.height * 0.6);
      if (l) l.push(r);
      else lines.push([r]);
    }
    const rects = lines.map((g) => {
      const x0 = Math.min(...g.map((r) => r.left)), x1 = Math.max(...g.map((r) => r.right));
      const y0 = Math.min(...g.map((r) => r.top)), y1 = Math.max(...g.map((r) => r.bottom));
      return [(x0 - pr.left) / pr.width, (y0 - pr.top) / pr.height, (x1 - pr.left) / pr.width, (y1 - pr.top) / pr.height] as [number, number, number, number];
    });
    const text = sel.toString().replace(/\s+/g, " ").trim();
    const last = raw[raw.length - 1];
    return { page: Number(start.dataset.pageNumber), rects, text, x: last.right, y: last.bottom };
  }

  const addHighlight = (s: { page: number; rects: Annotation["rects"]; text: string }, c = color()) => {
    const a: Annotation = { id: newId(), page: s.page, kind: "highlight", color: c, rects: s.rects, text: s.text, created: Date.now(), modified: Date.now() };
    update((l) => [...l, a]);
    window.getSelection()?.removeAllRanges();
    return a;
  };

  // ------------------------------------------------------- mouse
  let down: { x: number; y: number; p: ReturnType<typeof pointIn> } | null = null;
  let box: HTMLDivElement | null = null;

  const onDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".nz-pdf-pop")) return;
    setPop(null);
    const p = pointIn(e);
    down = { x: e.clientX, y: e.clientY, p };
    if (tool() === "area" && p) {
      e.preventDefault();
      box = document.createElement("div");
      box.className = "nz-annot-drawing";
      p.div.append(box);
    }
  };
  const onMove = (e: MouseEvent) => {
    if (!down?.p || !box) return;
    const r = down.p.div.getBoundingClientRect();
    const x0 = Math.min(down.x, e.clientX) - r.left, y0 = Math.min(down.y, e.clientY) - r.top;
    Object.assign(box.style, { left: `${x0}px`, top: `${y0}px`, width: `${Math.abs(e.clientX - down.x)}px`, height: `${Math.abs(e.clientY - down.y)}px` });
  };
  const onUp = (e: MouseEvent) => {
    if (e.button !== 0 || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
    const start = down;
    down = null;
    if (box) {
      box.remove();
      box = null;
      if (!moved || !start.p) return;
      const r = start.p.div.getBoundingClientRect();
      const fx = (x: number) => Math.min(1, Math.max(0, (x - r.left) / r.width));
      const fy = (y: number) => Math.min(1, Math.max(0, (y - r.top) / r.height));
      const a: Annotation = {
        id: newId(), page: start.p.page, kind: "area", color: color(),
        rects: [[fx(Math.min(start.x, e.clientX)), fy(Math.min(start.y, e.clientY)), fx(Math.max(start.x, e.clientX)), fy(Math.max(start.y, e.clientY))]],
        created: Date.now(), modified: Date.now(),
      };
      update((l) => [...l, a]);
      setSelected(a.id);
      setPop({ x: e.clientX, y: e.clientY, ann: a.id });
      return;
    }
    if (tool() === "note" && !moved && start.p) {
      const a: Annotation = { id: newId(), page: start.p.page, kind: "note", color: color(), rects: [[start.p.x, start.p.y, start.p.x, start.p.y]], comment: "", created: Date.now(), modified: Date.now() };
      update((l) => [...l, a]);
      setSelected(a.id);
      setPop({ x: e.clientX, y: e.clientY, ann: a.id });
      return;
    }
    // text selected: highlight right away (highlight tool) or offer to
    setTimeout(() => {
      const s = selectionRects();
      if (s && s.text) {
        if (tool() === "highlight") {
          const a = addHighlight(s);
          setSelected(a.id);
        } else setPop({ x: s.x, y: s.y, sel: s });
        return;
      }
      if (!moved) {
        const a = hit(e);
        setSelected(a?.id ?? null);
        if (a) setPop({ x: e.clientX, y: e.clientY, ann: a.id });
      }
    });
  };

  // ------------------------------------------------------- navigation

  const goTo = (n: number, y?: number) => {
    if (!viewer || !n) return;
    const p = Math.max(1, Math.min(pages(), n));
    if (y === undefined) viewer.currentPageNumber = p;
    else {
      const view = viewer.getPageView(p - 1);
      const h = view?.viewport ? view.viewport.height / view.viewport.scale : 800;
      // destArray: PDF user space has its origin at the bottom
      viewer.scrollPageIntoView({ pageNumber: p, destArray: [null, { name: "XYZ" }, null, h * (1 - y) + 30, null] });
    }
  };
  const reveal = (a: Annotation) => {
    goTo(a.page, Math.max(0, a.rects[0][1] - 0.05));
    setSelected(a.id);
    setTimeout(() => {
      viewerEl.querySelectorAll<HTMLElement>(`[data-id="${a.id}"]`).forEach((el) => {
        el.classList.remove("flash");
        void el.offsetWidth;
        el.classList.add("flash");
      });
    }, 250);
  };
  const applyJump = () => {
    const j = pdfJump();
    if (!j || j.path !== props.path || !viewer || !pages()) return;
    const a = j.annotation ? anns().find((x) => x.id === j.annotation) : undefined;
    if (a) reveal(a);
    else if (j.page) goTo(j.page);
  };
  createEffect(on(pdfJump, applyJump, { defer: true }));

  const zoom = (f: number | "page-width" | "page-fit") => {
    if (!viewer) return;
    if (typeof f === "string") viewer.currentScaleValue = f;
    else viewer.currentScale = Math.max(0.25, Math.min(5, viewer.currentScale * f));
  };

  const find = (again = false, back = false) => {
    if (!eventBus) return;
    eventBus.dispatch("find", { source: null, type: again ? "again" : "", query: query(), caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: back, matchDiacritics: false });
  };

  // ------------------------------------------------------- load

  onMount(async () => {
    try {
      const { pdfjs, ui } = await loadPdfjs();
      eventBus = new ui.EventBus();
      const linkService = new ui.PDFLinkService({ eventBus, externalLinkTarget: ui.LinkTarget.BLANK });
      const findController = new ui.PDFFindController({ eventBus, linkService });
      viewer = new ui.PDFViewer({ container, viewer: viewerEl, eventBus, linkService, findController, textLayerMode: 1, removePageBorders: false });
      linkService.setViewer(viewer);
      // Keep "fit width" fitting when the pane resizes (panel, sidebar, window).
      let fit = true;
      resizer = new ResizeObserver(() => {
        if (fit && pages()) viewer.currentScaleValue = "page-width";
      });
      resizer.observe(container);
      eventBus.on("scalechanging", (e: any) => (fit = e.presetValue === "page-width"));
      eventBus.on("pagesinit", () => {
        viewer.currentScaleValue = "page-width";
        setPages(doc.numPages);
        const last = Number(localStorage.getItem(`nz-pdf-page:${props.path}`) || 0);
        const j = pdfJump();
        if (j && j.path === props.path) applyJump();
        else if (last > 1) goTo(last);
      });
      eventBus.on("pagerendered", (e: any) => drawLayer(e.pageNumber));
      eventBus.on("pagechanging", (e: any) => {
        setPage(e.pageNumber);
        try {
          localStorage.setItem(`nz-pdf-page:${props.path}`, String(e.pageNumber));
        } catch {
          /* private mode */
        }
      });
      eventBus.on("scalechanging", (e: any) => setScale(e.scale));
      eventBus.on("updatefindmatchescount", (e: any) => setFindInfo(e.matchesCount?.total ? `${e.matchesCount.current} / ${e.matchesCount.total}` : ""));
      eventBus.on("updatefindcontrolstate", (e: any) => {
        if (e.state === 1) setFindInfo("not found");
        else if (e.matchesCount?.total) setFindInfo(`${e.matchesCount.current} / ${e.matchesCount.total}`);
      });
      setAnns(await loadAnnotations(props.path));
      loadedFor = props.path;
      doc = await pdfjs.getDocument({ url: props.url, cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/", isEvalSupported: false }).promise;
      viewer.setDocument(doc);
      linkService.setDocument(doc, null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  });
  onCleanup(() => {
    resizer?.disconnect();
    clearTimeout(saveTimer);
    if (loadedFor) void ipc.write(store(loadedFor), JSON.stringify({ version: 1, pdf: loadedFor, annotations: anns() }, null, 1)).catch(() => {});
    try {
      viewer?.setDocument(null);
      void doc?.destroy();
    } catch {
      /* already gone */
    }
  });

  // keyboard: Ctrl+F find, Delete removes the selected annotation, tools by letter
  const onKey = (e: KeyboardEvent) => {
    if (!container?.isConnected || container.offsetParent === null) return;
    // A dialog or menu over the PDF has the keyboard (and Esc closes it, not the tool).
    if (e.defaultPrevented || modalOpen()) return;
    const typing = (e.target as HTMLElement)?.closest?.("input, textarea, [contenteditable]");
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      setFinding(true);
      setTimeout(() => document.querySelector<HTMLInputElement>(".nz-pdf-find input")?.select());
      return;
    }
    if (typing) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selected()) {
      e.preventDefault();
      remove(selected()!);
    } else if (e.key === "Escape") {
      setPop(null);
      setSelected(null);
      setTool("select");
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = ({ v: "select", h: "highlight", n: "note", a: "area" } as const)[e.key as "v"];
      if (t) setTool(t);
    }
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  // ------------------------------------------------------- actions

  const copy = (text: string, what: string) => {
    void navigator.clipboard.writeText(text);
    notify(t("Copied {what}", { what }), "success");
  };
  const copyLink = (a: Annotation) => copy(annotationLink(props.path, a), "the link");
  const copyQuote = (a: Annotation) => {
    const body = (a.text || a.comment || "").trim();
    const quote = body ? body.split("\n").map((l) => `> ${l}`).join("\n") + "\n" : "";
    copy(`${quote}> — ${annotationLink(props.path, a, `${basename(props.path).replace(/\.pdf$/i, "")}, p. ${a.page}`)}${a.comment && a.text ? `\n\n${a.comment}` : ""}`, "the quote");
  };
  /** An area as a PNG on the clipboard (from the rendered page). */
  const copyImage = async (a: Annotation) => {
    const canvas = pageDiv(a.page)?.querySelector("canvas");
    if (!canvas) return notify(t("Scroll to the page first."), "error");
    const [x0, y0, x1, y1] = a.rects[0];
    const w = Math.max(1, Math.round((x1 - x0) * canvas.width)), h = Math.max(1, Math.round((y1 - y0) * canvas.height));
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d")!.drawImage(canvas, Math.round(x0 * canvas.width), Math.round(y0 * canvas.height), w, h, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
    if (!blob) return;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    notify(t("Copied the area as an image — paste it into a note."), "success");
  };

  const sorted = createMemo(() => [...anns()].sort((a, b) => a.page - b.page || a.rects[0][1] - b.rects[0][1] || a.rects[0][0] - b.rects[0][0]));
  const popAnn = () => {
    const p = pop();
    return p?.ann ? anns().find((a) => a.id === p.ann) : undefined;
  };

  const Tool = (p: { t: "select" | AnnKind; title: string; children: any }) => (
    <button class="icon-btn" classList={{ active: tool() === p.t }} title={p.title} onClick={() => setTool(p.t)}>{p.children}</button>
  );
  const Swatches = (p: { value: string; onPick: (c: string) => void }) => (
    <span class="nz-swatches">
      <For each={COLORS}>{([n, c]) => <button classList={{ on: p.value === n }} style={{ background: c }} title={n} onClick={() => p.onPick(n)} />}</For>
    </span>
  );

  return (
    <div class="nz-pdf">
      <div class="nz-pdf-bar">
        <Tool t="select" title={t("Select text (V)")}><MousePointer2 size={15} /></Tool>
        <Tool t="highlight" title={t("Highlight text (H)")}><Highlighter size={15} /></Tool>
        <Tool t="note" title={t("Add a note (N)")}><StickyNote size={15} /></Tool>
        <Tool t="area" title={t("Select an area (A)")}><Square size={15} /></Tool>
        <Swatches value={color()} onPick={setColor} />
        <span class="fv-sep" />
        <span class="nz-pdf-page">
          <input class="input" value={page()} onChange={(e) => goTo(Number(e.currentTarget.value))} /> / {pages() || "…"}
        </span>
        <span class="fv-sep" />
        <button class="icon-btn" title={t("Zoom out")} onClick={() => zoom(1 / 1.15)}><ZoomOut size={15} /></button>
        <button class="fv-zoom" title={t("Fit width")} onClick={() => zoom("page-width")}>{Math.round(scale() * 100)}%</button>
        <button class="icon-btn" title={t("Zoom in")} onClick={() => zoom(1.15)}><ZoomIn size={15} /></button>
        <span class="spacer" />
        <button class="icon-btn" classList={{ active: finding() }} title={t("Find (Ctrl+F)")} onClick={() => setFinding(!finding())}><Search size={15} /></button>
        <button class="icon-btn" classList={{ active: panel() }} title={t("Annotations")} onClick={() => setPanel(!panel())}><PanelRight size={15} /></button>
      </div>
      <Show when={finding()}>
        <div class="nz-pdf-find">
          <input class="input" placeholder={t("Find in PDF")} value={query()} dir="auto"
            onInput={(e) => (setQuery(e.currentTarget.value), find())}
            onKeyDown={(e) => {
              if (e.key === "Enter") find(true, e.shiftKey);
              if (e.key === "Escape") setFinding(false);
            }} />
          <span class="field-hint">{findInfo()}</span>
          <button class="icon-btn" title={t("Previous (Shift+Enter)")} onClick={() => find(true, true)}><ChevronUp size={15} /></button>
          <button class="icon-btn" title={t("Next (Enter)")} onClick={() => find(true)}><ChevronDown size={15} /></button>
          <button class="icon-btn" title={t("Close")} onClick={() => setFinding(false)}><X size={15} /></button>
        </div>
      </Show>
      <div class="nz-pdf-main">
        <div class="nz-pdf-stage">
          <div ref={container} class={`nz-pdf-scroll tool-${tool()}`} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp}
            onWheel={(e) => {
              if (!e.ctrlKey) return;
              e.preventDefault();
              zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
            }}>
            <div ref={viewerEl} class="pdfViewer" />
          </div>
          <Show when={error()}>
            <div class="pane-empty">{t("This PDF can't be shown: {error}", { error: error() })}</div>
          </Show>
        </div>
        <Show when={panel()}>
          <aside class="nz-pdf-panel">
            <div class="nz-pdf-panel-head">{t("Annotations")} <span class="base-count">{anns().length}</span></div>
            <Show when={anns().length} fallback={
              <p class="field-hint">{t("Select text and pick a colour to highlight it.")} <b>N</b> {t("adds a note,")} <b>A</b> {t("selects an area. Each annotation has a link you can paste into notes.")}</p>
            }>
              <For each={sorted()}>
                {(a) => (
                  <div class="nz-ann" classList={{ selected: selected() === a.id }} style={{ "--c": colorOf(a.color) }} onClick={() => reveal(a)}>
                    <div class="nz-ann-head">
                      <span class="nz-ann-kind">{a.kind === "note" ? <StickyNote size={12} /> : a.kind === "area" ? <Square size={12} /> : <Highlighter size={12} />} p. {a.page}</span>
                      <span class="grow" />
                      <button class="icon-btn tiny" title={t("Copy link")} onClick={(e) => (e.stopPropagation(), copyLink(a))}><Link2 size={13} /></button>
                      <button class="icon-btn tiny" title={t("Copy as quote")} onClick={(e) => (e.stopPropagation(), copyQuote(a))}><Quote size={13} /></button>
                    </div>
                    <Show when={a.text}><div class="nz-ann-text" dir="auto">{a.text}</div></Show>
                    <Show when={a.comment}><div class="nz-ann-comment" dir="auto">{a.comment}</div></Show>
                    <Show when={linksOf(a.id).length}>
                      <div class="nz-ann-links">
                        <For each={linksOf(a.id)}>
                          {(l) => <a class="base-link" title={l.text} onClick={(e) => (e.stopPropagation(), void openNote(l.note, { line: l.line }))}>↩ {stem(l.note)}</a>}
                        </For>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
            <Show when={(links() ?? []).some((l) => !l.annotation)}>
              <div class="nz-pdf-panel-head">{t("Linked from")}</div>
              <For each={(links() ?? []).filter((l) => !l.annotation)}>
                {(l) => (
                  <a class="nz-ann-backlink base-link" title={l.text} onClick={() => void openNote(l.note, { line: l.line })}>
                    {stem(l.note)}{l.page ? ` · p. ${l.page}` : ""}
                  </a>
                )}
              </For>
            </Show>
          </aside>
        </Show>
      </div>

      <Show when={pop()}>
        {(p) => (
          <Portal>
            <div class="nz-pdf-pop" style={{ left: `${Math.min(p().x, window.innerWidth - 300)}px`, top: `${Math.min(p().y + 8, window.innerHeight - 220)}px` }}
              onMouseDown={(e) => e.stopPropagation()}>
              <Show when={p().sel}>
                {(s) => (
                  <div class="row gap">
                    <Swatches value="" onPick={(c) => {
                      setColor(c);
                      const a = addHighlight(s(), c);
                      setSelected(a.id);
                      setPop(null);
                    }} />
                    <button class="btn small" onClick={() => {
                      const a = addHighlight(s());
                      setSelected(a.id);
                      setPop({ ...p(), sel: undefined, ann: a.id });
                    }}>{t("Highlight + comment")}</button>
                    <button class="btn small" onClick={() => (copy(s().text, "the text"), setPop(null))}>{t("Copy")}</button>
                  </div>
                )}
              </Show>
              <Show when={popAnn()}>
                {(a) => (
                  <>
                    <div class="row gap">
                      <Swatches value={a().color} onPick={(c) => patch(a().id, { color: c })} />
                      <span class="grow" />
                      <button class="icon-btn" title={t("Copy link")} onClick={() => copyLink(a())}><Link2 size={14} /></button>
                      <button class="icon-btn" title={t("Copy as quote")} onClick={() => copyQuote(a())}><Quote size={14} /></button>
                      <Show when={a().kind === "area"}>
                        <button class="icon-btn" title={t("Copy as image")} onClick={() => void copyImage(a())}><ImageIcon size={14} /></button>
                      </Show>
                      <button class="icon-btn danger" title={t("Delete (Del)")} onClick={() => remove(a().id)}><Trash2 size={14} /></button>
                    </div>
                    <textarea class="input" rows={3} placeholder={t("Comment…")} dir="auto" value={a().comment ?? ""}
                      ref={(el) => a().kind === "note" && !a().comment && setTimeout(() => el.focus())}
                      onInput={(e) => patch(a().id, { comment: e.currentTarget.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) setPop(null);
                      }} />
                  </>
                )}
              </Show>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  );
}
