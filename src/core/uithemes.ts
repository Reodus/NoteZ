// UI themes and CSS snippets.
//
// A UI theme is a CSS file that sets the design tokens of src/styles/app.css
// (colors, shadows, syntax colors…) inside `:root { … }`, with a manifest
// comment at the top:
//
//   /* @name Paper
//      @mode light            (light | dark: which base palette it builds on)
//      @description Warm sepia paper.
//      @accent #a0612b */     (optional default accent color)
//   :root { --bg: #f3ecdf; --fg: #3b2f22; … }
//
// The theme is scoped to `:root[data-ui-theme="<id>"]` (CSS nesting: `:root`
// becomes `&`), so other rules in the file only apply while it is active.
// Built-in themes live in src/styles/themes/; user themes in
// `<vault>/.notez/themes/` and `<config>/themes/`. Snippets
// (`.notez/snippets/*.css`, `<config>/snippets/*.css`) are plain CSS added
// as-is when switched on in Settings → Appearance. See docs/UI-THEMES.md.
import { createSignal } from "solid-js";
import { userCss } from "./native";

export interface UiTheme {
  id: string;
  name: string;
  mode: "light" | "dark";
  description: string;
  accent: string | null;
  /** "builtin" | "vault" | "global" */
  source: "builtin" | "vault" | "global";
  css: string;
  path?: string;
}

export interface Snippet {
  id: string;
  source: "vault" | "global";
  css: string;
  path: string;
}

/** Manifest fields from the first comment of a theme file. */
export function parseManifest(css: string): { name?: string; mode?: string; description?: string; accent?: string } {
  const head = /^\s*\/\*([\s\S]*?)\*\//.exec(css)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const m of head.matchAll(/@(name|mode|description|accent)\s+([^\n@]*)/g)) out[m[1]] = m[2].trim();
  return out;
}

/** Lowercase letters, digits and dashes. */
export const themeId = (s: string) => s.toLowerCase().replace(/\.css$/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");

export function makeTheme(id: string, css: string, source: UiTheme["source"], path?: string): UiTheme {
  const m = parseManifest(css);
  return {
    id,
    name: m.name || id,
    mode: m.mode === "dark" ? "dark" : "light",
    description: m.description ?? "",
    accent: m.accent && /^#[0-9a-f]{3,8}$/i.test(m.accent) ? m.accent : null,
    source,
    css,
    path,
  };
}

const BASE: UiTheme[] = [
  { id: "light", name: "Light", mode: "light", description: "The default light theme.", accent: null, source: "builtin", css: "" },
  { id: "dark", name: "Dark", mode: "dark", description: "The default dark theme.", accent: null, source: "builtin", css: "" },
];

const FILES = import.meta.glob("../styles/themes/*.css", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const BUILTIN: UiTheme[] = [
  ...BASE,
  ...Object.entries(FILES)
    .map(([p, css]) => makeTheme(themeId(p.split("/").pop()!), css, "builtin"))
    .sort((a, b) => a.name.localeCompare(b.name)),
];

const [userThemes, setUserThemes] = createSignal<UiTheme[]>([]);
const [snippets, setSnippets] = createSignal<Snippet[]>([]);
export { snippets };

/** Every theme: built-in first, then global, then vault (a vault theme with the same id wins). */
export function allThemes(): UiTheme[] {
  const byId = new Map<string, UiTheme>();
  for (const t of [...BUILTIN, ...userThemes().filter((t) => t.source === "global"), ...userThemes().filter((t) => t.source === "vault")]) {
    byId.set(t.id, t);
  }
  return [...byId.values()];
}

export const themeById = (id: string) => allThemes().find((t) => t.id === id);

/** Read the user's themes and snippets (vault + global config folder). */
export async function loadUserCss(vault: string | null) {
  const files = await userCss(vault).catch(() => []);
  const themes: UiTheme[] = [];
  const snips: Snippet[] = [];
  for (const f of files) {
    const id = themeId(f.name);
    if (!id) continue;
    if (f.kind === "theme") themes.push(makeTheme(id, f.css, f.source, f.path));
    else snips.push({ id, source: f.source, css: f.css, path: f.path });
  }
  setUserThemes(themes);
  setSnippets(snips);
}

/** Theme CSS scoped to its id; `:root` inside becomes the scoped root. */
export function scopedCss(t: UiTheme): string {
  if (!t.css.trim()) return "";
  // @import / @font-face / @charset cannot be nested: keep them at the top.
  const hoisted: string[] = [];
  const body = t.css
    .replace(/@(import|charset)[^;]*;/g, (m) => (hoisted.push(m), ""))
    .replace(/@font-face\s*\{[^}]*\}/g, (m) => (hoisted.push(m), ""))
    .replace(/:root\b/g, "&");
  return `${hoisted.join("\n")}\n:root[data-ui-theme="${t.id}"] {\n${body}\n}\n`;
}

function styleEl(name: string): HTMLStyleElement {
  let el = document.head.querySelector<HTMLStyleElement>(`style[data-notez="${name}"]`);
  if (!el) {
    el = document.createElement("style");
    el.dataset.notez = name;
    document.head.appendChild(el);
  }
  return el;
}

/** Apply a theme (and the enabled snippets) to the document. */
export function applyTheme(t: UiTheme, enabledSnippets: string[]) {
  const root = document.documentElement;
  root.dataset.theme = t.mode;
  root.dataset.uiTheme = t.id;
  styleEl("ui-theme").textContent = scopedCss(t);
  styleEl("snippets").textContent = snippets()
    .filter((s) => enabledSnippets.includes(s.id))
    .map((s) => `/* snippet: ${s.id} */\n${s.css}`)
    .join("\n");
}

/** Light and dark theme options for the pickers. */
export const themesFor = (mode: "light" | "dark") => allThemes().filter((t) => t.mode === mode);
