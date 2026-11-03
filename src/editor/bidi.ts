// Per-line text direction: every line gets dir="auto", so the browser picks
// RTL/LTR from the line's first strong character (Persian → RTL, Latin → LTR).
// perLineTextDirection makes CodeMirror's cursor motion respect it.
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

const autoDir = Decoration.line({ attributes: { dir: "auto" } });

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      b.add(line.from, line.from, autoDir);
      pos = line.to + 1;
    }
  }
  return b.finish();
}

const autoDirPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

export const bidi = [EditorView.perLineTextDirection.of(true), autoDirPlugin];
