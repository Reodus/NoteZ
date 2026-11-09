// WYSIWYM styling: the editor mirrors the document's styles — heading
// sizes/colors/fonts from the theme, `::: {align=…}` blocks aligned,
// `[text]{color=…}` spans colored — while staying plain text underneath.
import { RangeSetBuilder, StateEffect, StateField, Extension } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Theme, TextStyle } from "../core/ipc";
import { parseAttrs } from "./format";

export const markdownHighlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "inherit" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--fg-muted)", fontSize: "0.9em" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", fontSize: "0.88em", background: "var(--code-bg)", borderRadius: "4px" },
  { tag: t.quote, color: "var(--fg-soft)", fontStyle: "italic" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--fg-faint)" },
  { tag: t.comment, color: "var(--fg-faint)", fontStyle: "italic" },
  { tag: [t.keyword, t.modifier], color: "var(--syn-keyword)" },
  { tag: [t.function(t.variableName), t.function(t.name)], color: "var(--syn-func)" },
  { tag: t.string, color: "var(--syn-string)" },
  { tag: t.number, color: "var(--syn-number)" },
  { tag: [t.labelName, t.atom, t.bool], color: "var(--syn-atom)" },
  { tag: [t.variableName, t.propertyName], color: "var(--fg)" },
  { tag: t.typeName, color: "var(--syn-type)" },
  { tag: t.operator, color: "var(--fg-muted)" },
]);

// ------------------------------------------------- theme → CSS variables

const PT_TO_EM = (pt: string | null | undefined, body: number) => {
  const m = /^([\d.]+)pt$/.exec(pt ?? "");
  return m ? `${(Number(m[1]) / body).toFixed(3)}em` : null;
};

/** A style's fonts (main font, per-script fonts, old `font-fa`), then the editor's stack. */
const fontStack = (st: TextStyle) =>
  [st.font, ...Object.values(st.fonts ?? {}), st["font-fa"]]
    .filter(Boolean)
    .map((f) => `"${String(f).replace(/"/g, "")}"`)
    .concat(["var(--font-editor)"])
    .join(", ");
const hasFont = (st: TextStyle) => !!(st.font || st["font-fa"] || Object.keys(st.fonts ?? {}).length);

const WEIGHTS: Record<string, string> = {
  thin: "100", extralight: "200", light: "300", regular: "400", medium: "500",
  semibold: "600", bold: "700", extrabold: "800", black: "900",
};

/** CSS custom properties applied on the editor root for the note's theme. */
export function themeCss(theme: Theme | null): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!theme) return vars;
  const body = theme.styles.body ?? {};
  const bodyPt = Number(/^([\d.]+)pt$/.exec(body.size ?? "")?.[1] ?? 11);
  vars["--doc-font"] = fontStack(body);
  if (body.align === "justify") vars["--doc-align"] = "justify";
  for (const key of ["h1", "h2", "h3", "h4", "h5", "h6", "title"]) {
    const st = theme.styles[key];
    if (!st) continue;
    const size = PT_TO_EM(st.size, bodyPt);
    if (size) vars[`--${key}-size`] = size;
    if (st.color) vars[`--${key}-color`] = st.color;
    if (hasFont(st)) vars[`--${key}-font`] = fontStack(st);
    if (st.weight) vars[`--${key}-weight`] = WEIGHTS[st.weight] ?? st.weight;
    if (st.italic) vars[`--${key}-style`] = "italic";
    if (st.align) vars[`--${key}-align`] = st.align === "start" ? "start" : st.align;
  }
  return vars;
}

// ---------------------------------------------------------- decorations

const lineDeco = (cls: string, attrs: Record<string, string> = {}) => Decoration.line({ class: cls, attributes: attrs });

const SYNTAX = Decoration.mark({ class: "cm-nz-syntax" });

function spanStyle(attrs: Record<string, string>): string {
  const css: string[] = [];
  if (attrs.color) css.push(`color:${attrs.color}`);
  if (attrs.font) css.push(`font-family:"${attrs.font}",var(--font-editor)`);
  if (attrs.size) {
    const m = /^([\d.]+)(pt|em)$/.exec(attrs.size);
    if (m) css.push(`font-size:${m[2] === "pt" ? (Number(m[1]) / 11).toFixed(2) + "em" : attrs.size}`);
  }
  if ("highlight" in attrs || "bg" in attrs) css.push(`background:${attrs.highlight || attrs.bg || "#fff3a3"};color:#111;border-radius:3px`);
  if ("underline" in attrs) css.push("text-decoration:underline");
  if ("strike" in attrs) css.push("text-decoration:line-through");
  if ("bold" in attrs) css.push("font-weight:700");
  if ("italic" in attrs) css.push("font-style:italic");
  return css.join(";");
}

function build(view: EditorView, typstMode: boolean): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  // Div context must be computed from the top (cheap: line scan).
  const divStack: Record<string, string>[] = [];
  let inFence = false;
  let inFrontmatter = doc.lines > 0 && doc.line(1).text === "---" && !typstMode;
  const visible = view.visibleRanges;
  const isVisible = (from: number, to: number) => visible.some((r) => to >= r.from && from <= r.to);

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;
    const show = isVisible(line.from, line.to);

    if (inFrontmatter) {
      if (show) b.add(line.from, line.from, lineDeco("cm-nz-frontmatter"));
      if (i > 1 && (text === "---" || text === "...")) inFrontmatter = false;
      continue;
    }
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      if (show) b.add(line.from, line.from, lineDeco("cm-nz-fence-line"));
      continue;
    }
    if (inFence) {
      if (show) b.add(line.from, line.from, lineDeco("cm-nz-code-line"));
      continue;
    }
    if (typstMode) {
      const h = /^(=+)\s/.exec(text);
      if (h && show) b.add(line.from, line.from, lineDeco(`cm-nz-h cm-nz-h${Math.min(6, h[1].length)}`));
      continue;
    }

    const divOpen = /^\s*:::\s*(\{.*\}|\S.*)\s*$/.exec(text);
    const divClose = /^\s*:::\s*$/.test(text);
    if (divOpen && !divClose) {
      divStack.push(parseAttrs(divOpen[1]));
      if (show) b.add(line.from, line.from, lineDeco("cm-nz-div-marker"));
      continue;
    }
    if (divClose) {
      divStack.pop();
      if (show) b.add(line.from, line.from, lineDeco("cm-nz-div-marker"));
      continue;
    }
    if (!show) continue;

    const merged: Record<string, string> = Object.assign({}, ...divStack);
    const classes: string[] = [];
    const style: string[] = [];
    const h = /^(#{1,6})\s/.exec(text);
    if (h) classes.push("cm-nz-h", `cm-nz-h${h[1].length}`);
    else if (/^>\s?/.test(text)) classes.push("cm-nz-quote");
    if (merged.align) style.push(`text-align:${merged.align === "justify" ? "justify" : merged.align}`);
    if (merged.color) style.push(`color:${merged.color}`);
    if (merged.font) style.push(`font-family:"${merged.font}",var(--font-editor)`);
    if (merged.box !== undefined) classes.push("cm-nz-boxed");
    const attrs: Record<string, string> = {};
    if (style.length) attrs.style = style.join(";");
    if (merged.dir === "rtl" || merged.dir === "ltr") attrs.dir = merged.dir;
    if (divStack.length) classes.push("cm-nz-in-div");
    if (classes.length || Object.keys(attrs).length) b.add(line.from, line.from, lineDeco(classes.join(" "), attrs));

    // Inline spans: [text]{attrs}
    const re = /\[([^\]]*)\]\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = line.from + m.index;
      const innerFrom = start + 1;
      const innerTo = innerFrom + m[1].length;
      const end = start + m[0].length;
      b.add(start, innerFrom, SYNTAX);
      const css = spanStyle(parseAttrs(m[2]));
      if (css && innerTo > innerFrom) b.add(innerFrom, innerTo, Decoration.mark({ class: "cm-nz-span", attributes: { style: css } }));
      b.add(innerTo, end, SYNTAX);
    }
  }
  return b.finish();
}

const setTypstMode = StateEffect.define<boolean>();
const typstModeField = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setTypstMode) ? e.value : acc), v),
});

const wysiwym = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view, view.state.field(typstModeField));
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setTypstMode)))) {
        this.decorations = build(u.view, u.state.field(typstModeField));
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export function styling(typstMode: boolean): Extension {
  return [typstModeField.init(() => typstMode), wysiwym, syntaxHighlighting(markdownHighlight)];
}
