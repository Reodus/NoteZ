// In-app Help: the user guide in docs/*.md, bundled with the app and rendered
// by the core's Markdown → HTML. Links between pages and to headings work;
// web links open in the browser.
import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { BookOpen, Search } from "lucide-solid";
import { ipc } from "../core/ipc";
import { openUrl } from "../core/native";
import { Modal } from "./primitives";

import { t } from "../core/i18n";
const RAW = import.meta.glob("../../docs/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const DOCS: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([p, text]) => [p.split("/").pop()!.replace(/\.md$/, ""), text]),
);

/** Pages in reading order; any other docs/*.md follow. */
const ORDER: [string, string][] = [
  ["GUIDE", t("User guide")],
  ["MARKDOWN", t("Writing notes (Markdown)")],
  ["LANGUAGES", t("Languages & scripts")],
  ["PDF-THEMES", "PDF themes"],
  ["EXPORT", t("Exporting (PDF, Word, HTML, Markdown)")],
  ["UI-THEMES", "UI themes & snippets"],
  ["ORGANIZING", t("Tags, daily notes, bookmarks")],
  ["SLASH", t("Slash commands & completion")],
  ["SEARCH", t("Search & replace")],
  ["BLOCKS", t("Blocks, references & embeds")],
  ["HISTORY", t("History, snapshots & sync")],
  ["DATABASES", t("Databases & queries")],
  ["FLASHCARDS", "Flashcards"],
  ["PDF-ANNOTATIONS", "PDF annotations"],
  ["PLUGINS", t("Writing plugins")],
];

export const helpPages = () => {
  const known = ORDER.filter(([id]) => DOCS[id]);
  const extra = Object.keys(DOCS)
    .filter((id) => !ORDER.some(([k]) => k === id))
    .sort()
    .map((id) => [id, id.replace(/-/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())] as [string, string]);
  return [...known, ...extra];
};

/** GitHub-style heading anchor: lowercase, spaces → "-", punctuation dropped. */
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export default function HelpView(props: { doc?: string; anchor?: string; onClose: () => void }) {
  const first = props.doc && DOCS[props.doc] ? props.doc : DOCS.GUIDE ? "GUIDE" : helpPages()[0]?.[0];
  const [page, setPage] = createSignal(first ?? "");
  const [anchor, setAnchor] = createSignal(props.anchor ?? "");
  const [q, setQ] = createSignal("");
  const [html] = createResource(page, (p) => ipc.markdownHtml(DOCS[p] ?? "").catch((e) => `<p>${String(e)}</p>`));
  let body!: HTMLDivElement;

  // After rendering: give headings their anchors, then scroll.
  createEffect(() => {
    if (!html()) return;
    queueMicrotask(() => {
      const seen = new Map<string, number>();
      for (const h of body.querySelectorAll<HTMLElement>("h1, h2, h3, h4")) {
        let id = slug(h.textContent ?? "");
        const n = seen.get(id) ?? 0;
        seen.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        h.id = id;
      }
      for (const el of body.querySelectorAll<HTMLElement>("p, li, td, th, h1, h2, h3, h4, blockquote")) el.dir = "auto";
      const a = anchor();
      const target = a ? body.querySelector(`[id="${CSS.escape(a)}"]`) : null;
      if (target) target.scrollIntoView({ block: "start" });
      else body.scrollTop = 0;
    });
  });

  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    e.preventDefault();
    if (/^(https?:|mailto:)/i.test(href)) return void openUrl(href);
    const [file, hash = ""] = href.split("#");
    const id = file.replace(/^(\.\/|docs\/)/, "").replace(/\.md$/, "");
    if (!file) {
      setAnchor("");
      setAnchor(decodeURIComponent(hash));
      body.querySelector(`[id="${CSS.escape(decodeURIComponent(hash))}"]`)?.scrollIntoView({ block: "start" });
    } else if (DOCS[id]) {
      setAnchor(decodeURIComponent(hash));
      setPage(id);
    }
  };

  /** Pages whose text contains the search words, with a snippet. */
  const results = () => {
    const words = q().trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return helpPages()
      .map(([id, title]) => {
        const lines = (DOCS[id] ?? "").split("\n");
        const hit = lines.find((l) => words.every((w) => l.toLowerCase().includes(w)));
        let heading = "";
        if (hit) for (const l of lines.slice(0, lines.indexOf(hit) + 1)) if (/^#{1,4} /.test(l)) heading = l.replace(/^#+ /, "");
        return hit ? { id, title, snippet: hit.replace(/[`*#>|]/g, "").trim().slice(0, 120), heading } : null;
      })
      .filter(Boolean) as { id: string; title: string; snippet: string; heading: string }[];
  };

  return (
    <Modal title={t("Help")} width="1080px" class="help-modal" onClose={props.onClose}>
      <div class="help">
        <nav class="help-nav">
          <div class="settings-search">
            <Search size={14} />
            <input placeholder={t("Search the guide")} value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
          </div>
          <Show
            when={q().trim()}
            fallback={
              <For each={helpPages()}>
                {([id, title]) => (
                  <button classList={{ active: page() === id }} onClick={() => (setAnchor(""), setPage(id))}>
                    <BookOpen size={14} /> {title}
                  </button>
                )}
              </For>
            }
          >
            <For each={results()} fallback={<div class="pane-empty">{t("No matches")}</div>}>
              {(r) => (
                <button class="help-hit" onClick={() => (setAnchor(r.heading ? slug(r.heading) : ""), setPage(r.id), setQ(""))}>
                  <b>{r.title}{r.heading ? ` › ${r.heading}` : ""}</b>
                  <span>{r.snippet}</span>
                </button>
              )}
            </For>
          </Show>
        </nav>
        <div class="help-doc" ref={body} onClick={onClick} innerHTML={html() ?? ""} />
      </div>
    </Modal>
  );
}
