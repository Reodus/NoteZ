// Databases (Bases): editing note properties from a view, and editing the
// base's own YAML (views, sort, columns…). Queries run in the core
// (core/src/bases.rs).
import { Document, parseDocument } from "yaml";
import { ipc, BaseCell, stem } from "./ipc";
import { setFrontmatterText } from "./frontmatter";
import { applyText } from "./blocks";
import { app, notify } from "./app";
import { saveAll, state } from "./store";

import { t } from "./i18n";
/** A cell as plain text. */
export function cellText(c: BaseCell): string {
  if (c === null || c === undefined) return "";
  if (typeof c === "boolean") return c ? "✓" : "✗";
  if (typeof c === "number") return Number.isInteger(c) ? String(c) : String(Math.round(c * 1e6) / 1e6);
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(cellText).join(", ");
  return c.text ?? c.date ?? c.duration ?? c.error ?? "";
}

/** What a cell is written as in YAML (for editing it as text). */
export function cellSource(c: BaseCell): string {
  if (c === null || c === undefined) return "";
  if (Array.isArray(c)) return c.map(cellSource).join(", ");
  if (typeof c === "object") {
    if (c.link !== undefined) return `[[${c.target || (c.link ? stem(c.link) : c.text) || ""}]]`;
    return c.date ?? c.duration ?? c.text ?? "";
  }
  return String(c);
}

/**
 * Typed text → a property value: numbers, true/false, lists (when the
 * property was a list or the text has commas and it was empty), else text.
 */
export function parseInput(text: string, like: BaseCell): unknown {
  const t = text.trim();
  if (!t) return null;
  const one = (s: string): unknown => {
    s = s.trim();
    if (/^-?\d+(\.\d+)?$/.test(s) && (typeof like === "number" || like === null || Array.isArray(like))) return Number(s);
    if (/^(true|false)$/i.test(s) && (typeof like === "boolean" || like === null)) return s.toLowerCase() === "true";
    return s;
  };
  if (Array.isArray(like)) return t.split(",").map(one).filter((x) => x !== "");
  return one(t);
}

/** Set (or with null remove) property `key` of note `path`; open notes are edited in place. */
export async function setNoteProperty(path: string, key: string, value: unknown) {
  if (!/\.md$/i.test(path)) {
    notify(t("Only Markdown notes have properties."), "error");
    return;
  }
  const buf = state.buffers[path];
  const text = buf?.content ?? (await ipc.read(path));
  const next = setFrontmatterText(text, key, value);
  if (next === text) return;
  if (buf) {
    applyText(path, next);
    await saveAll();
  } else {
    await ipc.write(path, next);
  }
  app.events.emit("vault:changed", undefined);
}

/** `src` with `edit` applied to its YAML document. */
export function editBase(src: string, edit: (doc: Document) => void): string {
  const doc = src.trim() ? parseDocument(src) : new Document({});
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  if (!doc.contents || typeof doc.contents !== "object") doc.contents = doc.createNode({}) as any;
  edit(doc);
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/** Set `key` of view `vi` (creating the views list); null removes it. */
export function setViewOption(src: string, vi: number, key: string, value: unknown): string {
  return editBase(src, (doc) => {
    if (!doc.has("views")) doc.set("views", doc.createNode([{ type: "table", name: "Table" }]));
    if (!doc.hasIn(["views", vi])) return;
    if (value === null || value === undefined || (Array.isArray(value) && !value.length)) doc.deleteIn(["views", vi, key]);
    else doc.setIn(["views", vi, key], doc.createNode(value, { flow: key === "order" || key === "groupBy" }));
  });
}

export function addView(src: string, type: string, name: string, copyFrom?: number): string {
  return editBase(src, (doc) => {
    if (!doc.has("views")) doc.set("views", doc.createNode([]));
    const base = copyFrom !== undefined ? ((doc.getIn(["views", copyFrom]) as any)?.toJSON?.() ?? {}) : {};
    (doc.get("views") as any).add(doc.createNode({ ...base, type, name }));
  });
}

export function removeView(src: string, vi: number): string {
  return editBase(src, (doc) => {
    doc.deleteIn(["views", vi]);
  });
}

/** Rename view `vi`. */
export const renameView = (src: string, vi: number, name: string) => setViewOption(src, vi, "name", name);

/** A new .base file's text: notes in `folder` (or the whole vault), as a table. */
export function newBaseText(folder: string): string {
  const filter = folder ? `\n  and:\n    - file.inFolder(${JSON.stringify(folder)})\n    - file.ext == "md"` : `\n  and:\n    - file.ext == "md"`;
  return `filters:${filter}\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - file.mtime\n`;
}
