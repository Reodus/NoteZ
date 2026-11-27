// Text-direction rules shared by the editor and its tests, with no editor or
// app imports (scripts/test-dir.ts loads this file in plain Node). The same
// rules are in core/src/render/md.rs (`detect_dir`, `directed`), and
// core/src/render/dir_cases.json checks that both agree on tables.

export type Attrs = Record<string, string>;

/** What explicitDirs needs from a CodeMirror `Text` (1-based lines). */
export interface Lines {
  readonly lines?: number;
  line(n: number): { text: string };
}

/** `{a=1 b="x y" flag}` → { a: "1", b: "x y", flag: "" } */
export function parseAttrs(s: string): Attrs {
  const out: Attrs = {};
  const re = /([^\s=]+)(?:=(?:"([^"]*)"|(\S+)))?/g;
  let m: RegExpExecArray | null;
  const body = s.trim().replace(/^\{/, "").replace(/\}$/, "");
  while ((m = re.exec(body))) out[m[1]] = m[2] ?? m[3] ?? "";
  return out;
}

/** Strong right-to-left characters (same ranges as core/src/render/script.rs). */
export const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

const RTL_LANGS = new Set(["ar", "fa", "ur", "ps", "sd", "ug", "ku", "ckb", "syr", "dv", "nqo", "ks", "bal", "prs", "pnb", "arc", "sam", "mzn", "glk", "lrc", "azb"]);
/** Is `lang` (an ISO 639 code, optionally with a region) right-to-left? */
export const isRtlLang = (lang: string) => RTL_LANGS.has(lang.split(/[-_]/)[0].toLowerCase());

/** Direction of the first strong character of `text`, if any. */
function firstStrong(text: string): "rtl" | "ltr" | null {
  for (const c of text) {
    if (RTL.test(c)) return "rtl";
    if (/\p{L}/u.test(c)) return "ltr";
  }
  return null;
}

/** Is the line right-to-left (see the rule at the top)? */
export function rtlLine(text: string): boolean {
  const first = firstStrong(text);
  if (first !== "ltr") return first === "rtl";
  let rtl = 0;
  let ltr = 0;
  let prev: "rtl" | "ltr" | null = null;
  for (const c of text) {
    if (/\s/.test(c)) {
      prev = null;
      continue;
    }
    const d = RTL.test(c) ? "rtl" : /\p{L}/u.test(c) ? "ltr" : null;
    if (d && d !== prev) {
      if (d === "rtl") rtl++;
      else ltr++;
      prev = d;
    }
  }
  return rtl >= ltr;
}

const DIV_OPEN = /^\s*:::\s*(\{.*\}|\S.*)\s*$/;
const DIV_CLOSE = /^\s*:::\s*$/;

export interface MarkdownDiv {
  open: number;
  close: number | null;
  attrs: Attrs;
  effective: Attrs;
  direction: "rtl" | "ltr" | null;
  parent: MarkdownDiv | null;
}

const divCache = new WeakMap<Lines, { at: (MarkdownDiv | null)[]; markers: Map<number, MarkdownDiv | null> }>();

/** Parse once per document so formatting controls, styling and previews agree. */
export function markdownDivs(doc: Lines, last = doc.lines ?? 0) {
  const cached = doc.lines === undefined ? undefined : divCache.get(doc);
  if (cached) return cached;
  const at: (MarkdownDiv | null)[] = [null];
  const markers = new Map<number, MarkdownDiv | null>();
  const stack: MarkdownDiv[] = [];
  let frontmatter = last > 0 && doc.line(1).text === "---";
  let fence = "";
  for (let n = 1; n <= last; n++) {
    const text = doc.line(n).text;
    const current = stack.at(-1) ?? null;
    at[n] = current;
    if (frontmatter) {
      if (n > 1 && /^(---|\.\.\.)\s*$/.test(text)) frontmatter = false;
      continue;
    }
    const code = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      if (code && code[1][0] === fence[0] && code[1].length >= fence.length && !code[2].trim()) fence = "";
      continue;
    }
    if (code) {
      fence = code[1];
      continue;
    }
    if (DIV_CLOSE.test(text)) {
      markers.set(n, current);
      if (current) {
        current.close = n;
        stack.pop();
      }
      continue;
    }
    const open = DIV_OPEN.exec(text);
    if (open) {
      const attrs = parseAttrs(open[1]);
      const direction: MarkdownDiv["direction"] = attrs.dir === "rtl" || attrs.dir === "ltr" ? attrs.dir
        : attrs.lang ? (isRtlLang(attrs.lang) ? "rtl" : "ltr") : current?.direction ?? null;
      const div = { open: n, close: null, attrs, effective: { ...current?.effective, ...attrs }, direction, parent: current };
      stack.push(div);
      at[n] = div;
      markers.set(n, div);
    }
  }
  const result = { at, markers };
  if (doc.lines === last) divCache.set(doc, result);
  return result;
}

/** Explicit `dir` of the `:::` blocks enclosing each line, from line 1 up to `last`. */
export function explicitDirs(doc: Lines, last: number): ("rtl" | "ltr" | null)[] {
  return markdownDivs(doc, doc.lines ?? last).at.slice(0, last + 1).map(div => div?.direction ?? null);
}

/**
 * Direction forced on line `line` by the `::: {dir=…}` / `::: {lang=…}`
 * blocks around it, or null (then the text decides). Tables use it so the
 * editor and the PDF agree (md.rs `directed`).
 */
export function explicitDirAt(doc: Lines, line: number): "rtl" | "ltr" | null {
  return markdownDivs(doc, doc.lines ?? line).at[line]?.direction ?? null;
}

/**
 * A table's direction: the `::: {dir}` / `{lang}` block around it, else the
 * paragraph rule (rtlLine) over the text of all its cells. The PDF decides
 * the same way (md.rs `directed` on the table's text), so the columns are in
 * the same order in both; core/src/render/dir_cases.json is shared by the
 * two tests (scripts/test-dir.ts, `cargo test table_direction`).
 */
export function tableDir(src: string, explicit: "rtl" | "ltr" | null = null): "rtl" | "ltr" {
  if (explicit) return explicit;
  const prose = src
    .replace(/%%[\s\S]*?%%/g, " ") // comments
    .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, " ") // images: not text
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2") // [[target|alias]] → alias
    .replace(/\]\([^)]*\)/g, "]") // [text](url) → text
    .replace(/\]\{[^}]*\}/g, "]") // [text]{attrs} → text
    .replace(/<[^>]+>|\[\^[^\]]*\]/g, " "); // html tags, footnote refs
  return rtlLine(prose.replace(/[|\n]/g, " ")) ? "rtl" : "ltr";
}
