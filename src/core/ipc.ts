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
  /** 1-based; 0 = the note itself (file name or filters matched). */
  line: number;
  snippet: string;
  /** Matched text inside the snippet (search results only). */
  marks?: string[];
}

/** A link to a note, with the block it sits in. */
export interface Backlink {
  path: string;
  /** 1-based line of the link. */
  line: number;
  /** Plain text of the block that holds the link. */
  snippet: string;
  /** `^id` or heading the link points at, if any. */
  sub: string | null;
  /** `![[…]]`. */
  embed: boolean;
}

/** Text that names a note without linking to it. */
export interface Mention {
  path: string;
  line: number;
  snippet: string;
  /** The matched text and where it is in the line (UTF-16 offsets). */
  text: string;
  at: number;
  len: number;
}

/** A block found by `((` search. */
export interface BlockHit {
  path: string;
  /** 1-based first line. */
  line: number;
  kind: "paragraph" | "heading" | "item" | "task" | "quote" | "callout" | "table" | "code" | "math";
  id: string | null;
  text: string;
}

/** What a link points at: a note, a heading's section or a block. */
export interface Section {
  path: string;
  text: string;
  /** 1-based first and last line. */
  start: number;
  end: number;
}

/** A stored version of a note. */
export interface Version {
  /** Content hash (the version's id). */
  h: string;
  /** When it was recorded (ms). */
  t: number;
  size: number;
  /** edit, first, outside, deleted, restored, before-restore, before-replace, before-tag-rename, before-link-update, before-sync */
  reason: string;
}

export interface DeletedNote {
  path: string;
  h: string;
  t: number;
  size: number;
}

export interface SnapshotInfo {
  id: string;
  t: number;
  label: string;
  auto: boolean;
  files: number;
  size: number;
}

export interface SnapshotChange {
  path: string;
  status: "added" | "removed" | "modified";
}

export interface HistoryConfig {
  enabled: boolean;
  /** Minutes: saves within this window are one version. */
  interval: number;
  keep_days: number;
  max_versions: number;
  keep_snapshots: number;
}

/** Where a vault syncs to (passwords are kept in the system keychain, not here). */
export interface SyncRemote {
  kind: "" | "folder" | "webdav" | "s3";
  /** folder: a path; webdav: a folder URL; s3: the endpoint URL. */
  url: string;
  /** webdav: user name; s3: access key id. */
  user: string;
  /** webdav: password; s3: secret key. */
  password: string;
  bucket: string;
  region: string;
  prefix: string;
}

export interface SyncReport {
  uploaded: string[];
  downloaded: string[];
  deleted_here: string[];
  deleted_there: string[];
  conflicts: string[];
  changed: string[];
  t: number;
  millis: number;
}

export interface ReplaceOpts {
  find: string;
  replace: string;
  regex?: boolean;
  /** Match case. */
  case?: boolean;
  /** Whole words only. */
  word?: boolean;
  /** Note filters (`path:… tag:…`) limiting where to replace. */
  scope?: string;
}

export interface FileChanges {
  path: string;
  lines: {
    line: number;
    before: string;
    after: string;
    count: number;
    /** Each match: start in `before`, text removed, text put in. */
    edits: { at: number; old: string; new: string }[];
  }[];
  count: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

/** Frontmatter-derived note metadata. */
export interface NoteMeta {
  tags: string[];
  icon?: string;
  cover?: string;
  title?: string;
  aliases?: string[];
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
  /** SVG per page; null = unchanged, the caller's page with the same hash. */
  pages: (string | null)[];
  hashes: string[];
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
  /** Deprecated alias of `fonts.arabic`. */
  "font-fa"?: string | null;
  /** Fonts per script: `{ arabic: "Vazirmatn", cjk: "Noto Serif CJK SC", … }`. */
  fonts?: Record<string, string> | null;
  size?: string | null;
  weight?: string | null;
  italic?: boolean | null;
  underline?: boolean | null;
  smallcaps?: boolean | null;
  tracking?: string | null;
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
  /** Digits of page and heading numbers: auto, latin, persian, arabic-indic, devanagari, … */
  digits?: string | null;
  "heading-digits"?: string | null;
}

export interface Theme {
  name?: string | null;
  description?: string | null;
  lang?: string | null;
  /** Language of the Themes dialog thumbnail's sample text. */
  sample?: string | null;
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
  /** Copy a file/folder next to itself ("name 1.ext"); returns the new path. */
  duplicate: (path: string) => invoke<string>("duplicate_entry", { path }),
  search: (query: string, exclude: string[] = []) => invoke<SearchHit[]>("search", { query, exclude }),
  backlinks: (path: string, exclude: string[] = []) => invoke<Backlink[]>("backlinks", { path, exclude }),
  unlinkedMentions: (path: string, exclude: string[] = []) => invoke<Mention[]>("unlinked_mentions", { path, exclude }),
  /** Turn mentions into `[[link]]`s; returns the notes that changed. */
  linkMentions: (link: string, items: Mention[]) => invoke<string[]>("link_mentions", { link, items }),
  /** Blocks matching `query`, those of note `from` first. */
  historyConfig: (config: HistoryConfig) => invoke<boolean>("history_config", { config }),
  /** Versions of a note, newest first. */
  historyList: (path: string) => invoke<Version[]>("history_list", { path }),
  historyText: (hash: string) => invoke<string>("history_text", { hash }),
  /** Put a version back (the current text is kept as a version first). */
  historyRestore: (path: string, hash: string) => invoke<string>("history_restore", { path, hash }),
  historyDeleted: () => invoke<DeletedNote[]>("history_deleted"),
  /** Keep the current text of a note (or every note in a folder) as a version. */
  historyKeep: (path: string, reason: string) => invoke<void>("history_keep", { path, reason }),
  historyCleanup: () => invoke<boolean>("history_cleanup"),
  snapshotCreate: (label: string, auto = false) => invoke<SnapshotInfo | null>("snapshot_create", { label, auto }),
  snapshotList: () => invoke<SnapshotInfo[]>("snapshot_list"),
  snapshotDiff: (id: string) => invoke<SnapshotChange[]>("snapshot_diff", { id }),
  snapshotText: (id: string, path: string) => invoke<string | null>("snapshot_text", { id, path }),
  snapshotRestore: (id: string, paths: string[] | null, removeAdded = false) => invoke<string[]>("snapshot_restore", { id, paths, remove_added: removeAdded }),
  snapshotDelete: (id: string) => invoke<void>("snapshot_delete", { id }),
  syncRun: (remote: SyncRemote, passphrase: string) => invoke<SyncReport>("sync_run", { remote, passphrase }),
  syncTest: (remote: SyncRemote, passphrase: string) => invoke<void>("sync_test", { remote, passphrase }),
  syncStatus: () => invoke<{ last: number; files: number }>("sync_status"),
  syncCleanup: (remote: SyncRemote, passphrase: string) => invoke<number>("sync_cleanup", { remote, passphrase }),
  blockSearch: (query: string, from: string | null, exclude: string[] = []) => invoke<BlockHit[]>("block_search", { query, from, exclude }),
  /** The `^id` of the block at `line` (1-based), added when missing: written to
   * the note, or (when `text` is given) returned as the note's new text. */
  blockId: (path: string, line: number, text?: string, id?: string) =>
    invoke<{ id: string; text: string | null; changed: boolean }>("block_id", { path, line, text: text ?? null, id: id ?? null }),
  /** Resolve a link written in note `from` (`Note#^id`, `Note#Heading`, `#^id`). */
  noteSection: (from: string, link: string) => invoke<Section | null>("note_section", { from, link }),
  replacePreview: (opts: ReplaceOpts, exclude: string[] = []) => invoke<FileChanges[]>("replace_preview", { opts, exclude }),
  /** Replace in `paths` and write them; returns the paths changed. */
  replaceApply: (opts: ReplaceOpts, paths: string[]) => invoke<string[]>("replace_apply", { opts, paths }),
  /** Rename a tag (and nested tags) in every note; returns the paths changed. */
  renameTag: (from: string, to: string) => invoke<string[]>("rename_tag", { from, to }),
  tags: (exclude: string[] = []) => invoke<TagCount[]>("list_tags", { exclude }),
  noteMeta: () => invoke<Record<string, NoteMeta>>("note_meta"),
  /** All note → note links as [from, to] pairs (for the graph). */
  baseQuery: (src: string, view: string | null, thisPath: string | null, exclude: string[] = []) =>
    invoke<BaseResult>("base_query", { src, view, this: thisPath, exclude }),
  queryBlock: (src: string, thisPath: string | null, exclude: string[] = []) => invoke<BaseResult>("query_block", { src, this: thisPath, exclude }),
  /** Notes linking to the PDF `path` (with page / annotation from the link). */
  pdfLinks: (path: string, exclude: string[] = []) =>
    invoke<{ note: string; line: number; text: string; page: number | null; annotation: string | null }[]>("pdf_links", { path, exclude }),
  srsOverview: (settings: SrsSettings, exclude: string[] = []) => invoke<SrsOverview>("srs_overview", { settings, exclude }),
  srsQueue: (deck: string | null, settings: SrsSettings, exclude: string[] = []) => invoke<SrsCard[]>("srs_queue", { deck, settings, exclude }),
  srsGrade: (id: string, grade: 1 | 2 | 3 | 4, settings: SrsSettings) => invoke<SrsSched>("srs_grade", { id, grade, settings }),
  srsRestore: (id: string, prev: SrsSched | null) => invoke<null>("srs_restore", { id, prev }),
  srsStats: (exclude: string[] = []) => invoke<SrsStats>("srs_stats", { exclude }),
  srsLoad: () => invoke<Record<string, SrsSched>>("srs_load"),
  baseEval: (expr: string, path: string) => invoke<unknown>("base_eval", { expr, path }),
  propertyNames: (exclude: string[] = []) => invoke<string[]>("property_names", { exclude }),
  propertyValues: (name: string, exclude: string[] = []) => invoke<string[]>("property_values", { name, exclude }),
  graphLinks: (exclude: string[] = []) => invoke<[string, string][]>("graph_links", { exclude }),
  /** Copy a file into the vault folder `dir` (vault-relative); returns its vault path. */
  importAttachment: (source: string, dir?: string) => invoke<string>("import_attachment", { source, dir }),
  /** Write base64 `data` as `dir/name` (a unique name is chosen); returns its vault path. */
  saveAttachment: (name: string, data: string, dir?: string) => invoke<string>("save_attachment", { name, data, dir }),

  /** `known`: hashes of pages the caller has; those come back as null. */
  renderPreview: (path: string, text: string, blocks: RenderedBlock[], known: string[] = []) =>
    invoke<PreviewResult>("render_preview", { path, text, blocks, known }),
  exportPdf: (path: string, text: string, blocks: RenderedBlock[], output: string) =>
    invoke<void>("export_pdf", { path, text, blocks, output }),
  generatedTypst: (path: string, text: string, blocks: RenderedBlock[]) =>
    invoke<string>("generated_typst", { path, text, blocks }),
  renderBlock: (lang: string, code: string) => invoke<string>("render_block", { lang, code }),
  blockTypst: (lang: string, code: string) => invoke<string>("block_typst", { lang, code }),
  fonts: () => invoke<string[]>("list_fonts"),
  markdownHtml: (text: string) => invoke<string>("markdown_html", { text }),
  startupArgs,
  resolveAsset: (note: string, url: string) => invoke<string | null>("resolve_asset", { note, url }),

  themes: () => invoke<ThemeInfo[]>("list_themes"),
  theme: (id: string) => invoke<Theme>("get_theme", { id }),
  /** First page of a sample note in the theme, as SVG. */
  themeThumbnail: (id: string) => invoke<string>("theme_thumbnail", { id }),
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

/** A cell: plain JSON, or `{date}`, `{duration, ms}`, `{link, text}`, `{error}`. */
export type BaseCell = null | boolean | number | string | BaseCell[] | { date?: string; duration?: string; link?: string | null; target?: string; text?: string; error?: string; [k: string]: unknown };

export interface BaseResult {
  views: { name: string; type: string }[];
  view: number;
  type: string;
  columns: { id: string; name: string; editable: boolean }[];
  rows: { path: string; cells: BaseCell[]; group?: string; group_value?: BaseCell; image?: BaseCell; lines?: [number, string][] }[];
  total: number;
  group_by?: string;
  groups: string[];
  errors: string[];
  options: Record<string, any> | null;
}

export type FileKind = "note" | "image" | "pdf" | "base" | "other";
const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;
/** What a vault file is, by extension. */
export function fileKind(path: string): FileKind {
  if (/\.(md|typ)$/i.test(path)) return "note";
  if (IMAGE_RE.test(path)) return "image";
  if (/\.pdf$/i.test(path)) return "pdf";
  if (/\.base$/i.test(path)) return "base";
  return "other";
}
export const isNotePath = (path: string | null | undefined) => !!path && fileKind(path) === "note";

export function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

// ------------------------------------------------------------- flashcards

export interface SrsSettings {
  retention: number;
  max_interval: number;
  learning_steps: number[];
  relearning_steps: number[];
  new_per_day: number;
  fuzz: boolean;
}
/** state: 0 new, 1 learning, 2 review, 3 relearning; times are Unix ms. */
export interface SrsSched {
  state: number;
  step?: number;
  s?: number;
  d?: number;
  due: number;
  last?: number;
  reps: number;
  lapses: number;
}
export interface SrsCard {
  id: string;
  path: string;
  line: number;
  deck: string;
  kind: "basic" | "reversed" | "cloze";
  front: string;
  back: string;
  state: number;
  due: number;
  /** Next interval per grade (again, hard, good, easy), e.g. "10m", "3d". */
  intervals: [string, string, string, string];
}
export interface SrsOverview {
  decks: { name: string; total: number; new: number; learning: number; due: number }[];
  reviewed_today: number;
  new_left_today: number;
}
export interface SrsStats {
  days: Record<string, number>;
  new: number;
  learning: number;
  young: number;
  mature: number;
  forecast: number[];
  total_reviews: number;
}
