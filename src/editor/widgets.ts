// Live previews for special blocks (chart, flow, mermaid, …). When the cursor
// is outside a block, its code is replaced by the rendered drawing; clicking
// the drawing (or moving the cursor in) reveals the code again.
import { EditorState, Range, StateField, Extension, Facet } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { app } from "../core/app";
import { ipc } from "../core/ipc";

/** Langs the Rust side can render (see core/src/render/blocks.rs). */
export const NATIVE_BLOCKS = new Set([
  "chart", "plot", "flow", "flowchart", "diagram", "fletcher", "mindmap", "timeline", "draw", "cetz", "math", "latex", "tex",
]);

export const previewsEnabled = Facet.define<boolean, boolean>({ combine: (v) => v.length === 0 || v[v.length - 1] });
export const darkFacet = Facet.define<boolean, boolean>({ combine: (v) => v.length > 0 && v[v.length - 1] });

const cache = new Map<string, { html?: string; error?: string }>();
/** Last successful drawing per block start, shown dimmed while re-rendering. */
const lastByStart = new Map<number, string>();
const inflight = new Map<string, Promise<void>>();

export function canRender(lang: string) {
  return NATIVE_BLOCKS.has(lang) || !!app.blocks.get(lang)?.preview;
}

async function render(lang: string, code: string, dark: boolean): Promise<void> {
  const key = `${lang}\u0000${code}`;
  if (cache.has(key)) return;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const plugin = app.blocks.get(lang);
      const html = plugin?.preview ? await plugin.preview(code, { dark }) : await ipc.renderBlock(lang, code);
      cache.set(key, { html });
    } catch (e) {
      cache.set(key, { error: String(e) });
    } finally {
      inflight.delete(key);
      if (cache.size > 300) cache.delete(cache.keys().next().value!);
    }
  })();
  inflight.set(key, p);
  return p;
}

class BlockPreview extends WidgetType {
  constructor(
    readonly lang: string,
    readonly code: string,
    readonly codeFrom: number,
    readonly from: number,
    readonly dark: boolean,
  ) {
    super();
  }

  eq(other: BlockPreview) {
    return other.lang === this.lang && other.code === this.code;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-nz-block-preview";
    wrap.setAttribute("dir", "ltr");
    wrap.title = "Click to edit";
    const label = document.createElement("span");
    label.className = "cm-nz-block-tag";
    label.textContent = this.lang;
    const body = document.createElement("div");
    body.className = "cm-nz-block-body";
    wrap.append(label, body);

    const paint = () => {
      const r = cache.get(`${this.lang}\u0000${this.code}`);
      if (!r) {
        const last = lastByStart.get(this.from);
        body.innerHTML = last
          ? `<div class="cm-nz-block-stale">${last}</div>`
          : '<div class="cm-nz-block-loading"><span></span><span></span><span></span></div>';
      } else if (r.error) {
        body.innerHTML = "";
        const err = document.createElement("div");
        err.className = "cm-nz-block-error";
        err.textContent = r.error;
        body.append(err);
      } else {
        body.innerHTML = r.html!;
        lastByStart.set(this.from, r.html!);
      }
    };
    paint();
    if (!cache.has(`${this.lang}\u0000${this.code}`)) {
      // Debounce: only render once typing pauses and the widget still exists.
      setTimeout(() => {
        if (wrap.isConnected) render(this.lang, this.code, this.dark).then(() => wrap.isConnected && paint());
      }, 450);
    }

    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.codeFrom }, scrollIntoView: false });
      view.focus();
    });
    return wrap;
  }

  get estimatedHeight() {
    return 240;
  }

  ignoreEvent() {
    return false;
  }
}

interface Block {
  lang: string;
  code: string;
  from: number; // start of opening fence line
  to: number; // end of closing fence line
  codeFrom: number;
}

function findBlocks(state: EditorState): Block[] {
  const doc = state.doc;
  const out: Block[] = [];
  let open: { lang: string; line: number; fence: string } | null = null;
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    const m = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(text);
    if (!open) {
      if (m) open = { lang: m[2].toLowerCase(), line: i, fence: m[1] };
    } else if (m && text.trim() === m[1] && m[1][0] === open.fence[0] && m[1].length >= open.fence.length) {
      if (canRender(open.lang) && i > open.line + 1) {
        const first = doc.line(open.line + 1);
        const last = doc.line(i - 1);
        out.push({
          lang: open.lang,
          code: doc.sliceString(first.from, last.to),
          from: doc.line(open.line).from,
          to: doc.line(i).to,
          codeFrom: first.from,
        });
      }
      open = null;
    }
  }
  return out;
}

function decorations(state: EditorState): DecorationSet {
  if (!state.facet(previewsEnabled)) return Decoration.none;
  const dark = state.facet(darkFacet);
  const sel = state.selection.main;
  const decos: Range<Decoration>[] = [];
  for (const b of findBlocks(state)) {
    const widget = new BlockPreview(b.lang, b.code, b.codeFrom, b.from, dark);
    const cursorInside = sel.to >= b.from && sel.from <= b.to;
    if (cursorInside) {
      decos.push(Decoration.widget({ widget, block: true, side: 1 }).range(b.to));
    } else {
      decos.push(Decoration.replace({ widget, block: true }).range(b.from, b.to));
    }
  }
  return Decoration.set(decos, true);
}

const field = StateField.define<DecorationSet>({
  create: decorations,
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.reconfigured) return decorations(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function blockPreviews(enabled: boolean, dark: boolean): Extension {
  return [previewsEnabled.of(enabled), darkFacet.of(dark), field];
}

/** Forget cached renders (e.g. after a plugin registers a new renderer). */
export function clearPreviewCache() {
  cache.clear();
}
