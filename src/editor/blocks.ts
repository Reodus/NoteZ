// Block references in the editor: `((` search that inserts `[[Note#^id]]`,
// hover previews of links, live embeds of `![[Note#…]]`, faded `^ids`, and
// the blink that marks a block you jumped to.
import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, hoverTooltip, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { ipc, stem, BlockHit } from "../core/ipc";
import { app } from "../core/app";
import { prefs, saveAll, state } from "../core/store";
import { ensureBlockId, linkName, newBlockId, previewHtml } from "../core/blocks";
import { hydrateImages } from "./livepreview";
import { footnotePeek } from "./footnotes";

import { t } from "../core/i18n";
// ---------------------------------------------------------------- flash

const flashEffect = StateEffect.define<{ from: number; to: number } | null>();
const flashMark = Decoration.line({ class: "cm-nz-flash" });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(flashEffect)) continue;
      if (!e.value) deco = Decoration.none;
      else {
        const b = new RangeSetBuilder<Decoration>();
        const doc = tr.state.doc;
        for (let n = doc.lineAt(e.value.from).number; n <= doc.lineAt(e.value.to).number; n++) b.add(doc.line(n).from, doc.line(n).from, flashMark);
        deco = b.finish();
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

let flashTimer: number | undefined;
/** Make the lines from `from` to `to` (positions) blink for a moment. */
export function flash(view: EditorView, from: number, to: number) {
  view.dispatch({ effects: flashEffect.of({ from, to }) });
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => view.dispatch({ effects: flashEffect.of(null) }), 1600);
}

// ------------------------------------------------------------- ^block-id

const idMark = Decoration.mark({ class: "cm-nz-blockid" });
const ID_AT_END = /(^|\s)(\^[A-Za-z0-9_-]+)\s*$/;

/** `^ids` at the end of a line are shown small and faded. */
const blockIdPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView) {
      const b = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        let fence = false;
        while (pos <= to) {
          const line = view.state.doc.lineAt(pos);
          if (/^\s*(```|~~~)/.test(line.text)) fence = !fence;
          const m = !fence && line.text.includes("^") ? ID_AT_END.exec(line.text) : null;
          if (m) {
            const s = line.from + m.index! + m[1].length;
            b.add(s, s + m[2].length, idMark);
          }
          pos = line.to + 1;
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

// --------------------------------------------------------- (( completion

const KIND_ICON: Record<BlockHit["kind"], string> = {
  paragraph: "¶", heading: "H", item: "•", task: "☐", quote: "❝", callout: "ℹ", table: "▦", code: "{}", math: "∑",
};

/** `((text` searches every block of the vault; picking one links it as `[[Note#^id]]`. */
export async function blockRefCompletion(ctx: CompletionContext): Promise<CompletionResult | null> {
  if (state.active?.endsWith(".typ")) return null;
  const m = ctx.matchBefore(/\(\([^()\n]*$/);
  if (!m) return null;
  const query = m.text.slice(2);
  await saveAll().catch(() => {});
  if (ctx.aborted) return null;
  let hits = await ipc.blockSearch(query, state.active, [...prefs.excludedFolders]).catch(() => [] as BlockHit[]);
  if (ctx.aborted) return null;
  const from = state.active;
  // Not the block being typed in.
  hits = hits.filter((h) => !(h.path === from && h.text.includes(m.text)));
  const options: (Completion & { icon?: string })[] = hits.map((h, i) => ({
    label: h.text.length > 90 ? h.text.slice(0, 90) + "…" : h.text,
    detail: h.path === from ? "this note" : stem(h.path),
    icon: KIND_ICON[h.kind],
    boost: -i,
    apply: (view, _c, a, b) => {
      const id = h.id ?? newBlockId();
      const name = linkName(h.path, from);
      const after = view.state.sliceDoc(b, b + 2) === "))" ? 2 : 0;
      const text = `[[${name}#^${id}]]`;
      view.dispatch({ changes: { from: a, to: b + after, insert: text }, selection: { anchor: a + text.length }, userEvent: "input.complete" });
      if (!h.id)
        void ensureBlockId(h.path, h.line, id).then((real) => {
          // The block got an id meanwhile: point the link at that one.
          if (real === id) return;
          const v = view.state.doc.toString();
          const at = v.indexOf(`#^${id}]]`);
          if (at >= 0) view.dispatch({ changes: { from: at + 2, to: at + 2 + id.length, insert: real } });
        });
    },
  }));
  return {
    from: m.from,
    options: options.length ? options : [{ label: query ? t("No block matches") : t("Type to search blocks"), apply: () => {} }],
    filter: false,
  };
}

// ------------------------------------------------------- link previews

const LINK = /!?\[\[([^\]\n]+)\]\]/g;

async function fillPreview(el: HTMLElement, from: string, link: string) {
  const target = link.split("|")[0].trim();
  const sec = await ipc.noteSection(from, target).catch(() => null);
  if (!sec) {
    el.classList.add("missing");
    el.textContent = /^(https?:)/.test(target) ? target : t("No note “{name}”", { name: target.split("#")[0] || target });
    return;
  }
  const head = document.createElement("div");
  head.className = "cm-nz-preview-head";
  const sub = target.includes("#") ? target.slice(target.indexOf("#") + 1) : "";
  head.textContent = stem(sec.path) + (sub ? ` › ${sub.replace(/^\^/, "^")}` : "");
  const body = document.createElement("div");
  body.className = "cm-nz-preview-body markdown";
  body.innerHTML = await previewHtml(sec.text.split("\n").slice(0, 120).join("\n"));
  hydrateImages(body);
  el.replaceChildren(head, body);
}

/** Hovering a `[[link]]` shows what it points at. */
const linkHover = hoverTooltip(
  (view, pos) => {
    const from = state.active;
    if (!from || from.endsWith(".typ")) return null;
    const line = view.state.doc.lineAt(pos);
    for (const m of line.text.matchAll(LINK)) {
      const s = line.from + m.index!;
      const e = s + m[0].length;
      if (pos < s || pos > e) continue;
      // Live embeds already show their content.
      if (m[0].startsWith("!") && view.dom.querySelector(`.cm-nz-embed[data-target="${CSS.escape(m[1])}"]`)) return null;
      return {
        pos: s,
        end: e,
        above: true,
        create: () => {
          const dom = document.createElement("div");
          dom.className = "cm-nz-link-preview";
          dom.textContent = "…";
          void fillPreview(dom, from, m[1]);
          return { dom };
        },
      };
    }
    return null;
  },
  { hoverTime: 400 },
);

// ------------------------------------------------------------- embeds

const ASSET = /\.(png|jpe?g|gif|webp|svg|bmp|avif|pdf|mp3|wav|ogg|m4a|mp4|webm|mov|canvas)$/i;

class EmbedWidget extends WidgetType {
  private off?: () => void;
  private gone = false;
  constructor(readonly target: string, readonly from: string) {
    super();
  }
  eq(o: EmbedWidget) {
    return o.target === this.target && o.from === this.from;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-nz-embed";
    el.dataset.target = this.target;
    el.contentEditable = "false";
    if (/\.base$/i.test(this.target.split(/[#|]/)[0].trim())) {
      // A database view.
      el.classList.add("base");
      void import("../ui/BaseView").then((m) => {
        if (!this.gone) this.off = m.mountBaseEmbed(el, this.target);
      });
      return el;
    }
    const load = () => void fillPreview(el, this.from, this.target).then(() => el.querySelector(".cm-nz-preview-head")?.setAttribute("data-target", this.target));
    load();
    // Saved notes: refresh embeds of them.
    const name = this.target.split("#")[0].split("|")[0].trim();
    const offs = [
      app.events.on("note:saved", ({ path }) => (!name || stem(path) === stem(name) || path.replace(/\.md$/, "") === name) && load()),
      app.events.on("note:reloaded", ({ path }) => (!name || stem(path) === stem(name)) && load()),
    ];
    this.off = () => offs.forEach((f) => f());
    el.addEventListener("mousedown", (e) => {
      const head = (e.target as HTMLElement).closest(".cm-nz-preview-head");
      if (!head) return;
      e.preventDefault();
      e.stopPropagation();
      void import("./Editor").then((m) => m.openLinkTarget(this.target.split("|")[0]));
    });
    return el;
  }
  destroy() {
    this.gone = true;
    this.off?.();
  }
  ignoreEvent(e: Event) {
    if ((e.target as HTMLElement).closest?.(".base-embed")) return true;
    return e.type !== "mousedown" || !(e.target as HTMLElement).closest?.(".cm-nz-lp-link");
  }
  get estimatedHeight() {
    return 120;
  }
}

function buildEmbeds(st: import("@codemirror/state").EditorState): DecorationSet {
  const from = state.active ?? "";
  const b = new RangeSetBuilder<Decoration>();
  let fence = false;
  let pos = 0;
  for (const text of st.doc.iterLines()) {
    if (/^\s*(```|~~~)/.test(text)) fence = !fence;
    else if (!fence && text.includes("![[")) {
      const m = /^\s*!\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]\s*$/.exec(text);
      if (m && !ASSET.test(m[1].split("#")[0].trim())) {
        b.add(pos + text.length, pos + text.length, Decoration.widget({ widget: new EmbedWidget(m[1].trim(), from), block: true, side: 1 }));
      }
    }
    pos += text.length + 1;
  }
  return b.finish();
}

const embedField = StateField.define<DecorationSet>({
  create: (st) => buildEmbeds(st),
  update(deco, tr) {
    if (!tr.docChanged) return deco;
    // Rebuild only when an embed line could have changed.
    let touched = false;
    tr.changes.iterChangedRanges((_a, _b, fa, ta) => {
      const s = tr.state.doc.lineAt(fa).from;
      const e = tr.state.doc.lineAt(ta).to;
      if (tr.state.sliceDoc(s, e).includes("![[") || /```|~~~/.test(tr.state.sliceDoc(s, e))) touched = true;
    });
    tr.changes.iterChangedRanges((fa, ta) => {
      const s = tr.startState.doc.lineAt(fa).from;
      const e = tr.startState.doc.lineAt(ta).to;
      if (tr.startState.sliceDoc(s, e).includes("![[") || /```|~~~/.test(tr.startState.sliceDoc(s, e))) touched = true;
    });
    return touched ? buildEmbeds(tr.state) : deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Live embeds of notes, headings and blocks (live preview only). */
export const liveEmbeds: Extension = embedField;

/** Block features for every Markdown note. */
export function blockExtensions(): Extension {
  return [flashField, blockIdPlugin, linkHover, footnotePeek];
}
