// Bookmarks: notes, headings, blocks, folders and searches, in groups.
// Stored in <vault>/.notez/bookmarks.json in Obsidian's bookmarks format, so
// an Obsidian vault's .obsidian/bookmarks.json is picked up on first use.
import { createSignal } from "solid-js";
import { app } from "./app";
import { ipc } from "./ipc";
import { notify } from "./app";

import { removeFromTree, moveInTree } from "./bookmarkTree";
import { t } from "./i18n";
export interface Bookmark {
  type: "file" | "folder" | "search" | "group";
  /** file / folder: vault path. */
  path?: string;
  /** file: "#Heading" or "#^block-id" inside the note. */
  subpath?: string;
  /** search: the query. */
  query?: string;
  /** Display name (groups always have one). */
  title?: string;
  /** group: its bookmarks. */
  items?: Bookmark[];
  ctime?: number;
}

const FILE = ".notez/bookmarks.json";
const [items, setItemsRaw] = createSignal<Bookmark[]>([]);
export const bookmarks = items;

async function load() {
  setItemsRaw([]);
  for (const f of [FILE, ".obsidian/bookmarks.json"]) {
    try {
      const data = JSON.parse(await ipc.read(f));
      if (Array.isArray(data?.items)) return setItemsRaw(data.items as Bookmark[]);
    } catch {
      /* missing or invalid: try the next */
    }
  }
}

function save(next: Bookmark[]) {
  setItemsRaw(next);
  ipc.write(FILE, JSON.stringify({ items: next }, null, 2) + "\n").catch((e) => notify(t("Bookmarks: {error}", { error: e }), "error"));
}

app.events.on("vault:opened", () => void load());

const same = (a: Bookmark, b: Bookmark) =>
  a.type === b.type && a.path === b.path && (a.subpath ?? "") === (b.subpath ?? "") && a.query === b.query;

/** Find a bookmark anywhere (also inside groups). */
function contains(list: Bookmark[], b: Bookmark): boolean {
  return list.some((x) => same(x, b) || (x.items ? contains(x.items, b) : false));
}

export const isBookmarked = (b: Bookmark) => contains(items(), b);

/** Add a bookmark (to a group, by title), or remove it when already there. */
export function toggleBookmark(b: Bookmark, group?: string | Bookmark) {
  if (isBookmarked(b)) return removeBookmark(b);
  const entry = { ...b, ctime: Date.now() };
  if (group) {
    let found = false;
    const append = (list: Bookmark[]): Bookmark[] => list.map(x => {
      if (x.type === "group" && (typeof group === "string" ? !found && x.title === group : x === group)) { found = true; return { ...x, items: [...(x.items ?? []), entry] }; }
      return x.items ? { ...x, items: append(x.items) } : x;
    });
    const next = append(items());
    if (found) return save(next);
    if (typeof group === "string") return save([...next, { type: "group", title: group, items: [entry], ctime: Date.now() }]);
  }
  save([...items(), entry]);
}

export function removeBookmark(b: Bookmark) {
  const strip = (list: Bookmark[]): Bookmark[] =>
    list.filter((x) => !same(x, b) || x.type === "group").map((x) => (x.items ? { ...x, items: strip(x.items) } : x));
  // A group is removed by identity (two groups may share a title).
  save(b.type === "group" ? removeFromTree(items(), b) : strip(items()));
}

export function addGroup(title: string) {
  save([...items(), { type: "group", title, items: [], ctime: Date.now() }]);
}

export function renameBookmark(b: Bookmark, title: string) {
  const walk = (list: Bookmark[]): Bookmark[] => list.map((x) => (x === b ? { ...x, title: title || undefined } : x.items ? { ...x, items: walk(x.items) } : x));
  save(walk(items()));
}

/**
 * Move bookmark `b` before `target` (or into `target` when it is a group and
 * `into` is set, or to the end of the top level when `target` is null).
 */
export function moveBookmark(b: Bookmark, target: Bookmark | null, into = false) {
  save(moveInTree(items(), b, target, into));
}

/** Bookmarks pointing into `from` now point into `to` (after a rename). */
export function renameBookmarkPaths(from: string, to: string) {
  let changed = false;
  const walk = (list: Bookmark[]): Bookmark[] =>
    list.map((x) => {
      if (x.items) return { ...x, items: walk(x.items) };
      if (x.path && (x.path === from || x.path.startsWith(from + "/"))) {
        changed = true;
        return { ...x, path: to + x.path.slice(from.length) };
      }
      return x;
    });
  const next = walk(items());
  if (changed) save(next);
}

/** Display name of a bookmark. */
export function bookmarkLabel(b: Bookmark): string {
  if (b.title) return b.title;
  if (b.type === "search") return b.query ?? "";
  const name = (b.path ?? "").split("/").pop()!.replace(/\.(md|typ)$/, "");
  return b.subpath ? `${name} › ${b.subpath.replace(/^#\^?/, "")}` : name;
}
