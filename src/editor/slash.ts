// The "/" menu: type `/` at the start of a line (or after a space) to insert
// headings, lists, tables, callouts, charts, diagrams, dates…
//
// Commands can take arguments: `/table 3x4`, `/callout warning Read this`,
// `/code python`, `/date YYYY-MM-DD`. While typing them, a grey hint shows
// what comes next, and arguments with known values (callout types, code
// languages, notes, emoji…) are completed. Enter runs the command.
// Plugins add commands with `api.slash.register`.
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { acceptCompletion, completionStatus, selectedCompletion, startCompletion } from "@codemirror/autocomplete";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import {
  setBlockStyle, toggleList, insertBlock, insertTable, insertMath, insertPageBreak, insertToc,
  insertFootnote, insertFenced, insertLink, insertCallout, insertText, isTypst,
} from "./format";
import { TEMPLATES } from "../ui/DiagramGallery";
import { CALLOUTS } from "./livepreview";
import { setDialog, notesList } from "../core/store";
import { app, SlashCommand } from "../core/app";
import { stem } from "../core/ipc";
import { allTags } from "../core/meta";
import { LANGUAGE_CODES } from "../core/languages";
import { EMOJI, findEmoji } from "./emoji";
import { formatDate } from "../plugins/templates";
import { FENCE_LANGUAGES } from "./completions";

const tpl = (id: string) => TEMPLATES.find((t) => t.id === id)!;
const diagram = (id: string) => (v: EditorView) => {
  const t = tpl(id);
  insertFenced(v, t.lang, t.code);
};

const CHARTS = ["bar", "grouped", "hbar", "line", "area", "scatter", "pie", "donut"];
const DIAGRAMS = ["flow", "flow-lr", "mindmap", "timeline", "graph", "seq", "gantt", "shapes", "axes"];
const notes = () => notesList().map(stem);
const day = (offset: number) => new Date(Date.now() + offset * 86400000);
const block = (attrs: string) => (v: EditorView) => insertBlock(v, `::: {${attrs}}\n\n:::`, attrs.length + 6);

/** "3x4", "3×4", "3 4", "3" → [rows, cols]. */
function size(a: string, b: string): [number, number] {
  const m = /^(\d+)\s*[x×*,]?\s*(\d+)?$/i.exec(`${a} ${b}`.trim().replace(/\s+/, " ").replace(" ", "x"));
  const r = Math.min(50, Math.max(1, Number(m?.[1] ?? 3)));
  const c = Math.min(20, Math.max(1, Number(m?.[2] ?? 3)));
  return [r, c];
}

export const BUILTIN: (SlashCommand & { section: string; icon: string })[] = [
  { section: "Basic", id: "text", title: "Text", icon: "¶", keys: "paragraph normal plain", run: (v) => setBlockStyle(v, "p") },
  { section: "Basic", id: "h1", title: "Heading 1", icon: "H1", keys: "title heading", hint: "#", run: (v) => setBlockStyle(v, "h1") },
  { section: "Basic", id: "h2", title: "Heading 2", icon: "H2", keys: "heading subtitle", hint: "##", run: (v) => setBlockStyle(v, "h2") },
  { section: "Basic", id: "h3", title: "Heading 3", icon: "H3", keys: "heading", hint: "###", run: (v) => setBlockStyle(v, "h3") },
  {
    section: "Basic", id: "heading", title: "Heading…", icon: "H", keys: "heading level", hint: "/heading 4",
    args: [{ name: "level 1–6", options: () => ["1", "2", "3", "4", "5", "6"] }],
    run: (v, [n]) => setBlockStyle(v, `h${Math.min(6, Math.max(1, Number(n) || 1))}` as "h1"),
  },
  { section: "Basic", id: "bullet", title: "Bulleted list", icon: "•", keys: "ul list unordered", hint: "-", run: (v) => toggleList(v, "bullet") },
  { section: "Basic", id: "numbered", title: "Numbered list", icon: "1.", keys: "ol list ordered", hint: "1.", run: (v) => toggleList(v, "number") },
  { section: "Basic", id: "todo", title: "To-do list", icon: "☑", keys: "task checkbox checklist", hint: "- [ ]", run: (v) => toggleList(v, "task"), mdOnly: true },
  { section: "Basic", id: "quote", title: "Quote", icon: "❝", keys: "blockquote citation", hint: ">", run: (v) => setBlockStyle(v, "quote") },
  { section: "Basic", id: "divider", title: "Divider", icon: "—", keys: "hr rule line separator", hint: "---", run: (v) => insertBlock(v, isTypst() ? "#line(length: 100%)" : "---") },
  {
    section: "Basic", id: "table", title: "Table", icon: "▦", keys: "grid", hint: "/table 3x4",
    args: [{ name: "rows×columns" }],
    run: (v, [a = "", b = ""]) => insertTable(v, ...size(a, b)),
  },
  {
    section: "Basic", id: "code", title: "Code block", icon: "</>", keys: "snippet program fence", hint: "/code python", mdOnly: true,
    args: [{ name: "language", options: () => FENCE_LANGUAGES }],
    run: (v, [lang]) => insertFenced(v, lang ?? "", ""),
  },
  { section: "Basic", id: "link", title: "Link", icon: "🔗", keys: "url web", hint: "/link Note", args: [{ name: "note or URL", options: notes }],
    run: (v, [t]) => {
      if (!t) return insertLink(v);
      if (/^https?:/i.test(t)) return insertText(v, isTypst() ? `#link("${t}")` : `<${t}>`);
      insertText(v, isTypst() ? `#link(<${t}>)` : `[[${t}]]`);
    } },
  { section: "Basic", id: "embed", title: "Embed note or image", icon: "⧉", keys: "transclude include image", hint: "/embed Note", mdOnly: true,
    args: [{ name: "note or file", options: notes }], run: (v, [t]) => insertText(v, `![[${t ?? ""}]]`, t ? undefined : 3) },
  { section: "Basic", id: "footnote", title: "Footnote", icon: "¹", keys: "note reference", run: (v) => insertFootnote(v) },
  {
    section: "Basic", id: "tag", title: "Tag", icon: "#", keys: "label category", hint: "/tag name", mdOnly: true,
    args: [{ name: "tag", options: () => allTags().map((t) => t.tag) }],
    run: (v, [t]) => insertText(v, `#${(t ?? "").replace(/^#/, "").replace(/\s+/g, "-")}`),
  },
  {
    section: "Basic", id: "emoji", title: "Emoji", icon: "😀", keys: "smiley icon", hint: "/emoji smile  ·  :smile:",
    args: [{ name: "name", options: () => EMOJI.map(([n]) => n) }],
    run: (v, [n]) => insertText(v, (n && (EMOJI.find(([k]) => k === n)?.[1] ?? findEmoji(n, 1)[0]?.[1])) || "😀"),
  },

  { section: "Math", id: "math", title: "Equation", icon: "∑", keys: "latex formula display", hint: "$$", run: (v) => insertMath(v, true) },
  { section: "Math", id: "inline-math", title: "Inline math", icon: "x²", keys: "latex formula", hint: "$", run: (v) => insertMath(v, false) },

  {
    section: "Callouts", id: "callout", title: "Callout", icon: "ℹ", keys: "box admonition alert", hint: "/callout warning Title", mdOnly: true,
    args: [{ name: "type", options: () => Object.keys(CALLOUTS) }, { name: "title" }],
    run: (v, [type, title]) => {
      const t = type && CALLOUTS[type.toLowerCase()] ? type.toLowerCase() : "note";
      if (!title) return insertCallout(v, t);
      insertBlock(v, `> [!${t.toUpperCase()}] ${title}\n> `);
    },
  },
  ...Object.entries(CALLOUTS).map(([type, c]) => ({
    section: "Callouts", id: type, title: `Callout: ${c.label}`, icon: c.icon, keys: `callout box admonition`, mdOnly: true,
    run: (v: EditorView) => insertCallout(v, type),
  })),

  {
    section: "Charts & diagrams", id: "chart", title: "Chart", icon: "📊", keys: "graph plot", hint: "/chart pie",
    args: [{ name: "kind", options: () => CHARTS }], run: (v, [k]) => diagram(CHARTS.includes(k ?? "") ? k! : "bar")(v),
  },
  {
    section: "Charts & diagrams", id: "diagram", title: "Diagram", icon: "⇉", keys: "flowchart mindmap timeline sequence", hint: "/diagram mindmap",
    args: [{ name: "kind", options: () => DIAGRAMS }], run: (v, [k]) => diagram(DIAGRAMS.includes(k ?? "") ? k! : "flow")(v),
  },
  { section: "Charts & diagrams", id: "flowchart", title: "Flowchart", icon: "⇉", keys: "flow diagram process", run: diagram("flow") },
  { section: "Charts & diagrams", id: "mindmap", title: "Mind map", icon: "✺", keys: "tree brainstorm", run: diagram("mindmap") },
  { section: "Charts & diagrams", id: "timeline", title: "Timeline", icon: "⟶", keys: "history events", run: diagram("timeline") },
  { section: "Charts & diagrams", id: "mermaid", title: "Sequence diagram", icon: "⇄", keys: "mermaid sequence", run: diagram("seq") },
  { section: "Charts & diagrams", id: "shapes", title: "Shapes", icon: "◯", keys: "draw cetz shape", run: diagram("shapes") },
  {
    section: "Data", id: "base", title: "Database view", icon: "▦", keys: "base bases table database board kanban cards", hint: "/base board", mdOnly: true,
    args: [{ name: "layout", options: () => ["table", "cards", "list", "board"] }],
    run: (v, [k]) => {
      const t = ["table", "cards", "list", "board"].includes(k ?? "") ? k! : "table";
      const group = t === "board" ? "\n    groupBy:\n      property: status" : "";
      insertFenced(v, "base", `filters:\n  and:\n    - file.ext == "md"\nviews:\n  - type: ${t}\n    name: ${t[0].toUpperCase() + t.slice(1)}${group}\n    order: [file.name, file.mtime]\n    limit: 20`);
    },
  },
  {
    section: "Data", id: "query", title: "Query", icon: "⌕", keys: "search results list tasks find", hint: "/query tag:project", mdOnly: true,
    args: [{ name: "search, e.g. tag:x path:y", options: () => ["tag:", "path:", "prop:status=", "type:task", "type:heading"] }],
    run: (v, args) => insertFenced(v, "query", args.filter(Boolean).join(" ") || "tag:todo"),
  },
  { section: "Charts & diagrams", id: "gallery", title: "More diagrams…", icon: "✦", keys: "gallery template diagram chart", run: () => setDialog({ kind: "diagrams" }) },

  { section: "Layout", id: "center", title: "Centered block", icon: "≡", keys: "align middle", mdOnly: true, run: block("align=center") },
  {
    section: "Layout", id: "columns", title: "Columns", icon: "▥", keys: "column layout side by side", hint: "/columns 3", mdOnly: true,
    args: [{ name: "count 2–4", options: () => ["2", "3", "4"] }],
    run: (v, [n]) => block(`columns=${Math.min(4, Math.max(2, Number(n) || 2))}`)(v),
  },
  { section: "Layout", id: "ltr", title: "Left-to-right block", icon: "⇥", keys: "direction english", mdOnly: true, run: block("dir=ltr") },
  { section: "Layout", id: "rtl", title: "Right-to-left block", icon: "⇤", keys: "direction arabic persian urdu", mdOnly: true, run: block("dir=rtl") },
  {
    section: "Layout", id: "lang", title: "Block in another language", icon: "文", keys: "language direction font", hint: "/lang ja", mdOnly: true,
    args: [{ name: "language code", options: () => LANGUAGE_CODES }], run: (v, [l]) => block(`lang=${l || "en"}`)(v),
  },
  { section: "Layout", id: "pagebreak", title: "Page break", icon: "⤓", keys: "new page", run: (v) => insertPageBreak(v) },
  { section: "Layout", id: "toc", title: "Table of contents", icon: "☰", keys: "outline contents", run: (v) => insertToc(v) },

  {
    section: "Date & time", id: "today", title: "Today's date", icon: "📅", keys: "date day now",
    run: (v) => insertText(v, formatDate(new Date(), "YYYY-MM-DD")),
  },
  { section: "Date & time", id: "tomorrow", title: "Tomorrow's date", icon: "📅", keys: "date next day", run: (v) => insertText(v, formatDate(day(1), "YYYY-MM-DD")) },
  { section: "Date & time", id: "yesterday", title: "Yesterday's date", icon: "📅", keys: "date previous day", run: (v) => insertText(v, formatDate(day(-1), "YYYY-MM-DD")) },
  {
    section: "Date & time", id: "date", title: "Date…", icon: "📆", keys: "format day", hint: "/date dddd, D MMMM YYYY",
    args: [{ name: "format", options: () => ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "D MMMM YYYY", "dddd, D MMMM YYYY", "MMMM YYYY", "YYYY-[W]ww"] }],
    run: (v, [f]) => insertText(v, formatDate(new Date(), f || "YYYY-MM-DD")),
  },
  {
    section: "Date & time", id: "time", title: "Time", icon: "🕒", keys: "clock hour now", hint: "/time HH:mm",
    args: [{ name: "format", options: () => ["HH:mm", "HH:mm:ss", "h:mm A"] }],
    run: (v, [f]) => insertText(v, formatDate(new Date(), f || "HH:mm")),
  },
  { section: "Date & time", id: "now", title: "Date and time", icon: "🕒", keys: "timestamp datetime", run: (v) => insertText(v, formatDate(new Date(), "YYYY-MM-DD HH:mm")) },
  {
    section: "Date & time", id: "daily", title: "Link to today's daily note", icon: "🗓", keys: "journal diary today", mdOnly: true,
    run: async (v) => {
      const { dailyPath } = await import("../plugins/daily");
      insertText(v, `[[${stem(dailyPath(new Date()))}]]`);
    },
  },
];

/**
 * Words that find commands in other languages, so the menu works when you
 * write in them. Matched like the English keys.
 */
const LOCAL_KEYS: Record<string, Record<string, string>> = {
  text: { fa: "متن", ar: "نص", ur: "متن", de: "Text Absatz", fr: "texte paragraphe", es: "texto párrafo", pt: "texto parágrafo", it: "testo paragrafo", ru: "текст абзац", tr: "metin paragraf", zh: "文本 段落", ja: "テキスト 段落", ko: "텍스트 문단", hi: "पाठ अनुच्छेद" },
  h1: { fa: "تیتر عنوان", ar: "عنوان", ur: "عنوان", de: "Überschrift Titel", fr: "titre", es: "título encabezado", pt: "título", it: "titolo", ru: "заголовок", tr: "başlık", zh: "标题", ja: "見出し タイトル", ko: "제목", hi: "शीर्षक" },
  h2: { fa: "تیتر", ar: "عنوان فرعي", de: "Überschrift", fr: "sous-titre", es: "subtítulo", pt: "subtítulo", it: "sottotitolo", ru: "подзаголовок", zh: "标题", ja: "見出し", ko: "제목", hi: "शीर्षक" },
  h3: { fa: "تیتر", ar: "عنوان", de: "Überschrift", fr: "titre", es: "título", ru: "заголовок", zh: "标题", ja: "見出し", ko: "제목", hi: "शीर्षक" },
  bullet: { fa: "لیست فهرست", ar: "قائمة", ur: "فہرست", de: "Liste Aufzählung", fr: "liste puces", es: "lista viñetas", pt: "lista", it: "elenco", ru: "список", tr: "liste", zh: "列表", ja: "リスト 箇条書き", ko: "목록", hi: "सूची" },
  numbered: { fa: "لیست شماره", ar: "قائمة مرقمة", de: "nummeriert Liste", fr: "liste numérotée", es: "lista numerada", pt: "lista numerada", it: "elenco numerato", ru: "нумерованный список", zh: "编号列表", ja: "番号付きリスト", ko: "번호 목록", hi: "क्रमांकित सूची" },
  todo: { fa: "کار وظیفه", ar: "مهمة مهام", ur: "کام", de: "Aufgabe Checkliste", fr: "tâche", es: "tarea", pt: "tarefa", it: "attività", ru: "задача", tr: "görev", zh: "待办 任务", ja: "タスク", ko: "할 일", hi: "कार्य" },
  quote: { fa: "نقل قول", ar: "اقتباس", ur: "اقتباس", de: "Zitat", fr: "citation", es: "cita", pt: "citação", it: "citazione", ru: "цитата", tr: "alıntı", zh: "引用", ja: "引用", ko: "인용", hi: "उद्धरण" },
  divider: { fa: "خط جداکننده", ar: "فاصل خط", de: "Trennlinie", fr: "séparateur", es: "separador", ru: "разделитель", zh: "分隔线", ja: "区切り線", ko: "구분선", hi: "विभाजक" },
  table: { fa: "جدول", ar: "جدول", ur: "جدول", de: "Tabelle", fr: "tableau", es: "tabla", pt: "tabela", it: "tabella", ru: "таблица", tr: "tablo", zh: "表格", ja: "表 テーブル", ko: "표", hi: "तालिका" },
  code: { fa: "کد", ar: "رمز كود", de: "Code", fr: "code", es: "código", pt: "código", ru: "код", zh: "代码", ja: "コード", ko: "코드", hi: "कोड" },
  link: { fa: "لینک پیوند", ar: "رابط", ur: "ربط", de: "Link Verweis", fr: "lien", es: "enlace", pt: "link", it: "collegamento", ru: "ссылка", tr: "bağlantı", zh: "链接", ja: "リンク", ko: "링크", hi: "लिंक" },
  footnote: { fa: "پانویس", ar: "حاشية", de: "Fußnote", fr: "note de bas de page", es: "nota al pie", ru: "сноска", zh: "脚注", ja: "脚注", ko: "각주", hi: "फुटनोट" },
  math: { fa: "فرمول معادله", ar: "معادلة صيغة", de: "Formel Gleichung", fr: "équation formule", es: "ecuación fórmula", pt: "equação", it: "equazione", ru: "формула уравнение", tr: "denklem", zh: "公式 方程", ja: "数式", ko: "수식", hi: "समीकरण" },
  callout: { fa: "باکس کادر", ar: "تنبيه صندوق", de: "Hinweis Box", fr: "encadré", es: "aviso cuadro", ru: "выноска", zh: "提示框", ja: "注意書き", ko: "콜아웃", hi: "सूचना" },
  chart: { fa: "نمودار", ar: "مخطط رسم بياني", ur: "چارٹ", de: "Diagramm", fr: "graphique", es: "gráfico", pt: "gráfico", it: "grafico", ru: "диаграмма график", tr: "grafik", zh: "图表", ja: "グラフ", ko: "차트", hi: "चार्ट" },
  diagram: { fa: "دیاگرام نمودار", ar: "مخطط", de: "Diagramm", fr: "diagramme", es: "diagrama", ru: "схема", zh: "图", ja: "図", ko: "다이어그램", hi: "आरेख" },
  mindmap: { fa: "نقشه ذهنی", ar: "خريطة ذهنية", de: "Mindmap", fr: "carte mentale", es: "mapa mental", ru: "интеллект-карта", zh: "思维导图", ja: "マインドマップ", ko: "마인드맵", hi: "माइंड मैप" },
  timeline: { fa: "خط زمانی", ar: "جدول زمني", de: "Zeitleiste", fr: "chronologie", es: "cronología", ru: "хронология", zh: "时间线", ja: "年表", ko: "타임라인", hi: "समयरेखा" },
  columns: { fa: "ستون", ar: "أعمدة", de: "Spalten", fr: "colonnes", es: "columnas", ru: "колонки", zh: "分栏", ja: "段組み", ko: "단", hi: "स्तंभ" },
  center: { fa: "وسط", ar: "وسط", de: "zentriert", fr: "centré", es: "centrado", ru: "по центру", zh: "居中", ja: "中央", ko: "가운데", hi: "मध्य" },
  rtl: { fa: "راست به چپ", ar: "من اليمين", ur: "دائیں سے بائیں" },
  ltr: { fa: "چپ به راست", ar: "من اليسار", ur: "بائیں سے دائیں" },
  pagebreak: { fa: "صفحه جدید", ar: "صفحة جديدة", de: "Seitenumbruch", fr: "saut de page", es: "salto de página", ru: "разрыв страницы", zh: "分页", ja: "改ページ", ko: "페이지 나누기", hi: "पृष्ठ विराम" },
  toc: { fa: "فهرست مطالب", ar: "جدول المحتويات", de: "Inhaltsverzeichnis", fr: "table des matières", es: "índice", ru: "оглавление", zh: "目录", ja: "目次", ko: "목차", hi: "विषय सूची" },
  today: { fa: "امروز تاریخ", ar: "اليوم تاريخ", ur: "آج", de: "heute Datum", fr: "aujourd'hui date", es: "hoy fecha", pt: "hoje data", it: "oggi data", ru: "сегодня дата", tr: "bugün tarih", zh: "今天 日期", ja: "今日 日付", ko: "오늘 날짜", hi: "आज तारीख" },
  time: { fa: "ساعت زمان", ar: "وقت ساعة", de: "Uhrzeit", fr: "heure", es: "hora", ru: "время", zh: "时间", ja: "時刻", ko: "시간", hi: "समय" },
  emoji: { fa: "ایموجی", ar: "رمز تعبيري", de: "Emoji", fr: "émoji", es: "emoji", ru: "эмодзи", zh: "表情", ja: "絵文字", ko: "이모지", hi: "इमोजी" },
  tag: { fa: "برچسب", ar: "وسم", de: "Schlagwort", fr: "étiquette", es: "etiqueta", ru: "тег метка", zh: "标签", ja: "タグ", ko: "태그", hi: "टैग" },
  embed: { fa: "جاسازی", ar: "تضمين", de: "einbetten", fr: "intégrer", es: "incrustar", ru: "встроить", zh: "嵌入", ja: "埋め込み", ko: "삽입", hi: "एम्बेड" },
};

const SECTION_RANK: Record<string, number> = { Basic: 0, Math: 1, Callouts: 2, "Charts & diagrams": 3, Data: 4, Layout: 5, "Date & time": 6, Plugins: 7 };

/** Every command available in the current note. */
function commands(): SlashCommand[] {
  const typ = isTypst();
  const diagrams = app.commands.has("insert.diagram");
  return [...BUILTIN, ...app.slash.items()].filter(
    (c) => !(typ && c.mdOnly) && !(!typ && c.typOnly) && (diagrams || c.section !== "Charts & diagrams"),
  );
}

const words = (c: SlashCommand) =>
  `${c.id} ${c.title} ${c.keys ?? ""} ${Object.values(LOCAL_KEYS[c.id] ?? {}).join(" ")}`.toLowerCase();

/** `/cmd args…` before the cursor: [start of "/", command word, args text or null]. */
const SLASH = /(?:^|[\s([{])\/([\p{L}\p{N}_-]*)(?: ([^\n]*))?$/u;

function parse(ctx: { state: import("@codemirror/state").EditorState; pos: number }) {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const m = SLASH.exec(before);
  if (!m) return null;
  const from = line.from + m.index + m[0].indexOf("/");
  return { from, word: m[1], args: m[2] ?? null, line };
}

/** Split typed arguments: the last argument takes the rest of the line. */
function splitArgs(text: string, n: number): string[] {
  const parts = text.split(/\s+/);
  if (parts.length <= n) return parts;
  return [...parts.slice(0, n - 1), parts.slice(n - 1).join(" ")];
}

function inCode(ctx: CompletionContext): boolean {
  const line = ctx.state.doc.lineAt(ctx.pos);
  if (/^\s*(```|~~~)/.test(line.text)) return true;
  // Inside a fenced block: count fences above.
  let open = false;
  for (let n = 1; n < line.number; n++) if (/^\s*(```|~~~)/.test(ctx.state.doc.line(n).text)) open = !open;
  return open;
}

/** Remove the typed "/command args" and run the command. */
function runner(c: SlashCommand, args: string[]) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    view.dispatch({ changes: { from, to, insert: "" } });
    try {
      c.run(view, args);
    } catch (e) {
      console.error(`/${c.id} failed`, e);
    }
  };
}

export async function slashCompletion(ctx: CompletionContext): Promise<CompletionResult | null> {
  const p = parse(ctx);
  if (!p || inCode(ctx)) return null;
  const all = commands();
  const lineEnd = p.line.to;

  // "/cmd args": complete the current argument, or offer to run.
  if (p.args !== null) {
    const c = all.find((x) => x.id === p.word.toLowerCase());
    if (!c?.args?.length) return null;
    const tokens = p.args.split(/\s+/);
    const idx = Math.min(tokens.length - 1, c.args.length - 1);
    const arg = c.args[idx];
    const typed = idx === c.args.length - 1 ? splitArgs(p.args, c.args.length)[idx] ?? "" : tokens[idx] ?? "";
    const argFrom = ctx.pos - typed.length;
    const values = arg.options ? await arg.options() : [];
    const q = typed.toLowerCase();
    const matches = values.filter((v) => v.toLowerCase().includes(q)).sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)));
    const last = idx === c.args.length - 1;
    const done = splitArgs(p.args, c.args.length);
    const options: Completion[] = [
      // Run with what is typed (always first when something is typed).
      ...(typed || !matches.length
        ? [{
            label: `${c.title}${p.args.trim() ? ` — ${p.args.trim()}` : ""}`,
            detail: "↵ insert",
            boost: 99,
            apply: (v: EditorView, comp: Completion, _f: number, to: number) => runner(c, done)(v, comp, p.from, Math.max(to, lineEnd)),
          } as Completion]
        : []),
      ...matches.slice(0, 80).map((value): Completion => {
        const emoji = c.id === "emoji" ? EMOJI.find(([n]) => n === value)?.[1] : undefined;
        return {
          label: value,
          detail: emoji ?? arg.name,
          apply: (v, comp, _from, to) => {
            if (last) {
              const args = [...done.slice(0, idx), value];
              return runner(c, args)(v, comp, p.from, Math.max(to, lineEnd));
            }
            // More arguments follow: put the value in and continue.
            v.dispatch({ changes: { from: argFrom, to, insert: value + " " }, selection: { anchor: argFrom + value.length + 1 } });
            startCompletion(v);
          },
        };
      }),
    ];
    return { from: argFrom, options, filter: false };
  }

  // "/word": the command list.
  const q = p.word.toLowerCase();
  const items = all.filter((c) => !q || words(c).includes(q));
  if (!items.length) return null;
  items.sort((a, b) => Number(!a.id.startsWith(q)) - Number(!b.id.startsWith(q)));
  return {
    from: p.from,
    filter: false,
    options: items.map((c, idx): Completion & { icon: string; slash: SlashCommand } => ({
      label: c.title,
      detail: c.args?.length ? `/${c.id} ${c.args.map((a) => a.name).join(" ")}` : c.hint ?? `/${c.id}`,
      icon: c.icon ?? "⚡",
      slash: c,
      boost: -idx,
      section: { name: c.section ?? "Plugins", rank: SECTION_RANK[c.section ?? "Plugins"] ?? 9 },
      apply: runner(c, []),
    })),
  };
}

/**
 * Tab on a command that takes arguments: write "/command " so the arguments
 * can be typed (Enter runs it right away with the defaults).
 */
export const slashKeymap = Prec.highest(
  keymap.of([
    {
      key: "Tab",
      run: (view) => {
        if (completionStatus(view.state) !== "active") return false;
        const sel = selectedCompletion(view.state) as (Completion & { slash?: SlashCommand }) | null;
        const c = sel?.slash;
        if (!c) return false;
        if (!c.args?.length) return acceptCompletion(view);
        const p = parse({ state: view.state, pos: view.state.selection.main.head });
        if (!p) return false;
        const insert = `/${c.id} `;
        view.dispatch({ changes: { from: p.from, to: view.state.selection.main.head, insert }, selection: { anchor: p.from + insert.length } });
        startCompletion(view);
        return true;
      },
    },
  ]),
);

// ---------------------------------------------------------------- ghost text

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(o: GhostWidget) {
    return o.text === this.text;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-nz-ghost";
    s.textContent = this.text;
    return s;
  }
}

/** Grey names of the arguments still to type, after the cursor: "/table ⟨rows×columns⟩". */
function ghost(view: EditorView): DecorationSet {
  const sel = view.state.selection.main;
  if (!sel.empty || !view.hasFocus) return Decoration.none;
  const p = parse({ state: view.state, pos: sel.head });
  if (!p || sel.head !== p.line.to) return Decoration.none;
  const c = commands().find((x) => x.id === p.word.toLowerCase());
  if (!c?.args?.length) return Decoration.none;
  let rest: string[];
  if (p.args === null) rest = c.args.map((a) => a.name);
  else {
    const typed = p.args.split(/\s+/);
    const done = p.args.endsWith(" ") || p.args === "" ? typed.length - 1 : typed.length;
    rest = c.args.slice(done).map((a) => a.name);
  }
  if (!rest.length) return Decoration.none;
  const text = (p.args === null ? " " : p.args === "" || p.args.endsWith(" ") ? "" : " ") + rest.map((r) => `‹${r}›`).join(" ");
  return Decoration.set([Decoration.widget({ widget: new GhostWidget(text), side: 1 }).range(sel.head)]);
}

export const slashGhost = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = ghost(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.focusChanged) this.decorations = ghost(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

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
