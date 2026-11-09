// Built-in features that can be switched off in Settings → Plugins:
// outline and backlinks panels, PDF export, the diagram gallery.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { render } from "solid-js/web";
import type { BuiltinPlugin } from "../core/plugins";
import { ipc, Backlink, Mention, stem, dirname } from "../core/ipc";
import { state, goToLine, openNote, setDialog, setPrefs, setRightTab, prefs, saveAll, reloadFromDisk, notesList } from "../core/store";
import { app, notify } from "../core/app";
import { linkName } from "../core/blocks";
import { exportNote, exportPdf, showGeneratedTypst } from "../core/render";

import { t, tn } from "../core/i18n";
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
      <For each={headings()} fallback={<div class="pane-empty">{t("No headings yet.")}<br />{t("Use # Heading or the style menu.")}</div>}>
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
  const [hits, setHits] = createSignal<Backlink[]>([]);
  const [mentions, setMentions] = createSignal<Mention[] | null>(null);
  const [showMentions, setShowMentions] = createSignal(false);
  const [rev, setRev] = createSignal(0);
  let timer: number | undefined;
  const bump = () => (clearTimeout(timer), (timer = window.setTimeout(() => setRev((n) => n + 1), 400)));
  const offs = [app.events.on("note:saved", bump), app.events.on("vault:changed", bump), app.events.on("note:reloaded", bump)];
  onCleanup(() => offs.forEach((f) => f()));
  createEffect(on([() => state.active, rev], async ([p]) => {
    if (!p) return setHits([]);
    try {
      setHits(await ipc.backlinks(p, [...prefs.excludedFolders]));
    } catch {
      setHits([]);
    }
  }));
  createEffect(on([() => state.active, rev, showMentions], async ([p, , show]) => {
    if (!p || !show) return setMentions(null);
    setMentions(await ipc.unlinkedMentions(p, [...prefs.excludedFolders]).catch(() => []));
  }));
  const groups = createMemo(() => {
    const m = new Map<string, Backlink[]>();
    for (const h of hits()) m.set(h.path, [...(m.get(h.path) ?? []), h]);
    return [...m];
  });
  const outgoing = createMemo(() => {
    const text = state.active ? state.buffers[state.active]?.content ?? "" : "";
    return [...new Set([...text.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim()))];
  });
  const linkThem = async (items: Mention[]) => {
    const target = state.active;
    if (!target || !items.length) return;
    await saveAll();
    const changed = await ipc.linkMentions(linkName(target, null), items).catch((e) => (notify(String(e), "error"), [] as string[]));
    for (const p of changed) if (state.buffers[p]) await reloadFromDisk(p);
    if (changed.length) notify(t("Linked {mentions} in {notes}.", { mentions: tn(items.length, "{n} mention", "{n} mentions"), notes: tn(changed.length, "{n} note", "{n} notes") }));
    setRev((n) => n + 1);
  };
  const subLabel = (h: Backlink) => (h.sub ? (h.sub.startsWith("^") ? `block ${h.sub}` : `# ${h.sub}`) : "");
  return (
    <div class="links-pane">
      <h4>{t("Backlinks")} <span class="count">{hits().length}</span></h4>
      <For each={groups()} fallback={<div class="pane-empty">{t("No other notes link here.")}</div>}>
        {([path, list]) => (
          <div class="link-group">
            <div class="link-file" dir="auto" onClick={() => openNote(path)}>{stem(path)} <small>{dirname(path)}</small></div>
            <For each={list}>
              {(h) => (
                <div class="link-hit" onClick={() => openNote(h.path, { line: h.line })}>
                  <Show when={h.sub || h.embed}>
                    <div class="link-target">{t(h.embed ? "Embeds {target}" : "Links to {target}", { target: subLabel(h) || t("the note") })}</div>
                  </Show>
                  <div class="link-snippet" dir="auto">{readable(h.snippet)}</div>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
      <h4 class="clickable" onClick={() => setShowMentions((v) => !v)}>
        <span class="chev">{showMentions() ? "▾" : "▸"}</span> {t("Unlinked mentions")}
        <Show when={mentions()}><span class="count">{mentions()!.length}</span></Show>
        <Show when={showMentions() && (mentions()?.length ?? 0) > 1}>
          <button class="btn small push" onClick={(e) => (e.stopPropagation(), void linkThem(mentions()!))}>{t("Link all")}</button>
        </Show>
      </h4>
      <Show when={showMentions()}>
        <For each={mentions() ?? []} fallback={<div class="pane-empty">{mentions() ? t("No other note names this one without a link.") : t("Looking…")}</div>}>
          {(m) => (
            <div class="link-hit mention" onClick={() => openNote(m.path, { line: m.line })}>
              <div class="link-file" dir="auto">{stem(m.path)} <small>{dirname(m.path)}</small></div>
              <div class="link-snippet" dir="auto">{highlight(m.snippet, m.text)}</div>
              <button class="btn small" title={t("Turn “{text}” into a link", { text: m.text })} onClick={(e) => (e.stopPropagation(), void linkThem([m]))}>{t("Link")}</button>
            </div>
          )}
        </For>
      </Show>
      <h4>{t("Outgoing links")} <span class="count">{outgoing().length}</span></h4>
      <For each={outgoing()} fallback={<div class="pane-empty">{t("Link notes with [[Note name]].")}</div>}>
        {(name) => (
          <div class="link-hit" onClick={() => {
            const p = notesList().find((x) => stem(x) === name || x.replace(/\.md$/, "") === name);
            if (p) openNote(p);
          }}>
            <div class="link-file" dir="auto">{name}</div>
          </div>
        )}
      </For>
    </div>
  );
}

/** Links shown as their text, as in the editor. */
const readable = (s: string) =>
  s
    .replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/!?\[\[([^\]]+)\]\]/g, (_, t: string) => t.replace(/#\^.*$/, "").replace(/#/, " › ") || t)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");

/** `text` with the first `word` in it marked. */
function highlight(text: string, word: string) {
  const i = text.toLowerCase().indexOf(word.toLowerCase());
  if (i < 0) return text;
  return [text.slice(0, i), <mark>{text.slice(i, i + word.length)}</mark>, text.slice(i + word.length)];
}


export const OUTLINE_PANEL = "core.outline.pane";
export const LINKS_PANEL = "core.backlinks.pane";

export const outlinePlugin: BuiltinPlugin = {
  id: "core.outline",
  name: t("Outline"),
  description: t("Headings of the current note in the right panel."),
  optional: true,
  onload(api) {
    api.panels.add({
      id: "pane",
      title: t("Outline"),
      label: true,
      icon: ICON('<path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/>'),
      mount: (el) => render(() => <OutlinePane />, el),
    });
    api.commands.register({ id: "doc.outline", title: t("Show outline"), run: () => (setPrefs("layout", "split"), setRightTab(OUTLINE_PANEL)) });
  },
};

export const backlinksPlugin: BuiltinPlugin = {
  id: "core.backlinks",
  name: t("Backlinks"),
  description: t("Notes linking to the current note, and its outgoing links."),
  optional: true,
  onload(api) {
    api.panels.add({
      id: "pane",
      title: t("Links"),
      label: true,
      icon: ICON('<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>'),
      mount: (el) => render(() => <LinksPane />, el),
    });
    api.commands.register({ id: "doc.backlinks", title: t("Show backlinks"), run: () => (setPrefs("layout", "split"), setRightTab(LINKS_PANEL)) });
  },
};

export const pdfExportPlugin: BuiltinPlugin = {
  id: "core.pdf-export",
  name: "PDF export",
  description: t("Export notes as PDF (Ctrl+Shift+S) and view the generated Typst."),
  optional: true,
  onload(api) {
    api.commands.register({ id: "pdf.export", title: t("Export PDF"), key: "Mod-Shift-s", run: () => exportPdf() });
    api.commands.register({ id: "export.docx", title: t("Export to Word (.docx)"), run: () => exportNote(undefined, "docx") });
    api.commands.register({ id: "export.html", title: t("Export to HTML"), run: () => exportNote(undefined, "html") });
    api.commands.register({ id: "export.markdown", title: t("Export to portable Markdown"), run: () => exportNote(undefined, "md") });
    api.commands.register({
      id: "pdf.typst",
      title: t("View generated Typst source"),
      run: async () => {
        const src = await showGeneratedTypst();
        if (src) setDialog({ kind: "typst", source: src });
      },
    });
  },
};

export const diagramsPlugin: BuiltinPlugin = {
  id: "core.diagrams",
  name: t("Diagram gallery"),
  description: t("Insert charts and diagrams from a gallery (toolbar, / menu, Ctrl+Shift+D)."),
  optional: true,
  onload(api) {
    api.commands.register({ id: "insert.diagram", title: t("Insert chart or diagram…"), key: "Mod-Shift-d", run: () => setDialog({ kind: "diagrams" }) });
  },
};
