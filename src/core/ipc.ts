// Typed wrappers around every Rust core command (core/src/lib.rs).
import { invoke, startupArgs } from "./native";

export interface Entry {
  name: string;
  /** Relative to vault root, '/'-separated. */
  path: string;
  is_dir: boolean;
  children: Entry[];
}

export interface SearchHit {
  path: string;
  /** 1-based; 0 = file name matched. */
  line: number;
  snippet: string;
}

export interface LinkInfo {
  path: string;
  aliases: string[];
  headings: string[];
}

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  hints: string[];
  line: number | null;
  column: number | null;
  file: string | null;
}

export interface PreviewResult {
  pages: string[];
  diagnostics: Diagnostic[];
  millis: number;
  notes: string[];
}

export interface RenderedBlock {
  lang: string;
  code: string;
  typst: string;
}

export interface TextStyle {
  font?: string | null;
  "font-fa"?: string | null;
  size?: string | null;
  weight?: string | null;
  italic?: boolean | null;
  underline?: boolean | null;
  color?: string | null;
  align?: string | null;
  "line-spacing"?: number | null;
  "space-before"?: string | null;
  "space-after"?: string | null;
  indent?: string | null;
  numbering?: string | null;
  background?: string | null;
  border?: string | null;
}

export interface HeaderFooter {
  left?: string | null;
  center?: string | null;
  right?: string | null;
  line?: boolean | null;
}

export interface PageStyle {
  paper?: string | null;
  orientation?: string | null;
  margin?: string | null;
  columns?: number | null;
  header?: HeaderFooter | null;
  footer?: HeaderFooter | null;
  "skip-first"?: boolean | null;
  numbering?: string | null;
  background?: string | null;
  "heading-digits"?: string | null;
}

export interface Theme {
  name?: string | null;
  description?: string | null;
  lang?: string | null;
  page: PageStyle;
  styles: Record<string, TextStyle>;
}

export interface ThemeInfo {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  customized: boolean;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
}

export const ipc = {
  openVault: (path: string) => invoke<Entry[]>("open_vault", { path }),
  tree: () => invoke<Entry[]>("list_tree"),
  notes: () => invoke<string[]>("list_notes"),
  read: (path: string) => invoke<string>("read_note", { path }),
  write: (path: string, content: string) => invoke<void>("write_note", { path, content }),
  createNote: (path: string) => invoke<void>("create_note", { path }),
  createFolder: (path: string) => invoke<void>("create_folder", { path }),
  /** Rename/move; with `updateLinks`, rewrites links to it. Returns the notes rewritten. */
  rename: (from: string, to: string, updateLinks = false) => invoke<string[]>("rename_entry", { from, to, update_links: updateLinks }),
  /** How many notes link to `path` (or into it, for a folder). */
  linkRefs: (path: string) => invoke<number>("link_refs", { path }),
  linkInfo: () => invoke<LinkInfo[]>("link_info"),
  indexUpdate: (paths: string[]) => invoke<void>("index_update", { paths }),
  remove: (path: string) => invoke<void>("delete_entry", { path }),
  search: (query: string, exclude: string[] = []) => invoke<SearchHit[]>("search", { query, exclude }),
  backlinks: (path: string) => invoke<SearchHit[]>("backlinks", { path }),
  /** All note → note links as [from, to] pairs (for the graph). */
  graphLinks: (exclude: string[] = []) => invoke<[string, string][]>("graph_links", { exclude }),
  /** Copy a file into the vault folder `dir` (vault-relative); returns its vault path. */
  importAttachment: (source: string, dir?: string) => invoke<string>("import_attachment", { source, dir }),
  /** Write base64 `data` as `dir/name` (a unique name is chosen); returns its vault path. */
  saveAttachment: (name: string, data: string, dir?: string) => invoke<string>("save_attachment", { name, data, dir }),

  renderPreview: (path: string, text: string, blocks: RenderedBlock[]) =>
    invoke<PreviewResult>("render_preview", { path, text, blocks }),
  exportPdf: (path: string, text: string, blocks: RenderedBlock[], output: string) =>
    invoke<void>("export_pdf", { path, text, blocks, output }),
  generatedTypst: (path: string, text: string, blocks: RenderedBlock[]) =>
    invoke<string>("generated_typst", { path, text, blocks }),
  renderBlock: (lang: string, code: string) => invoke<string>("render_block", { lang, code }),
  blockTypst: (lang: string, code: string) => invoke<string>("block_typst", { lang, code }),
  fonts: () => invoke<string[]>("list_fonts"),
  startupArgs,
  resolveAsset: (note: string, url: string) => invoke<string | null>("resolve_asset", { note, url }),

  themes: () => invoke<ThemeInfo[]>("list_themes"),
  theme: (id: string) => invoke<Theme>("get_theme", { id }),
  noteTheme: (path: string, text: string) => invoke<Theme>("note_theme", { path, text }),
  saveTheme: (id: string, theme: Theme) => invoke<void>("save_theme", { id, theme }),
  resetTheme: (id: string) => invoke<void>("reset_theme", { id }),

  plugins: () => invoke<PluginManifest[]>("list_plugins"),
  pluginSource: (id: string) => invoke<string>("read_plugin", { id }),
};

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function stem(path: string): string {
  return basename(path).replace(/\.(md|typ)$/, "");
}

export function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}
