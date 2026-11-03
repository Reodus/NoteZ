// Built-in plugin: note templates (Obsidian-compatible placeholders).
// Templates are notes in the templates folder; {{title}}, {{date}}, {{time}},
// {{date:YYYY-MM-DD}} and {{time:HH:mm}} are filled in when used.
import type { BuiltinPlugin } from "../core/plugins";
import { prefs, tree, notesList, state, editorView, createNote, pick } from "../core/store";
import { ipc, stem, dirname } from "../core/ipc";
import { notify } from "../core/app";
import { askText } from "../ui/primitives";
import { frontmatterRange, editFrontmatter, readFrontmatter } from "../core/frontmatter";
import { insertText } from "../editor/format";
import { parseDocument } from "yaml";

/** The templates folder: the setting, or a top-level folder named like "Templates". */
export function templatesDir(): string | null {
  if (prefs.templatesFolder.trim()) return prefs.templatesFolder.trim().replace(/^\/+|\/+$/g, "");
  return tree().find((e) => e.is_dir && /(^|[\s_-])templates?$/i.test(e.name))?.path ?? null;
}

function templates(): string[] {
  const dir = templatesDir();
  if (!dir) return [];
  // Skip the folder's own index note (`Templates/Templates.md`).
  return notesList().filter((p) => p.startsWith(dir + "/") && stem(p) !== dir.split("/").pop());
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Moment.js-style date format (the subset Obsidian templates use). */
export function formatDate(d: Date, fmt: string): string {
  return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A|a/g, (t, lit) => {
    if (lit !== undefined) return lit;
    const h12 = d.getHours() % 12 || 12;
    switch (t) {
      case "YYYY": return String(d.getFullYear());
      case "YY": return pad(d.getFullYear() % 100);
      case "MMMM": return MONTHS[d.getMonth()];
      case "MMM": return MONTHS[d.getMonth()].slice(0, 3);
      case "MM": return pad(d.getMonth() + 1);
      case "M": return String(d.getMonth() + 1);
      case "DD": return pad(d.getDate());
      case "D": return String(d.getDate());
      case "dddd": return DAYS[d.getDay()];
      case "ddd": return DAYS[d.getDay()].slice(0, 3);
      case "HH": return pad(d.getHours());
      case "H": return String(d.getHours());
      case "hh": return pad(h12);
      case "h": return String(h12);
      case "mm": return pad(d.getMinutes());
      case "ss": return pad(d.getSeconds());
      case "A": return d.getHours() < 12 ? "AM" : "PM";
      default: return d.getHours() < 12 ? "am" : "pm";
    }
  });
}

export function fillTemplate(text: string, title: string, now = new Date()): string {
  return text.replace(/\{\{\s*(title|date|time)(?::([^}]*))?\s*\}\}/g, (_, k: string, fmt?: string) =>
    k === "title" ? title : formatDate(now, fmt?.trim() || (k === "date" ? "YYYY-MM-DD" : "HH:mm")),
  );
}

async function chooseTemplate(placeholder: string, use: (path: string) => void) {
  const list = templates();
  if (!list.length) {
    const dir = templatesDir();
    notify(dir ? `No templates in "${dir}".` : 'No templates folder. Create a "Templates" folder or set one in Settings → Files.', "error");
    return;
  }
  pick(placeholder, list.map((p) => ({ label: stem(p), detail: dirname(p), run: () => use(p) })));
}

/** Insert a template at the cursor; its frontmatter keys are merged into the note's. */
async function insertTemplate(path: string) {
  const view = editorView();
  if (!view || !state.active) return;
  const text = fillTemplate(await ipc.read(path), stem(state.active));
  const r = frontmatterRange(text);
  if (r && path.endsWith(".md") && !state.active.endsWith(".typ")) {
    const tplProps = parseDocument(text.slice(r.from, r.to)).toJS() ?? {};
    const have = readFrontmatter(view.state.doc.toString());
    const missing = Object.entries(tplProps).filter(([k]) => !(k in have));
    if (missing.length) editFrontmatter(view, (d) => missing.forEach(([k, v]) => d.set(k, v)));
    insertText(view, text.slice(r.bodyStart).replace(/^\n+/, ""));
  } else insertText(view, text);
}

async function newFromTemplate(path: string) {
  const name = await askText("New note from template", "", "Note name");
  if (!name?.trim()) return;
  const tpl = await ipc.read(path);
  const dir = state.active ? dirname(state.active) : "";
  const target = dir === templatesDir() ? "" : dir;
  await createNote(target, name.trim(), path.endsWith(".typ") ? "typ" : "md", (title) => fillTemplate(tpl, title));
}

export const templatesPlugin: BuiltinPlugin = {
  id: "core.templates",
  name: "Templates",
  description: "New notes from templates and inserting templates ({{title}}, {{date:YYYY-MM-DD}}, {{time}}).",
  optional: true,
  onload(api) {
    api.commands.register({ id: "template.new", title: "New note from template…", key: "Mod-Alt-n", run: () => chooseTemplate("Template for the new note…", newFromTemplate) });
    api.commands.register({ id: "template.insert", title: "Insert template…", key: "Mod-Alt-t", run: () => chooseTemplate("Insert template…", insertTemplate) });
  },
};
