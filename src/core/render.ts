// Frontend side of rendering: pre-render plugin blocks (Mermaid etc.),
// drive the live preview, export PDFs.
import { createSignal } from "solid-js";
import { saveDialog, openPath } from "./native";
import { app, notify } from "./app";
import { ipc, Diagnostic, RenderedBlock, stem } from "./ipc";
import { root, state, prefs } from "./store";

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
  diagnostics: Diagnostic[];
  notes: string[];
  millis: number;
  busy: boolean;
}

export const [preview, setPreview] = createSignal<PreviewState>({
  path: null,
  pages: [],
  diagnostics: [],
  notes: [],
  millis: 0,
  busy: false,
});

let seq = 0;
let timer: number | undefined;

export function schedulePreview(delay = 350) {
  clearTimeout(timer);
  timer = window.setTimeout(runPreview, delay);
}

export async function runPreview() {
  const path = state.active;
  if (!path || prefs.layout === "editor") return;
  const text = state.buffers[path]?.content ?? "";
  const my = ++seq;
  setPreview((p) => ({ ...p, busy: true }));
  try {
    const blocks = await renderPluginBlocks(text);
    const r = await ipc.renderPreview(path, text, blocks);
    if (my !== seq) return; // a newer render started
    const errors = r.diagnostics.filter((d) => d.severity === "error").length;
    setPreview({
      path,
      // Keep the last good pages while the user fixes an error.
      pages: r.pages.length || preview().path !== path ? r.pages : preview().pages,
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

export async function exportPdf(path = state.active) {
  if (!path) return notify("Open a note first", "error");
  const text = state.buffers[path]?.content ?? (await ipc.read(path));
  const output = await saveDialog({
    title: "Export PDF",
    defaultPath: `${root()}/${stem(path)}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!output) return;
  const target = output.endsWith(".pdf") ? output : `${output}.pdf`;
  notify("Exporting PDF…");
  try {
    const blocks = await renderPluginBlocks(text);
    await ipc.exportPdf(path, text, blocks, target);
    notify(`Exported ${target.slice(target.lastIndexOf("/") + 1)}`, "success", {
      label: "Open",
      run: () => openPath(target).catch((e) => notify(String(e), "error")),
    });
  } catch (e) {
    const diags = e as Diagnostic[];
    const msg = Array.isArray(diags) ? diags.map((d) => (d.line ? `line ${d.line}: ` : "") + d.message).join("\n") : String(e);
    notify(`Export failed: ${msg}`, "error");
  }
}

export async function showGeneratedTypst() {
  const path = state.active;
  if (!path) return;
  const text = state.buffers[path]?.content ?? "";
  const blocks = await renderPluginBlocks(text);
  return ipc.generatedTypst(path, text, blocks);
}
