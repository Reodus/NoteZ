// Completion as you type, besides [[links]] and the "/" menu:
//   #tag            tags used in the vault
//   :emoji          emoji by name (:smile → 😄)
//   ```lang         code block languages
//   > [!type        callout types
//   frontmatter     property names, and values of theme / lang / tags
//   {{              template variables (in the templates folder)
//   #func           Typst functions (in .typ notes)
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { allTags } from "../core/meta";
import { ipc } from "../core/ipc";
import { state } from "../core/store";
import { app } from "../core/app";
import { LANGUAGE_CODES, languageLabel } from "../core/languages";
import { CALLOUTS } from "./livepreview";
import { findEmoji } from "./emoji";
import { frontmatterRange } from "../core/frontmatter";
import { templatesDir } from "../plugins/templates";

/** Languages offered after ``` (special NoteZ blocks first). */
export const FENCE_LANGUAGES = [
  "chart", "mermaid", "flow", "mindmap", "timeline", "diagram", "draw", "math", "base", "query",
  "python", "javascript", "typescript", "jsx", "tsx", "json", "yaml", "toml", "xml", "html", "css", "scss",
  "bash", "sh", "zsh", "fish", "powershell", "bat", "c", "cpp", "csharp", "java", "kotlin", "scala", "go", "rust",
  "swift", "objectivec", "dart", "ruby", "php", "perl", "lua", "r", "julia", "matlab", "haskell", "ocaml", "fsharp",
  "elixir", "erlang", "clojure", "lisp", "scheme", "zig", "nim", "d", "fortran", "pascal", "vb", "sql", "graphql",
  "dockerfile", "makefile", "cmake", "nginx", "ini", "diff", "latex", "tex", "typst", "markdown", "text",
  "asm", "nasm", "masm", "x86", "x64", "x86asm", "gas", "arm", "armasm", "arm64", "aarch64", "riscv", "riscv64", "mips", "avr", "wasm", "llvm",
  "verilog", "vhdl", "solidity", "protobuf",
];

/** Start of a "word" for tags/emoji: line start or after a space or bracket. */
const boundary = (ctx: CompletionContext, from: number) => from === ctx.state.doc.lineAt(from).from || /[\s([{,]/.test(ctx.state.sliceDoc(from - 1, from));

/** Inside a fenced code block or inline code? */
function inCode(ctx: CompletionContext): boolean {
  const line = ctx.state.doc.lineAt(ctx.pos);
  let open = false;
  for (let n = Math.max(1, line.number - 400); n < line.number; n++) if (/^\s*(```|~~~)/.test(ctx.state.doc.line(n).text)) open = !open;
  if (open) return true;
  const before = line.text.slice(0, ctx.pos - line.from);
  return (before.match(/`/g)?.length ?? 0) % 2 === 1;
}

function inFrontmatter(ctx: CompletionContext): boolean {
  const r = frontmatterRange(ctx.state.sliceDoc(0, Math.min(ctx.state.doc.length, 20000)));
  return !!r && ctx.pos >= r.from && ctx.pos <= r.to;
}

const isTyp = () => !!state.active?.endsWith(".typ");

// ---------------------------------------------------------------- sources

function tagSource(ctx: CompletionContext): CompletionResult | null {
  if (isTyp() || inFrontmatter(ctx)) return null;
  const m = ctx.matchBefore(/#[\p{L}\p{N}_\-/]*$/u);
  if (!m || !boundary(ctx, m.from) || inCode(ctx)) return null;
  // "#" alone at the start of a line is a heading being typed.
  if (m.text === "#" && m.from === ctx.state.doc.lineAt(m.from).from && !ctx.explicit) return null;
  const tags = allTags();
  if (!tags.length) return null;
  return {
    from: m.from + 1,
    options: tags.map((t) => ({ label: t.tag, detail: String(t.count), type: "keyword" })),
    validFor: /^[\p{L}\p{N}_\-/]*$/u,
  };
}

function emojiSource(ctx: CompletionContext): CompletionResult | null {
  const m = ctx.matchBefore(/:[a-z0-9_+-]{2,}$/);
  if (!m || !boundary(ctx, m.from) || inCode(ctx)) return null;
  const found = findEmoji(m.text.slice(1));
  if (!found.length) return null;
  return {
    from: m.from,
    filter: false,
    options: found.map(([name, e]): Completion => ({ label: `${e}  :${name}:`, apply: e, type: "text" })),
  };
}

function fenceSource(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const m = /^(\s*(?:```|~~~))([\w+#-]*)$/.exec(line.text.slice(0, ctx.pos - line.from));
  if (!m || isTyp()) return null;
  return {
    from: line.from + m[1].length,
    options: FENCE_LANGUAGES.map((l, i) => ({ label: l, type: "type", boost: i < 8 ? 1 : 0 })),
    validFor: /^[\w+#-]*$/,
  };
}

function calloutSource(ctx: CompletionContext): CompletionResult | null {
  const m = ctx.matchBefore(/^\s*>\s*\[![\w-]*$/);
  if (!m || isTyp()) return null;
  const from = m.from + m.text.indexOf("[!") + 2;
  const closed = ctx.state.sliceDoc(ctx.pos, ctx.pos + 1) === "]";
  return {
    from,
    options: Object.entries(CALLOUTS).map(([type, c]): Completion => ({
      label: type,
      detail: `${c.icon} ${c.label}`,
      apply: (view: EditorView, _c: Completion, f: number, t: number) => {
        const insert = type.toUpperCase() + (closed ? "" : "] ");
        view.dispatch({ changes: { from: f, to: t, insert }, selection: { anchor: f + insert.length + (closed ? 2 : 0) } });
      },
    })),
    validFor: /^[\w-]*$/,
  };
}

/** Frontmatter keys NoteZ (and Obsidian) understand. */
const FM_KEYS: [string, string][] = [
  ["title", "Document title"], ["subtitle", "Shown under the title"], ["author", "Author"], ["date", "Date (today = today)"],
  ["tags", "Tags: [a, b]"], ["aliases", "Other names for links"], ["lang", "Language (en, ar, ja…)"],
  ["theme", "Document theme"], ["icon", "Emoji shown with the note"], ["cover", "Banner image"],
  ["cssclasses", "CSS classes"], ["description", "Summary"], ["status", "Your own property"],
  ["page", "Page setup (PDF themes)"], ["styles", "Paragraph styles (PDF themes)"], ["digits", "Digits (page: digits)"],
];

let themeIds: Promise<string[]> | null = null;

async function frontmatterSource(ctx: CompletionContext): Promise<CompletionResult | null> {
  if (isTyp() || !inFrontmatter(ctx)) return null;
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  if (/^---/.test(line.text)) return null;
  // A key at the start of a line.
  const key = /^([\w-]*)$/.exec(before);
  if (key) {
    const doc = ctx.state.sliceDoc(0, ctx.pos);
    return {
      from: line.from,
      options: FM_KEYS.filter(([k]) => !new RegExp(`^${k}:`, "m").test(doc)).map(([k, d]): Completion => ({
        label: k, detail: d, type: "property", apply: `${k}: `,
      })),
      validFor: /^[\w-]*$/,
    };
  }
  // A value: "key: val", "key: [a, val", or "  - val" under tags.
  const kv = /^([\w-]+):\s*(?:\[(?:[^\]]*,\s*)?)?([^,\]]*)$/.exec(before);
  let k = kv?.[1];
  let typed = kv?.[2] ?? "";
  if (!kv) {
    const item = /^\s*-\s+(.*)$/.exec(before);
    if (!item) return null;
    // The key this list belongs to: nearest unindented "key:" above.
    for (let n = line.number - 1; n >= 1; n--) {
      const t = ctx.state.doc.line(n).text;
      const km = /^([\w-]+):/.exec(t);
      if (km) {
        k = km[1];
        break;
      }
    }
    typed = item[1];
  }
  let values: Completion[] = [];
  if (k === "theme") {
    themeIds ??= ipc.themes().then((t) => t.map((x) => x.id)).catch(() => []);
    values = (await themeIds).map((id) => ({ label: id, type: "enum" }));
    setTimeout(() => (themeIds = null), 5000);
  } else if (k === "lang") {
    values = [{ label: "auto", detail: "detect from the text" }, ...LANGUAGE_CODES.map((c) => ({ label: c, detail: languageLabel(c) }))];
  } else if (k === "tags" || k === "tag") {
    values = allTags().map((t) => ({ label: t.tag, detail: String(t.count) }));
  } else if (k === "date") {
    values = [{ label: "today" }];
  } else return null;
  return { from: ctx.pos - typed.length, options: values, validFor: /^[\p{L}\p{N}_\-/]*$/u };
}

function templateVarSource(ctx: CompletionContext): CompletionResult | null {
  const dir = templatesDir();
  if (!dir || !state.active?.startsWith(dir + "/")) return null;
  const m = ctx.matchBefore(/\{\{[\w:-]*$/);
  if (!m) return null;
  const closed = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2) === "}}";
  const v = (label: string, detail: string): Completion => ({ label, detail, apply: label + (closed ? "" : "}}"), type: "variable" });
  return {
    from: m.from + 2,
    options: [
      v("title", "the new note's name"),
      v("date", "today, YYYY-MM-DD"),
      v("time", "now, HH:mm"),
      v("date:YYYY-MM-DD", "date in a format"),
      v("date:dddd, D MMMM YYYY", "e.g. Monday, 9 November 2026"),
      v("time:HH:mm:ss", "time in a format"),
    ],
    validFor: /^[\w:-]*$/,
  };
}

const TYPST_FUNCS: [string, string][] = [
  ["set", "set rule"], ["show", "show rule"], ["let", "variable or function"], ["import", "import a module"], ["include", "include a file"],
  ["if", "condition"], ["for", "loop"], ["while", "loop"], ["context", "contextual value"],
  ["heading", "(level: 1)[…]"], ["text", "(font:, size:, fill:)[…]"], ["par", "(justify:, leading:)"], ["page", "(paper:, margin:)"],
  ["document", "(title:, author:)"], ["strong", "[…]"], ["emph", "[…]"], ["underline", "[…]"], ["strike", "[…]"], ["highlight", "[…]"],
  ["smallcaps", "[…]"], ["sub", "[…]"], ["super", "[…]"], ["link", "(url)[…]"], ["ref", "(<label>)"], ["cite", "(<key>)"],
  ["footnote", "[…]"], ["image", "(path, width:)"], ["figure", "(…, caption: […])"], ["table", "(columns:, …)"], ["grid", "(columns:, …)"],
  ["list", "(…)"], ["enum", "(…)"], ["terms", "(…)"], ["raw", "(text, lang:)"], ["box", "(…)[…]"], ["block", "(…)[…]"],
  ["align", "(center)[…]"], ["pad", "(x:, y:)[…]"], ["stack", "(dir:, …)"], ["columns", "(2)[…]"], ["colbreak", "()"], ["pagebreak", "()"],
  ["v", "(1em) vertical space"], ["h", "(1em) horizontal space"], ["line", "(length:)"], ["rect", "(…)"], ["circle", "(…)"], ["ellipse", "(…)"],
  ["polygon", "(…)"], ["place", "(top + right)[…]"], ["move", "(dx:, dy:)[…]"], ["rotate", "(45deg)[…]"], ["scale", "(x:, y:)[…]"],
  ["outline", "() table of contents"], ["bibliography", "(\"refs.bib\")"], ["counter", "(heading)"], ["numbering", "(\"1.\", n)"],
  ["datetime", ".today()"], ["lorem", "(50)"], ["rgb", "(\"#hex\")"], ["luma", "(gray)"], ["cmyk", "(…)"], ["upper", "(…)"], ["lower", "(…)"],
  ["repeat", "[…]"], ["layout", "(size => …)"], ["measure", "(…)"], ["query", "(selector)"], ["state", "(key, init)"], ["eval", "(code)"],
  ["read", "(path)"], ["csv", "(path)"], ["json", "(path)"], ["yaml", "(path)"], ["toml", "(path)"], ["xml", "(path)"], ["calc", ".…"],
];

function typstSource(ctx: CompletionContext): CompletionResult | null {
  if (!isTyp()) return null;
  const m = ctx.matchBefore(/#[a-z][\w-]*$/);
  if (!m || inCode(ctx)) return null;
  return {
    from: m.from + 1,
    options: TYPST_FUNCS.map(([f, d]) => ({ label: f, detail: d, type: ["set", "show", "let", "import", "include", "if", "for", "while", "context"].includes(f) ? "keyword" : "function" })),
    validFor: /^[\w-]*$/,
  };
}

/** Sources registered by plugins (api.editor.registerCompletion). */
async function pluginSources(ctx: CompletionContext): Promise<CompletionResult | null> {
  for (const { source } of app.completions.items()) {
    const r = await source(ctx);
    if (r) return r;
  }
  return null;
}

export const COMPLETION_SOURCES: CompletionSource[] = [
  fenceSource, calloutSource, frontmatterSource, templateVarSource, typstSource, emojiSource, tagSource, pluginSources,
];
