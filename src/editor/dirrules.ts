// Text-direction rules shared by the editor and its tests, with no editor or
// app imports (scripts/test-dir.ts loads this file in plain Node). The same
// rules are in core/src/render/md.rs (`detect_dir`, `directed`), and
// core/src/render/dir_cases.json checks that both agree on tables.

export type Attrs = Record<string, string>;

/** What explicitDirs needs from a CodeMirror `Text` (1-based lines). */
export interface Lines {
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

/** Explicit `dir` of the `:::` blocks enclosing each line, from line 1 up to `last`. */
export function explicitDirs(doc: Lines, last: number): ("rtl" | "ltr" | null)[] {
  const out: ("rtl" | "ltr" | null)[] = [null];
  const stack: ("rtl" | "ltr" | null)[] = [];
  let inFence = false;
  for (let i = 1; i <= last; i++) {
    const text = doc.line(i).text;
    const cur = stack.length ? stack[stack.length - 1] : null;
    out.push(cur);
    if (/^\s*(```|~~~)/.test(text)) inFence = !inFence;
    if (inFence) continue;
    if (DIV_CLOSE.test(text)) stack.pop();
    else {
      const m = DIV_OPEN.exec(text);
      if (m) {
        const a = parseAttrs(m[1]);
        const d = a.dir === "rtl" || a.dir === "ltr" ? a.dir : a.lang ? (isRtlLang(a.lang) ? "rtl" : "ltr") : cur;
        stack.push(d);
      }
    }
  }
  return out;
}

/**
 * Direction forced on line `line` by the `::: {dir=…}` / `::: {lang=…}`
 * blocks around it, or null (then the text decides). Tables use it so the
 * editor and the PDF agree (md.rs `directed`).
 */
export function explicitDirAt(doc: Lines, line: number): "rtl" | "ltr" | null {
  return explicitDirs(doc, line)[line] ?? null;
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
