// Built-in features that can be switched off in Settings → Plugins:
// outline and backlinks panels, PDF export, the diagram gallery.
import { createEffect, createMemo, createSignal, For, on } from "solid-js";
import { render } from "solid-js/web";
import type { BuiltinPlugin } from "../core/plugins";
import { ipc, SearchHit, stem, dirname } from "../core/ipc";
import { state, goToLine, openNote, setDialog, setPrefs, setRightTab } from "../core/store";
import { exportPdf, showGeneratedTypst } from "../core/render";

const ICON = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

// ---------------------------------------------------------------- outline

interface Heading {
  level: number;
  text: string;
  line: number;
}

export function OutlinePane() {
  const headings = createMemo<Heading[]>(() => {
    const path = state.active;
    if (!path) return [];
    const text = state.buffers[path]?.content ?? "";
    const typ = path.endsWith(".typ");
    const out: Heading[] = [];
    let fence = false;
    text.split("\n").forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      if (fence) return;
      const m = typ ? /^(=+)\s+(.*)$/.exec(l) : /^(#{1,6})\s+(.*?)\s*(\{[^}]*\})?\s*$/.exec(l);
      if (m) out.push({ level: m[1].length, text: m[2].replace(/[*_`]/g, ""), line: i + 1 });
    });
    return out;
  });
  const min = () => Math.min(...headings().map((h) => h.level), 6);
  return (
    <div class="outline-pane">
      <For each={headings()} fallback={<div class="pane-empty">No headings yet.<br />Use # Heading or the style menu.</div>}>
        {(h) => (
          <div class="outline-item" style={{ "padding-inline-start": `${12 + (h.level - min()) * 16}px` }} onClick={() => goToLine(h.line)} dir="auto">
            <span class={`lvl l${h.level}`}>H{h.level}</span>
            {h.text}
          </div>
        )}
      </For>
    </div>
  );
}

// ------------------------------------------------------------------ links

export function LinksPane() {
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  createEffect(on(() => state.active, async (p) => {
    if (!p) return setHits([]);
    try {
      setHits(await ipc.backlinks(p));
    } catch {
      setHits([]);
    }
  }));
  const outgoing = createMemo(() => {
    const text = state.active ? state.buffers[state.active]?.content ?? "" : "";
    return [...new Set([...text.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim()))];
  });
  return (
    <div class="links-pane">
      <h4>Backlinks <span class="count">{hits().length}</span></h4>
      <For each={hits()} fallback={<div class="pane-empty">No other notes link here.</div>}>
        {(h) => (
          <div class="link-hit" onClick={() => openNote(h.path, { line: h.line })}>
            <div class="link-file" dir="auto">{stem(h.path)} <small>{dirname(h.path)}</small></div>
            <div class="link-snippet" dir="auto">{h.snippet}</div>
          </div>
        )}
      </For>
      <h4>Outgoing links <span class="count">{outgoing().length}</span></h4>
      <For each={outgoing()} fallback={<div class="pane-empty">Link notes with [[Note name]].</div>}>
        {(name) => (
          <div class="link-hit" onClick={() => import("../core/store").then((s) => {
            const p = s.notesList().find((x) => stem(x) === name);
            if (p) openNote(p);
          })}>
            <div class="link-file" dir="auto">{name}</div>
          </div>
        )}
      </For>
    </div>
  );
}


export const OUTLINE_PANEL = "core.outline.pane";
export const LINKS_PANEL = "core.backlinks.pane";

export const outlinePlugin: BuiltinPlugin = {
  id: "core.outline",
  name: "Outline",
  description: "Headings of the current note in the right panel.",
  optional: true,
  onload(api) {
    api.panels.add({
      id: "pane",
      title: "Outline",
      label: true,
      icon: ICON('<path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/>'),
      mount: (el) => render(() => <OutlinePane />, el),
    });
    api.commands.register({ id: "doc.outline", title: "Show outline", run: () => (setPrefs("layout", "split"), setRightTab(OUTLINE_PANEL)) });
  },
};

export const backlinksPlugin: BuiltinPlugin = {
  id: "core.backlinks",
  name: "Backlinks",
  description: "Notes linking to the current note, and its outgoing links.",
  optional: true,
  onload(api) {
    api.panels.add({
      id: "pane",
      title: "Links",
      label: true,
      icon: ICON('<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>'),
      mount: (el) => render(() => <LinksPane />, el),
    });
    api.commands.register({ id: "doc.backlinks", title: "Show backlinks", run: () => (setPrefs("layout", "split"), setRightTab(LINKS_PANEL)) });
  },
};

export const pdfExportPlugin: BuiltinPlugin = {
  id: "core.pdf-export",
  name: "PDF export",
  description: "Export notes as PDF (Ctrl+Shift+S) and view the generated Typst.",
  optional: true,
  onload(api) {
    api.commands.register({ id: "pdf.export", title: "Export PDF", key: "Mod-Shift-s", run: () => exportPdf() });
    api.commands.register({
      id: "pdf.typst",
      title: "View generated Typst source",
      run: async () => {
        const src = await showGeneratedTypst();
        if (src) setDialog({ kind: "typst", source: src });
      },
    });
  },
};

export const diagramsPlugin: BuiltinPlugin = {
  id: "core.diagrams",
  name: "Diagram gallery",
  description: "Insert charts and diagrams from a gallery (toolbar, / menu, Ctrl+Shift+D).",
  optional: true,
  onload(api) {
    api.commands.register({ id: "insert.diagram", title: "Insert chart or diagram…", key: "Mod-Shift-d", run: () => setDialog({ kind: "diagrams" }) });
  },
};
