// Notion-style "/" menu: type `/` at the start of a line (or after a space)
// to insert headings, lists, tables, callouts, charts, diagrams…
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import {
  setBlockStyle, toggleList, insertBlock, insertTable, insertMath, insertPageBreak, insertToc,
  insertFootnote, insertFenced, insertLink, isTypst,
} from "./format";
import { TEMPLATES } from "../ui/DiagramGallery";
import { setDialog } from "../core/store";

interface SlashItem {
  title: string;
  icon: string;
  section: string;
  /** Extra search words (English + Persian). */
  keys: string;
  hint?: string;
  run: (view: EditorView) => void;
  mdOnly?: boolean;
}

const tpl = (id: string) => TEMPLATES.find((t) => t.id === id)!;
const diagram = (id: string) => (v: EditorView) => {
  const t = tpl(id);
  insertFenced(v, t.lang, t.code);
};

const ITEMS: SlashItem[] = [
  { section: "Basic", title: "Text", icon: "¶", keys: "paragraph normal متن", run: (v) => setBlockStyle(v, "p") },
  { section: "Basic", title: "Heading 1", icon: "H1", keys: "h1 title تیتر عنوان", hint: "#", run: (v) => setBlockStyle(v, "h1") },
  { section: "Basic", title: "Heading 2", icon: "H2", keys: "h2 تیتر", hint: "##", run: (v) => setBlockStyle(v, "h2") },
  { section: "Basic", title: "Heading 3", icon: "H3", keys: "h3 تیتر", hint: "###", run: (v) => setBlockStyle(v, "h3") },
  { section: "Basic", title: "Bulleted list", icon: "•", keys: "ul bullet list لیست فهرست", hint: "-", run: (v) => toggleList(v, "bullet") },
  { section: "Basic", title: "Numbered list", icon: "1.", keys: "ol number list لیست شماره", hint: "1.", run: (v) => toggleList(v, "number") },
  { section: "Basic", title: "To-do list", icon: "☑", keys: "todo task checkbox کار", hint: "- [ ]", run: (v) => toggleList(v, "task"), mdOnly: true },
  { section: "Basic", title: "Quote", icon: "❝", keys: "blockquote نقل قول", hint: ">", run: (v) => setBlockStyle(v, "quote") },
  {
    section: "Basic", title: "Callout", icon: "💡", keys: "note tip warning alert باکس نکته هشدار", mdOnly: true,
    run: (v) => insertBlock(v, "> [!NOTE] Title\n> ", 10),
  },
  { section: "Basic", title: "Divider", icon: "—", keys: "hr rule line separator جداکننده خط", hint: "---", run: (v) => insertBlock(v, isTypst() ? "#line(length: 100%)" : "---"), },
  { section: "Basic", title: "Table", icon: "▦", keys: "grid جدول", run: (v) => insertTable(v, 3, 3) },
  { section: "Basic", title: "Code block", icon: "</>", keys: "code snippet کد", hint: "```", run: (v) => insertFenced(v, "", ""), mdOnly: true },
  { section: "Basic", title: "Link", icon: "🔗", keys: "url لینک", run: (v) => insertLink(v) },
  { section: "Basic", title: "Footnote", icon: "¹", keys: "note پانویس", run: (v) => insertFootnote(v) },

  { section: "Math", title: "Equation", icon: "∑", keys: "math latex formula فرمول معادله", hint: "$$", run: (v) => insertMath(v, true) },
  { section: "Math", title: "Inline math", icon: "x²", keys: "math inline فرمول", hint: "$", run: (v) => insertMath(v, false) },

  { section: "Charts & diagrams", title: "Bar chart", icon: "📊", keys: "chart bar نمودار میله", run: diagram("bar") },
  { section: "Charts & diagrams", title: "Line chart", icon: "📈", keys: "chart line plot نمودار خطی", run: diagram("line") },
  { section: "Charts & diagrams", title: "Pie chart", icon: "◔", keys: "chart pie donut نمودار دایره", run: diagram("pie") },
  { section: "Charts & diagrams", title: "Flowchart", icon: "⇉", keys: "flow diagram فلوچارت", run: diagram("flow") },
  { section: "Charts & diagrams", title: "Mind map", icon: "✺", keys: "mindmap tree نقشه ذهنی", run: diagram("mindmap") },
  { section: "Charts & diagrams", title: "Timeline", icon: "⟶", keys: "timeline history خط زمانی", run: diagram("timeline") },
  { section: "Charts & diagrams", title: "Sequence diagram", icon: "⇄", keys: "mermaid sequence", run: diagram("seq") },
  { section: "Charts & diagrams", title: "Shapes", icon: "◯", keys: "draw cetz shape شکل", run: diagram("shapes") },
  { section: "Charts & diagrams", title: "More diagrams…", icon: "✦", keys: "gallery diagram template گالری", run: () => setDialog({ kind: "diagrams" }) },

  { section: "Layout", title: "Centered block", icon: "≡", keys: "center align وسط", mdOnly: true, run: (v) => insertBlock(v, "::: {align=center}\n\n:::", 19) },
  { section: "Layout", title: "Two columns", icon: "▥", keys: "columns ستون", mdOnly: true, run: (v) => insertBlock(v, "::: {columns=2}\n\n:::", 16) },
  { section: "Layout", title: "Left-to-right block", icon: "⇥", keys: "ltr english direction چپ", mdOnly: true, run: (v) => insertBlock(v, "::: {dir=ltr}\n\n:::", 14) },
  { section: "Layout", title: "Right-to-left block", icon: "⇤", keys: "rtl persian direction راست", mdOnly: true, run: (v) => insertBlock(v, "::: {dir=rtl}\n\n:::", 14) },
  { section: "Layout", title: "Page break", icon: "⤓", keys: "pagebreak new page صفحه", run: (v) => insertPageBreak(v) },
  { section: "Layout", title: "Table of contents", icon: "☰", keys: "toc outline فهرست مطالب", run: (v) => insertToc(v) },
];

const SECTION_RANK: Record<string, number> = { Basic: 0, Math: 1, "Charts & diagrams": 2, Layout: 3 };

export function slashCompletion(ctx: CompletionContext): CompletionResult | null {
  const m = ctx.matchBefore(/(?:^|\s)\/[^\s/]*$/);
  if (!m) return null;
  const slash = m.from + m.text.indexOf("/");
  // Not inside code.
  const line = ctx.state.doc.lineAt(ctx.pos);
  if (/^\s*(```|~~~)/.test(line.text)) return null;
  const query = ctx.state.sliceDoc(slash + 1, ctx.pos).toLowerCase();
  const typ = isTypst();
  const items = ITEMS.filter(
    (i) => !(typ && i.mdOnly) && (!query || i.title.toLowerCase().includes(query) || i.keys.toLowerCase().includes(query)),
  );
  if (!items.length) return null;
  return {
    from: slash,
    filter: false,
    options: items.map(
      (i, idx): Completion & { icon: string } => ({
        label: i.title,
        detail: i.hint,
        icon: i.icon,
        boost: -idx,
        section: { name: i.section, rank: SECTION_RANK[i.section] },
        apply: (view, _c, from, to) => {
          view.dispatch({ changes: { from, to, insert: "" } });
          i.run(view);
        },
      }),
    ),
  };
}

/** Renders the icon square in front of slash-menu entries. */
export const slashIconRender = {
  render(c: Completion) {
    const icon = (c as Completion & { icon?: string }).icon;
    if (!icon) return null;
    const el = document.createElement("span");
    el.className = "cm-nz-slash-icon";
    el.textContent = icon;
    return el;
  },
  position: 20,
};
