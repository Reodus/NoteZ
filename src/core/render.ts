// Frontend side of rendering: pre-render plugin blocks (Mermaid etc.),
// drive the live preview, export PDFs.
import { createSignal } from "solid-js";
import { saveDialog, openPath } from "./native";
import { app, notify } from "./app";
import { ipc, Diagnostic, RenderedBlock, stem, dirname } from "./ipc";
import { root, state, viewLayout, prefs } from "./store";

import { t } from "./i18n";
export interface Fence {
  lang: string;
  code: string;
  /** 1-based line of the opening fence. */
  line: number;
}

/** Find fenced code blocks (``` or ~~~) in Markdown text. */
export function fences(text: string): Fence[] {
  const out: Fence[] = [];
  const lines = text.split("\n");
  let open: { ch: string; len: number; lang: string; start: number; body: string[] } | null = null;
  lines.forEach((line, i) => {
    const m = /^\s*(`{3,}|~{3,})\s*([^\s`]*)?.*$/.exec(line);
    if (!open) {
      if (m) open = { ch: m[1][0], len: m[1].length, lang: (m[2] || "").toLowerCase(), start: i + 1, body: [] };
    } else if (m && m[1][0] === open.ch && m[1].length >= open.len && !m[2] && line.trim().length === m[1].length) {
      out.push({ lang: open.lang, code: open.body.join("\n"), line: open.start });
      open = null;
    } else {
      open.body.push(line);
    }
  });
  return out;
}

const blockCache = new Map<string, string>();

/** Run frontend block renderers for the fenced blocks they own. */
export async function renderPluginBlocks(text: string): Promise<RenderedBlock[]> {
  const out: RenderedBlock[] = [];
  for (const f of fences(text)) {
    const r = app.blocks.get(f.lang);
    if (!r) continue;
    const key = `${f.lang}\u0000${f.code.trim()}`;
    let typst = blockCache.get(key);
    if (typst === undefined) {
      try {
        typst = await r.toTypst(f.code);
      } catch (e) {
        const msg = String(e).replace(/["\\]/g, "");
        typst = `#block(fill: rgb("#fdecec"), inset: 8pt, radius: 4pt)[#set text(dir: ltr, size: 0.85em); *${f.lang}:* ${msg.replace(/[#\[\]*_$@<>`\\]/g, "")}]`;
      }
      if (blockCache.size > 200) blockCache.clear();
      blockCache.set(key, typst);
    }
    out.push({ lang: f.lang, code: f.code, typst });
  }
  return out;
}

// ---------------------------------------------------------------- preview

export interface PreviewState {
  path: string | null;
  pages: string[];
  /** Content hash per page (to skip unchanged pages on the next render). */
  hashes: string[];
  diagnostics: Diagnostic[];
  notes: string[];
  millis: number;
  busy: boolean;
}

export const [preview, setPreview] = createSignal<PreviewState>({
  path: null,
  pages: [],
  hashes: [],
  diagnostics: [],
  notes: [],
  millis: 0,
  busy: false,
});

let seq = 0;
let timer: number | undefined;

export function schedulePreview(delay = prefs.previewDelayMs) {
  clearTimeout(timer);
  timer = window.setTimeout(runPreview, delay);
}

// Notes with ```base / ```query blocks or ![[x.base]] embeds show other notes'
// data: re-render when the vault changes.
const DATA = /^\s*(`{3,}|~{3,})\s*(base|query)\s*$|!\[\[[^\]]+\.base[\]#|]/im;
app.events.on("vault:changed", () => {
  const path = state.active;
  if (path && /\.md$/i.test(path) && DATA.test(state.buffers[path]?.content ?? "")) schedulePreview(400);
});

export async function runPreview() {
  const path = state.active;
  if (!path || viewLayout() === "editor") return;
  const text = state.buffers[path]?.content ?? "";
  const my = ++seq;
  setPreview((p) => ({ ...p, busy: true }));
  try {
    const blocks = await renderPluginBlocks(text);
    // Pages we already have are not sent again: a long note is megabytes of
    // SVG, and typing changes one or two pages.
    const prev = preview();
    const have = new Map<string, string>();
    if (prev.path === path) prev.hashes.forEach((h, i) => prev.pages[i] && have.set(h, prev.pages[i]));
    const r = await ipc.renderPreview(path, text, blocks, [...have.keys()]);
    if (my !== seq) return; // a newer render started
    const pages = r.pages.map((p, i) => p ?? have.get(r.hashes[i]) ?? "");
    const errors = r.diagnostics.filter((d) => d.severity === "error").length;
    setPreview({
      path,
      // Keep the last good pages while the user fixes an error.
      pages: pages.length || prev.path !== path ? pages : prev.pages,
      hashes: pages.length || prev.path !== path ? r.hashes : prev.hashes,
      diagnostics: r.diagnostics,
      notes: r.notes,
      millis: r.millis,
      busy: false,
    });
    app.events.emit("preview:rendered", { path, pages: r.pages.length, millis: r.millis, errors });
  } catch (e) {
    if (my !== seq) return;
    setPreview((p) => ({ ...p, busy: false, diagnostics: [{ severity: "error", message: String(e), hints: [], line: null, column: null, file: null }] }));
  }
}

// ----------------------------------------------------------------- export

export type ExportFormat = "pdf" | "docx" | "html" | "md";

const FORMATS: Record<ExportFormat, { name: string; ext: string; run: typeof ipc.exportHtml }> = {
  pdf: { name: "PDF", ext: "pdf", run: async (...a) => (await ipc.exportPdf(...a), []) },
  docx: { name: "Word", ext: "docx", run: ipc.exportDocx },
  html: { name: "HTML", ext: "html", run: ipc.exportHtml },
  md: { name: "Markdown", ext: "md", run: ipc.exportMarkdown },
};

/** Formats a note can be exported to (hand-written Typst notes: PDF only). */
export function exportFormats(path: string): ExportFormat[] {
  return path.toLowerCase().endsWith(".md") ? ["pdf", "docx", "html", "md"] : ["pdf"];
}

export const exportLabel = (f: ExportFormat) => t("Export to {x}…", { x: FORMATS[f].name });

export async function exportNote(path = state.active, format: ExportFormat = "pdf") {
  if (!path) return notify(t("Open a note first"), "error");
  if (!exportFormats(path).includes(format)) return notify(t("{x} export is for Markdown notes", { x: FORMATS[format].name }), "error");
  const { name, ext, run } = FORMATS[format];
  const text = state.buffers[path]?.content ?? (await ipc.read(path));
  const dir = !prefs.pdfFolder ? root() : prefs.pdfFolder === "./" ? `${root()}/${dirname(path)}`.replace(/\/$/, "") : prefs.pdfFolder;
  const output = await saveDialog({
    title: t("Export {name}", { name }),
    defaultPath: `${dir}/${stem(path)}.${ext}`,
    filters: [{ name, extensions: [ext] }],
  });
  if (!output) return;
  const target = output.toLowerCase().endsWith(`.${ext}`) ? output : `${output}.${ext}`;
  notify(t("Exporting {name}…", { name }));
  try {
    const blocks = await renderPluginBlocks(text);
    const warnings = await run(path, text, blocks, target);
    if (prefs.openAfterExport) await openPath(target).catch((e) => notify(String(e), "error"));
    const more = warnings.length ? `\n${warnings.slice(0, 4).join("\n")}${warnings.length > 4 ? `\n${t("…and {n} more", { n: warnings.length - 4 })}` : ""}` : "";
    notify(t("Exported {x}{more}", { x: target.split(/[\\/]/).pop(), more }), warnings.length ? "info" : "success", {
      label: t("Open"),
      run: () => openPath(target).catch((e) => notify(String(e), "error")),
    }, warnings.length ? 10000 : undefined);
  } catch (e) {
    const diags = e as Diagnostic[];
    const msg = Array.isArray(diags) ? diags.map((d) => (d.line ? `line ${d.line}: ` : "") + d.message).join("\n") : String(e);
    notify(t("Export failed: {error}", { error: msg }), "error");
  }
}

export const exportPdf = (path = state.active) => exportNote(path, "pdf");

export async function showGeneratedTypst() {
  const path = state.active;
  if (!path) return;
  const text = state.buffers[path]?.content ?? "";
  const blocks = await renderPluginBlocks(text);
  return ipc.generatedTypst(path, text, blocks);
}
