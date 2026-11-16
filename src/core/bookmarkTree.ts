import type { Bookmark } from './bookmarks.ts';
export const containsBookmark = (b: Bookmark, wanted: Bookmark): boolean => b === wanted || !!b.items?.some(x => containsBookmark(x, wanted));
export function removeFromTree(list: Bookmark[], bookmark: Bookmark): Bookmark[] {
  return list.filter(x => x !== bookmark).map(x => x.items ? { ...x, items: removeFromTree(x.items, bookmark) } : x);
}
export function moveInTree(list: Bookmark[], bookmark: Bookmark, target: Bookmark | null, into = false): Bookmark[] {
  if (!list.some(x => containsBookmark(x, bookmark)) || (target && containsBookmark(bookmark, target))) return list;
  const clones = new Map<Bookmark, Bookmark>();
  const remove = (items: Bookmark[]): Bookmark[] => items.filter(x => x !== bookmark).map(x => {
    if (!x.items) return x;
    const next = { ...x, items: remove(x.items) }; clones.set(x, next); return next;
  });
  const remaining = remove(list), destination = target ? clones.get(target) ?? target : null;
  let inserted = false;
  const insert = (items: Bookmark[]): Bookmark[] => items.flatMap(x => {
    if (x === destination) { inserted = true; return into && x.type === 'group' ? [{ ...x, items: [...(x.items ?? []), bookmark] }] : [bookmark, x]; }
    return [x.items ? { ...x, items: insert(x.items) } : x];
  });
  const next = insert(remaining);
  return inserted ? next : [...next, bookmark];
}
