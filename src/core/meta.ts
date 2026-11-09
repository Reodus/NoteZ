// Note metadata from the core index (tags, icon, cover, title, aliases),
// refreshed when notes are saved or change on disk.
import { createMemo, createRoot, createSignal } from "solid-js";
import { app } from "./app";
import { ipc, NoteMeta } from "./ipc";

const [meta, setMeta] = createSignal<Record<string, NoteMeta>>({});
/** Metadata of every note that has some (tags, icon, cover, title, aliases). */
export const noteMeta = meta;

let timer: number | undefined;
/** Re-read the metadata soon (coalesces bursts of saves and file events). */
export function refreshMeta(delay = 250) {
  clearTimeout(timer);
  timer = window.setTimeout(async () => {
    try {
      setMeta(await ipc.noteMeta());
    } catch {
      /* no vault open */
    }
  }, delay);
}

app.events.on("vault:opened", () => refreshMeta(0));
app.events.on("vault:changed", () => refreshMeta());
app.events.on("note:saved", () => refreshMeta());
app.events.on("note:reloaded", () => refreshMeta());

export interface TagNode {
  /** Full tag, e.g. "project/alpha". */
  tag: string;
  /** Last segment, e.g. "alpha". */
  name: string;
  /** Notes with this tag or a nested one. */
  count: number;
  children: TagNode[];
}

/** Every tag with its note count, as a tree split at "/". */
export const tagTree = createRoot(() =>
  createMemo<TagNode[]>(() => {
    const exact = new Map<string, { tag: string; notes: Set<string> }>();
    for (const [path, m] of Object.entries(meta())) {
      for (const t of m.tags) {
        // A note counts once for each ancestor too: #a/b counts for #a.
        const parts = t.split("/");
        parts.forEach((_, i) => {
          const full = parts.slice(0, i + 1).join("/");
          const key = full.toLowerCase();
          const e = exact.get(key) ?? { tag: full, notes: new Set<string>() };
          e.notes.add(path);
          exact.set(key, e);
        });
      }
    }
    const nodes = new Map<string, TagNode>();
    const roots: TagNode[] = [];
    for (const [key, { tag, notes }] of [...exact].sort((a, b) => a[0].localeCompare(b[0]))) {
      const node: TagNode = { tag, name: tag.split("/").pop()!, count: notes.size, children: [] };
      nodes.set(key, node);
      const parent = key.includes("/") ? nodes.get(key.slice(0, key.lastIndexOf("/"))) : undefined;
      (parent ? parent.children : roots).push(node);
    }
    return roots;
  }),
);

/** All tags, flat, most used first (for completion). */
export const allTags = createRoot(() =>
  createMemo(() => {
    const out: { tag: string; count: number }[] = [];
    const walk = (ns: TagNode[]) => ns.forEach((n) => (out.push({ tag: n.tag, count: n.count }), walk(n.children)));
    walk(tagTree());
    return out.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }),
);

/** Emoji or short text icon of a note (frontmatter `icon`). */
export const noteIcon = (path: string) => meta()[path]?.icon;
