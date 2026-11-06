// Pasting keeps formatting: rich clipboard content (web pages, rendered
// Markdown, Word/Google Docs, Obsidian's reading view…) arrives as HTML and is
// converted to Markdown; plain text copied from a PDF (one hard line break per
// visual line) is joined back into paragraphs. Ctrl+Shift+V pastes the plain
// text exactly as copied.
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import TurndownService from "turndown";
import { isTypst } from "./format";

let service: TurndownService | null = null;

const md = (html: string) => turndown().turndown(html);

/** TeX source of a KaTeX / MathML formula element, if any. */
function texOf(node: HTMLElement): string | null {
  const ann = node.querySelector('annotation[encoding="application/x-tex"]');
  if (ann?.textContent) return ann.textContent.trim();
  const alt = node.getAttribute("alttext") ?? node.querySelector("math")?.getAttribute("alttext");
  // Wikipedia wraps formulas in {\displaystyle …}.
  return alt ? alt.replace(/^\{\\displaystyle\s*([\s\S]*)\}$/, "$1").trim() : null;
}

const isDisplayMath = (node: HTMLElement) =>
  node.classList.contains("katex-display") ||
  !!node.closest(".katex-display") ||
  node.getAttribute("display") === "block" ||
  node.querySelector("math")?.getAttribute("display") === "block";

/** One cell's Markdown, kept on one line. */
const cellMd = (cell: HTMLElement) =>
  md(cell.innerHTML)
    .trim()
    .replace(/ *\n+ */g, "<br>")
    .replace(/\|/g, "\\|");

function tableMd(table: HTMLTableElement): string {
  const rows = [...table.rows].map((tr) => [...tr.cells] as HTMLElement[]);
  if (!rows.length) return "";
  const n = Math.max(...rows.map((r) => r.length));
  const cells = rows.map((r) => [...r.map(cellMd), ...Array(n - r.length).fill("")]);
  const align = (rows[0] ?? []).map((c) => (c.getAttribute("align") ?? c.style.textAlign ?? "").toLowerCase());
  const sep = Array.from({ length: n }, (_, i) =>
    align[i] === "center" ? ":---:" : align[i] === "right" ? "---:" : align[i] === "left" ? ":---" : "---",
  );
  const line = (r: string[]) => `| ${r.join(" | ")} |`;
  return `\n\n${[line(cells[0]), line(sep), ...cells.slice(1).map(line)].join("\n")}\n\n`;
}

/** The style of an inline element as Markdown marks (Google Docs uses spans). */
function styleMarks(el: HTMLElement): [string, string] {
  const st = el.style;
  const marks: string[] = [];
  const w = st.fontWeight;
  if (w === "bold" || Number(w) >= 600) marks.push("**");
  if (st.fontStyle === "italic") marks.push("*");
  if (/line-through/.test(st.textDecoration || st.textDecorationLine)) marks.push("~~");
  return [marks.join(""), [...marks].reverse().join("")];
}

function turndown(): TurndownService {
  if (service) return service;
  const td = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  td.remove(["style", "script", "meta", "title", "head", "noscript", "template"]);

  // Rules added later win over earlier ones and over the built-ins.
  // List items as "- x" / "1. x" (turndown pads markers to four columns).
  td.addRule("list-item", {
    filter: "li",
    replacement: (content, node, options) => {
      const parent = node.parentNode as HTMLElement | null;
      let prefix = `${options.bulletListMarker} `;
      if (parent?.nodeName === "OL") {
        const start = Number(parent.getAttribute("start") ?? 1);
        prefix = `${start + Array.prototype.indexOf.call(parent.children, node)}. `;
      }
      const indent = " ".repeat(prefix.length);
      const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, `\n${indent}`);
      return prefix + body + (node.nextSibling && !/\n$/.test(body) ? "\n" : "");
    },
  });
  td.addRule("pre-no-code", {
    filter: (n) => n.nodeName === "PRE" && n.firstElementChild?.nodeName !== "CODE",
    replacement: (_c, n) => {
      const el = n as HTMLElement;
      const lang = /(?:language|lang|highlight-source)-([\w+-]+)/.exec(`${el.className} ${el.parentElement?.className ?? ""}`)?.[1] ?? "";
      return `\n\n\`\`\`${lang}\n${(el.textContent ?? "").replace(/\n$/, "")}\n\`\`\`\n\n`;
    },
  });
  td.addRule("strike", { filter: ["del", "s", "strike"] as any, replacement: (c) => (c.trim() ? `~~${c}~~` : c) });
  td.addRule("mark", { filter: "mark", replacement: (c) => (c.trim() ? `==${c}==` : c) });
  td.addRule("underline", { filter: ["u", "ins"] as any, replacement: (c) => (c.trim() ? `<u>${c}</u>` : c) });
  td.addRule("sup-sub", { filter: ["sup", "sub"], replacement: (c, n) => `<${n.nodeName.toLowerCase()}>${c}</${n.nodeName.toLowerCase()}>` });
  td.addRule("checkbox", {
    filter: (n) => n.nodeName === "INPUT" && (n as HTMLInputElement).type === "checkbox",
    replacement: (_c, n) => ((n as HTMLInputElement).checked ? "[x] " : "[ ] "),
  });
  td.addRule("image", {
    filter: "img",
    replacement: (_c, n) => {
      const img = n as HTMLImageElement;
      const src = img.getAttribute("src") ?? "";
      // Formula fallback pictures (Wikipedia) and inline data blobs are dropped.
      if (!src || src.startsWith("data:") || /math-fallback/.test(img.className)) return "";
      const alt = (img.getAttribute("alt") ?? "").replace(/[\[\]\n]/g, " ").trim();
      return `![${alt}](${src.replace(/ /g, "%20")})`;
    },
  });
  td.addRule("table", { filter: "table", replacement: (_c, n) => tableMd(n as HTMLTableElement) });
  td.addRule("styled-span", {
    filter: (n) => n.nodeName === "SPAN" && !!(n as HTMLElement).getAttribute("style"),
    replacement: (c, n) => {
      if (!c.trim()) return c;
      const [o, cl] = styleMarks(n as HTMLElement);
      if (!o) return c;
      // Markers hug the text, spaces stay outside.
      const lead = /^\s*/.exec(c)![0];
      const trail = /\s*$/.exec(c)![0];
      return `${lead}${o}${c.trim()}${cl}${trail}`;
    },
  });
  // Google Docs wraps the whole selection in <b style="font-weight:normal">.
  td.addRule("gdocs-wrapper", {
    filter: (n) => n.nodeName === "B" && (/^docs-internal-guid/.test((n as HTMLElement).id) || (n as HTMLElement).style.fontWeight === "normal"),
    replacement: (c) => c,
  });
  td.addRule("callout", {
    filter: (n) => n.nodeName === "DIV" && (n as HTMLElement).hasAttribute("data-callout"),
    replacement: (_c, n) => {
      const el = n as HTMLElement;
      const type = el.getAttribute("data-callout") ?? "note";
      const fold = el.getAttribute("data-callout-fold") ?? "";
      const title = el.querySelector(".callout-title-inner")?.textContent?.trim() ?? "";
      const content = el.querySelector(".callout-content");
      const body = content ? md(content.innerHTML).trim() : "";
      const lines = [`[!${type}]${fold}${title ? " " + title : ""}`, ...(body ? body.split("\n") : [])];
      return `\n\n${lines.map((l) => (l ? `> ${l}` : ">")).join("\n")}\n\n`;
    },
  });
  td.addRule("math", {
    filter: (n) => {
      const el = n as HTMLElement;
      if (n.nodeName === "MATH") return !el.closest(".katex, .mwe-math-element") && !!texOf(el);
      return (el.classList?.contains("katex") || el.classList?.contains("katex-display") || el.classList?.contains("mwe-math-element")) && !!texOf(el);
    },
    replacement: (_c, n) => {
      const el = n as HTMLElement;
      const tex = texOf(el)!;
      return isDisplayMath(el) ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
    },
  });
  // KaTeX's display wrapper holds a .katex inside: handle it once, at the wrapper.
  td.addRule("katex-inner", {
    filter: (n) => (n as HTMLElement).classList?.contains("katex") && !!(n as HTMLElement).parentElement?.classList.contains("katex-display"),
    replacement: (c) => c,
  });
  service = td;
  return td;
}

/** Elements that carry formatting worth converting. */
const RICH = "h1,h2,h3,h4,h5,h6,b,strong,em,i,a,ul,ol,li,table,blockquote,pre,code,img,mark,s,del,strike,u,math,hr,sup,sub,.katex,[data-callout],span[style*=bold],span[style*=italic],span[style*='font-weight:7'],span[style*='font-weight: 7'],span[style*=line-through]";

/**
 * Markdown for a pasted HTML fragment, or null to use the plain text instead
 * (no real formatting, or HTML from a code editor such as VS Code, whose
 * plain text is the source itself).
 */
export function htmlToMarkdown(html: string, plain: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  if (!body || !body.querySelector(RICH)) return null;
  // Code editors put the text in a monospace / pre-formatted box.
  const box = body.querySelector("div[style], pre[style]") as HTMLElement | null;
  if (box && /white-space:\s*pre|monospace|Consolas|Menlo|Courier|Mono/i.test(box.getAttribute("style") ?? "") && !body.querySelector("h1,h2,h3,p,li,table")) return null;
  let out = md(body.innerHTML)
    .replace(/ /g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!out) return null;
  if (out === plain.trim()) return null;
  // A single plain word or phrase with nothing but a wrapper around it.
  if (!/[*_`~=\[#>|$<]|^\s*[-\d]/m.test(out) && !out.includes("\n")) return null;
  return out;
}

// --------------------------------------------------------------- PDFs

const LIST = /^([•●▪◦‣∙·○■□➢►*-]|\(?\d{1,3}[.)]|\(?[۰-۹]{1,3}[.)]|[a-z][.)])\s+/;
const SENTENCE_END = /[.!?:;؟؛…»"”')\]]$/;

/** Plain text that looks like it was copied from a PDF (hard-wrapped lines). */
export function looksLikePdf(text: string): boolean {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
  const filled = lines.filter(Boolean);
  if (filled.length < 3) return false;
  // Markdown or code: leave alone.
  if (/^\s*(#{1,6}\s|\||```|~~~|>|\$\$|- \[[ xX]\]|<\w)/m.test(text) || /\[\[|\]\(/.test(text)) return false;
  const lens = filled.map((l) => l.length).sort((a, b) => a - b);
  const median = lens[lens.length >> 1];
  if (median < 25) return false;
  let pairs = 0;
  let soft = 0;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i] || !lines[i + 1] || LIST.test(lines[i + 1])) continue;
    pairs++;
    if (!SENTENCE_END.test(lines[i])) soft++;
  }
  return pairs >= 2 && soft / pairs >= 0.4;
}

/** Join hard-wrapped PDF lines into paragraphs; keep list items as a list. */
export function reflowPdfText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
  const lens = lines.filter(Boolean).map((l) => l.length).sort((a, b) => a - b);
  const width = lens[Math.floor(lens.length * 0.75)] ?? 0;
  const blocks: { text: string; list: boolean }[] = [];
  let cur: { text: string; list: boolean } | null = null;
  let prevLen = 0;
  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  for (const l of lines) {
    if (!l) {
      flush();
      continue;
    }
    const bullet = LIST.exec(l);
    if (bullet) {
      flush();
      const symbol = /^[•●▪◦‣∙·○■□➢►*-]/.test(l);
      cur = { text: symbol ? "- " + l.slice(bullet[0].length) : l, list: true };
    } else if (!cur) {
      cur = { text: l, list: false };
    } else if (SENTENCE_END.test(cur.text) && prevLen < width * 0.8) {
      // A short line that ends a sentence ends its paragraph.
      flush();
      cur = { text: l, list: false };
    } else if (/[A-Za-z]-$/.test(cur.text) && /^[a-z]/.test(l)) {
      cur.text = cur.text.slice(0, -1) + l; // re-join a hyphenated word
    } else {
      cur.text += " " + l;
    }
    prevLen = l.length;
  }
  flush();
  let out = "";
  blocks.forEach((b, i) => {
    if (i) out += b.list && blocks[i - 1].list ? "\n" : "\n\n";
    out += b.text.replace(/\s{2,}/g, " ");
  });
  return out;
}

// ------------------------------------------------------------- handler

function insert(view: EditorView, text: string) {
  view.dispatch(
    view.state.changeByRange((r) => ({
      changes: { from: r.from, to: r.to, insert: text },
      range: EditorSelection.cursor(r.from + text.length),
    })),
    { userEvent: "input.paste", scrollIntoView: true },
  );
}

export const richPaste = EditorView.domEventHandlers({
  paste(e, view) {
    const dt = e.clipboardData;
    if (!dt || dt.files.length) return false;
    const html = dt.getData("text/html");
    const plain = dt.getData("text/plain");
    let text: string | null = null;
    if (html && !isTypst()) {
      try {
        text = htmlToMarkdown(html, plain);
      } catch (err) {
        console.warn("HTML paste conversion failed", err);
      }
    }
    if (text == null && !html && plain && looksLikePdf(plain)) text = reflowPdfText(plain);
    if (text == null) return false;
    e.preventDefault();
    insert(view, text);
    return true;
  },
});
