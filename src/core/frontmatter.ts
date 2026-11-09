// Read/modify the YAML frontmatter of a Markdown note, preserving comments
// and formatting of untouched keys.
import { parseDocument, Document } from "yaml";
import type { EditorView } from "@codemirror/view";

export interface FmRange {
  /** Character offsets of the YAML text (between the --- lines). */
  from: number;
  to: number;
  /** Offset where the body starts (after the closing ---). */
  bodyStart: number;
}

export function frontmatterRange(text: string): FmRange | null {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return null;
  const start = text.indexOf("\n") + 1;
  const re = /^(---|\.\.\.)\s*$/gm;
  re.lastIndex = start;
  const m = re.exec(text);
  if (!m) return null;
  const end = m.index;
  const after = text.indexOf("\n", end);
  return { from: start, to: end, bodyStart: after < 0 ? text.length : after + 1 };
}

export function readFrontmatter(text: string): Record<string, any> {
  const r = frontmatterRange(text);
  if (!r) return {};
  try {
    return (parseDocument(text.slice(r.from, r.to)).toJS() as Record<string, any>) ?? {};
  } catch {
    return {};
  }
}

/** Drop undefined/"" and empty objects. A nested `null` is kept: in style
 * and page overrides it means "clear the theme's value". */
function prune(v: any): any {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o: Record<string, any> = {};
    for (const [k, x] of Object.entries(v)) {
      const p = prune(x);
      if (p !== undefined && p !== "" && !(p && typeof p === "object" && Object.keys(p).length === 0)) o[k] = p;
    }
    return o;
  }
  return v;
}

/**
 * Set `keyPath` (e.g. ["styles", "h1"]) in the note's frontmatter. `value`
 * null/undefined deletes the key. Creates the frontmatter if missing.
 */
export function setFrontmatter(view: EditorView, keyPath: string[], value: unknown) {
  const text = view.state.doc.toString();
  const r = frontmatterRange(text);
  const doc: Document = r ? parseDocument(text.slice(r.from, r.to)) : new Document({});
  const cleaned = prune(value);
  const empty = cleaned === undefined || cleaned === null || cleaned === "" ||
    (typeof cleaned === "object" && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0);
  if (empty) {
    doc.deleteIn(keyPath);
    // Drop empty parents.
    for (let i = keyPath.length - 1; i > 0; i--) {
      const parent = doc.getIn(keyPath.slice(0, i)) as any;
      if (parent && typeof parent === "object" && "items" in parent && parent.items.length === 0) doc.deleteIn(keyPath.slice(0, i));
    }
  } else {
    doc.setIn(keyPath, doc.createNode(cleaned, { flow: keyPath[0] === "styles" }));
  }
  let yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  if (yaml.trim() === "{}") yaml = "";
  if (r) {
    if (!yaml.trim()) {
      view.dispatch({ changes: { from: 0, to: r.bodyStart, insert: "" } });
    } else {
      view.dispatch({ changes: { from: r.from, to: r.to, insert: yaml } });
    }
  } else if (yaml.trim()) {
    view.dispatch({ changes: { from: 0, to: 0, insert: `---\n${yaml}---\n\n` } });
  }
}

/** Apply `edit` to the parsed frontmatter document and write it back (one undo step). */
export function editFrontmatter(view: EditorView, edit: (doc: Document) => void) {
  const text = view.state.doc.toString();
  const r = frontmatterRange(text);
  const doc: Document = r ? parseDocument(text.slice(r.from, r.to)) : new Document({});
  edit(doc);
  let yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  if (yaml.trim() === "{}" || yaml.trim() === "null") yaml = "";
  if (r) view.dispatch({ changes: { from: r.from, to: r.to, insert: yaml } });
  else view.dispatch({ changes: { from: 0, to: 0, insert: `---\n${yaml}---\n\n` } });
}

/** Rename top-level key `from` to `to`, keeping its position and value. */
export function renameFrontmatterKey(view: EditorView, from: string, to: string) {
  if (!to || from === to) return;
  editFrontmatter(view, (doc) => {
    const map = doc.contents as any;
    if (!map?.items || doc.has(to)) return;
    const pair = map.items.find((p: any) => (p.key?.value ?? p.key) === from);
    if (pair) pair.key = doc.createNode(to);
  });
}

/**
 * `text` with frontmatter key `key` set to `value` (null/undefined/"" removes
 * it; the frontmatter is created or dropped as needed). Other keys keep their
 * formatting.
 */
export function setFrontmatterText(text: string, key: string, value: unknown): string {
  const r = frontmatterRange(text);
  const doc: Document = r ? parseDocument(text.slice(r.from, r.to)) : new Document({});
  const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
  if (empty) doc.delete(key);
  else doc.set(key, doc.createNode(value, { flow: Array.isArray(value) && value.every((x) => typeof x !== "object") && value.length <= 6 }));
  let yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  if (yaml.trim() === "{}" || yaml.trim() === "null") yaml = "";
  if (r) return yaml.trim() ? text.slice(0, r.from) + yaml + text.slice(r.to) : text.slice(r.bodyStart).replace(/^\n/, "");
  return yaml.trim() ? `---\n${yaml}---\n\n${text}` : text;
}
