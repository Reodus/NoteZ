// Blocks across notes: adding `^block-id`s, link text for a block, showing
// what a link points at, and the Markdown → HTML used by embeds and previews.
import { EditorView } from "@codemirror/view";
import { ipc, stem } from "./ipc";
import { editorView, notesList, state, updateContent } from "./store";

/** A new block id: six lowercase letters and digits. */
export function newBlockId(): string {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  const r = crypto.getRandomValues(new Uint8Array(6));
  let id = "";
  for (const b of r) id += a[b % a.length];
  return /[a-z]/.test(id) ? id : "b" + id.slice(1);
}

/** Replace the text of open note `path` with `next`, as one small edit. */
export function applyText(path: string, next: string) {
  const view = editorView();
  if (view && state.active === path) {
    const cur = view.state.doc.toString();
    if (cur === next) return;
    let a = 0;
    while (a < cur.length && a < next.length && cur[a] === next[a]) a++;
    let b = 0;
    while (b < cur.length - a && b < next.length - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b++;
    view.dispatch({ changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) }, userEvent: "input.blockid" });
  } else if (state.buffers[path]) updateContent(path, next);
}

/**
 * The `^id` of the block at `line` (1-based) of `path`, adding `want` (or a
 * new id) when it has none. Open notes get the id in their buffer.
 */
export async function ensureBlockId(path: string, line: number, want?: string): Promise<string> {
  const buf = state.buffers[path];
  const r = await ipc.blockId(path, line, buf?.content, want);
  if (buf && r.text != null) applyText(path, r.text);
  return r.id;
}

/** How to name `path` in a link from `from`: its name, or its path when the name is not unique. */
export function linkName(path: string, from: string | null): string {
  if (path === from) return "";
  const s = stem(path);
  const dup = notesList().filter((p) => stem(p) === s).length > 1;
  return dup ? path.replace(/\.md$/, "") : s;
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Markdown of a note (or part of one) → safe HTML, with wikilinks, embeds and highlights. */
export async function previewHtml(md: string): Promise<string> {
  let fence = false;
  const lines = md.split("\n").flatMap((l) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence) return [l];
    if (/^\s*\^[\w-]+\s*$/.test(l)) return [];
    return [
      l
        .replace(/\s\^[\w-]+\s*$/, "")
        .replace(/%%.*?%%/g, "")
        .replace(/!\[\[([^\]|]+?)(?:\|(\d+))?\]\]/g, (_, f: string, w) =>
          IMAGE.test(f) ? `<img data-src="${esc(f)}"${w ? ` style="width:${w}px"` : ""}>` : `<span class="cm-nz-lp-link internal" data-target="${esc(f)}">↪ ${esc(f)}</span>`,
        )
        .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, t: string, a: string) => `<span class="cm-nz-lp-link internal" data-target="${esc(t)}">${esc(a || t.replace(/#\^?/, " › "))}</span>`)
        .replace(/(?<!=)==([^=\s][^=]*?)==(?!=)/g, "<mark>$1</mark>")
        .replace(/^(\s*>\s*)\[!(\w+)\][+-]?\s*(.*)$/, (_, q, t: string, title: string) => `${q}**${title || t[0].toUpperCase() + t.slice(1)}**`),
    ];
  });
  return sanitize(await ipc.markdownHtml(lines.join("\n")));
}

/** Drop scripts, frames and event handlers from note HTML. */
export function sanitize(html: string): string {
  const t = document.createElement("template");
  t.innerHTML = html;
  t.content.querySelectorAll("script,iframe,object,embed,style,link,meta,form").forEach((e) => e.remove());
  t.content.querySelectorAll("*").forEach((e) => {
    for (const a of [...e.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) e.removeAttribute(a.name);
    }
  });
  return t.innerHTML;
}

// ------------------------------------------------------- jump and flash

/** Lines `[from, to]` (1-based) of the open note blink briefly. */
export function flashLines(view: EditorView, from: number, to: number) {
  const doc = view.state.doc;
  const a = doc.line(Math.max(1, Math.min(from, doc.lines)));
  const b = doc.line(Math.max(1, Math.min(to, doc.lines)));
  import("../editor/blocks").then((m) => m.flash(view, a.from, b.to));
}

/** Find `sub` (`^id` or a heading, `A#B` for B under A) in the open note; 1-based lines. */
export function findInOpenNote(sub: string): { start: number; end: number } | null {
  const view = editorView();
  if (!view) return null;
  const doc = view.state.doc;
  const norm = (s: string) => s.replace(/[#*_`=~\[\]]/g, "").replace(/[\s‌-]+/g, " ").trim().toLowerCase();
  let want = sub.replace(/^#/, "");
  try {
    want = decodeURIComponent(want);
  } catch {
    /* as typed */
  }
  if (want.startsWith("^")) {
    const id = want.slice(1);
    for (let n = 1; n <= doc.lines; n++) {
      const t = doc.line(n).text;
      if (new RegExp(`(^|\\s)\\^${id.replace(/[-]/g, "\\-")}\\s*$`).test(t)) {
        if (/^\s*\^/.test(t)) {
          // `^id` on its own line names the block above it.
          let s = n - 1;
          while (s > 1 && !doc.line(s).text.trim()) s--;
          const end = s;
          while (s > 1 && doc.line(s - 1).text.trim()) s--;
          return { start: s, end };
        }
        // The rest of a paragraph above it.
        let s = n;
        if (!/^\s*([-*+]|\d+[.)])\s/.test(t)) while (s > 1 && doc.line(s - 1).text.trim() && !/^\s*(#|[-*+]\s|\d+[.)]\s|>)/.test(doc.line(s - 1).text)) s--;
        return { start: s, end: n };
      }
    }
    return null;
  }
  const parts = want.split("#").map(norm).filter(Boolean);
  let from = 1;
  let hit: { line: number; level: number } | null = null;
  for (const p of parts) {
    hit = null;
    let fence = false;
    for (let n = from; n <= doc.lines; n++) {
      const t = doc.line(n).text;
      if (/^\s*(```|~~~)/.test(t)) fence = !fence;
      const m = !fence && /^(#{1,6})\s+(.*?)\s*(\^[\w-]+)?\s*#*\s*$/.exec(t);
      if (m && norm(m[2].replace(/\s*\{[^}]*\}$/, "")) === p) {
        hit = { line: n, level: m[1].length };
        break;
      }
    }
    if (!hit) return null;
    from = hit.line + 1;
  }
  if (!hit) return null;
  let end = doc.lines;
  let fence = false;
  for (let n = hit.line + 1; n <= doc.lines; n++) {
    const t = doc.line(n).text;
    if (/^\s*(```|~~~)/.test(t)) fence = !fence;
    const m = !fence && /^(#{1,6})\s/.exec(t);
    if (m && m[1].length <= hit.level) {
      end = n - 1;
      break;
    }
  }
  while (end > hit.line && !doc.line(end).text.trim()) end--;
  return { start: hit.line, end };
}

/** Scroll the open note to `sub` and make it blink. */
export function revealInOpenNote(sub: string): boolean {
  const view = editorView();
  const r = findInOpenNote(sub);
  if (!view || !r) return false;
  const line = view.state.doc.line(r.start);
  view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
  view.focus();
  flashLines(view, r.start, sub.replace(/^#/, "").startsWith("^") ? r.end : r.start);
  return true;
}
