import { createResource, createSignal, For, Show } from "solid-js";
import { Search } from "lucide-solid";
import { app, notify } from "../core/app";
import { ipc } from "../core/ipc";
import { editorView, isDark } from "../core/store";
import { insertFenced, insertBlock, isTypst } from "../editor/format";
import { Modal } from "./primitives";

export interface Template {
  id: string;
  name: string;
  category: "Charts" | "Diagrams" | "Shapes & Math";
  lang: string;
  code: string;
  description: string;
}

export const TEMPLATES: Template[] = [
  {
    id: "bar", name: "Bar chart", category: "Charts", lang: "chart", description: "Compare categories",
    code: "type: bar\ntitle: فروش ماهانه\nylabel: تعداد\ndata:\n  فروردین: 12\n  اردیبهشت: 19\n  خرداد: 15\n  تیر: 23",
  },
  {
    id: "grouped", name: "Grouped bars", category: "Charts", lang: "chart", description: "Several series side by side",
    code: "type: bar\ntitle: Quarterly results\nlabels: [Q1, Q2, Q3, Q4]\nseries:\n  - name: 2024\n    values: [12, 18, 9, 14]\n  - name: 2025\n    values: [15, 21, 13, 17]",
  },
  {
    id: "hbar", name: "Horizontal bars", category: "Charts", lang: "chart", description: "Rankings and long labels",
    code: "type: hbar\ntitle: محبوب‌ترین زبان‌ها\ndata:\n  Python: 31\n  JavaScript: 27\n  Rust: 14\n  Go: 11",
  },
  {
    id: "line", name: "Line chart", category: "Charts", lang: "chart", description: "Trends over time",
    code: "type: line\ntitle: Growth\nxlabel: Month\nx: [1, 2, 3, 4, 5, 6]\nseries:\n  - name: Users\n    values: [3, 5, 9, 14, 22, 35]\n  - name: Revenue\n    values: [1, 2, 4, 7, 11, 18]\nsmooth: true",
  },
  {
    id: "area", name: "Area chart", category: "Charts", lang: "chart", description: "Volume over time",
    code: "type: area\ntitle: ترافیک سایت\nlabels: [شنبه, یکشنبه, دوشنبه, سه‌شنبه, چهارشنبه]\nvalues: [120, 180, 150, 210, 260]",
  },
  {
    id: "scatter", name: "Scatter plot", category: "Charts", lang: "chart", description: "Correlation between values",
    code: "type: scatter\ntitle: Height vs weight\nxlabel: cm\nylabel: kg\nx: [150, 160, 165, 170, 175, 180, 185]\ny: [50, 56, 61, 66, 70, 77, 82]",
  },
  {
    id: "pie", name: "Pie chart", category: "Charts", lang: "chart", description: "Parts of a whole",
    code: "type: pie\ntitle: بودجه\ndata:\n  اجاره: 40\n  غذا: 25\n  حمل‌ونقل: 15\n  سایر: 20",
  },
  {
    id: "donut", name: "Donut chart", category: "Charts", lang: "chart", description: "Pie with a hole",
    code: "type: donut\ntitle: Market share\ndata:\n  Product A: 45\n  Product B: 30\n  Product C: 15\n  Other: 10",
  },
  {
    id: "flow", name: "Flowchart", category: "Diagrams", lang: "flow", description: "Steps & decisions — simple arrow syntax",
    code: "A([شروع]) -> B[دریافت ورودی] -> C{معتبر است؟}\nC -> D[پردازش] : بله\nC --> B : خیر\nD -> E((پایان))",
  },
  {
    id: "flow-lr", name: "Process (left → right)", category: "Diagrams", lang: "flow", description: "Horizontal pipeline",
    code: "direction: right\nIdea -> Draft[Write draft] -> Review{Approved?}\nReview -> Publish([Publish]) : yes\nReview --> Draft : no",
  },
  {
    id: "mindmap", name: "Mind map", category: "Diagrams", lang: "mindmap", description: "Indented list → tree",
    code: "پروژه\n  اهداف\n    کوتاه‌مدت\n    بلندمدت\n  منابع\n    بودجه\n    تیم\n  ریسک‌ها",
  },
  {
    id: "timeline", name: "Timeline", category: "Diagrams", lang: "timeline", description: "Events in order",
    code: "۱۴۰۰: شروع ایده\n۱۴۰۱: نمونهٔ اولیه\n۱۴۰۲: نسخهٔ بتا\n۱۴۰۳: انتشار عمومی",
  },
  {
    id: "graph", name: "Graph (Fletcher)", category: "Diagrams", lang: "diagram", description: "Full control: nodes & edges",
    code: 'node((0,0), [Client]),\nedge("-|>", [request]),\nnode((2,0), [Server]),\nedge((2,0), (2,1), "-|>"),\nnode((2,1), [Database]),\nedge((2,0), (0,0), "--|>", [response], bend: 40deg)',
  },
  {
    id: "seq", name: "Sequence (Mermaid)", category: "Diagrams", lang: "mermaid", description: "Message exchange",
    code: "sequenceDiagram\n  Alice->>Bob: Hello Bob\n  Bob-->>Alice: Hi Alice\n  Alice->>Bob: How are you?",
  },
  {
    id: "gantt", name: "Gantt (Mermaid)", category: "Diagrams", lang: "mermaid", description: "Project schedule",
    code: "gantt\n  dateFormat YYYY-MM-DD\n  axisFormat %b %d\n  tickInterval 1week\n  title Plan\n  section Build\n  Design :a1, 2026-01-01, 10d\n  Code   :a2, after a1, 20d\n  section Ship\n  Test   :after a2, 7d",
  },
  {
    id: "shapes", name: "Shapes", category: "Shapes & Math", lang: "draw", description: "Circles, boxes, arrows (CeTZ)",
    code: 'circle((0, 0), radius: 1, fill: rgb("#4e79d6").lighten(60%), stroke: rgb("#4e79d6"))\nrect((1.6, -1), (3.6, 1), radius: 0.2, fill: rgb("#f28e2b").lighten(60%), stroke: rgb("#f28e2b"))\nline((1, 0), (1.6, 0), mark: (end: ">"))\ncontent((0, 0), [دایره])\ncontent((2.6, 0), [Box])',
  },
  {
    id: "axes", name: "Function plot", category: "Shapes & Math", lang: "draw", description: "Draw a curve on axes",
    code: 'line((-3, 0), (3, 0), mark: (end: ">"))\nline((0, -1.5), (0, 2.5), mark: (end: ">"))\nline(..range(-30, 31).map(i => (i / 10, calc.sin(i / 10 * 1.5) * 1.2)), stroke: 1.5pt + rgb("#e15759"))\ncontent((3, -0.3), [$x$])\ncontent((0.35, 2.4), [$y$])',
  },
  {
    id: "math", name: "Equation", category: "Shapes & Math", lang: "math", description: "LaTeX display math",
    code: "\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}",
  },
];

function Thumb(props: { t: Template }) {
  const [svg] = createResource(async () => {
    const plugin = app.blocks.get(props.t.lang);
    if (plugin?.preview) return plugin.preview(props.t.code, { dark: isDark() });
    return ipc.renderBlock(props.t.lang, props.t.code);
  });
  return (
    <div class="thumb">
      <Show when={!svg.loading} fallback={<div class="cm-nz-block-loading"><span /><span /><span /></div>}>
        <Show when={!svg.error} fallback={<span class="thumb-err">preview unavailable</span>}>
          <div class="thumb-svg" innerHTML={svg()} />
        </Show>
      </Show>
    </div>
  );
}

export default function DiagramGallery(props: { onClose: () => void }) {
  const [q, setQ] = createSignal("");
  const [cat, setCat] = createSignal<string>("All");
  const cats = ["All", "Charts", "Diagrams", "Shapes & Math"];
  const shown = () =>
    TEMPLATES.filter((t) => (cat() === "All" || t.category === cat()) && (t.name + t.description).toLowerCase().includes(q().toLowerCase()));

  const insert = async (t: Template) => {
    const view = editorView();
    if (!view) return notify("Open a note first", "error");
    if (isTypst()) {
      if (t.lang === "mermaid") return notify("Mermaid diagrams are available in Markdown notes", "error");
      try {
        insertBlock(view, await ipc.blockTypst(t.lang, t.code));
      } catch (e) {
        notify(String(e), "error");
      }
    } else {
      insertFenced(view, t.lang, t.code);
    }
    props.onClose();
  };

  return (
    <Modal title="Insert chart or diagram" subtitle="Everything is plain text you can edit — rendered natively into your PDF." width="900px" class="gallery-modal" onClose={props.onClose}>
      <div class="gallery-bar">
        <div class="search-box">
          <Search size={15} />
          <input placeholder="Filter…" value={q()} onInput={(e) => setQ(e.currentTarget.value)} autofocus />
        </div>
        <div class="chips">
          <For each={cats}>{(c) => <button class="chip" classList={{ active: cat() === c }} onClick={() => setCat(c)}>{c}</button>}</For>
        </div>
      </div>
      <div class="gallery-grid">
        <For each={shown()}>
          {(t) => (
            <button class="gallery-card" onClick={() => insert(t)}>
              <Thumb t={t} />
              <div class="gallery-info">
                <b>{t.name}</b>
                <span>{t.description}</span>
              </div>
              <code class="gallery-lang">{t.lang}</code>
            </button>
          )}
        </For>
      </div>
    </Modal>
  );
}
