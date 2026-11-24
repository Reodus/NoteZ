import type { EditorView } from "@codemirror/view";

const pending = new WeakMap<EditorView, () => void>();

/** Keep a jump aimed at the selected text while CodeMirror replaces
 * offscreen height estimates with measurements. */
export function revealEditorPosition(view: EditorView, position: number, y: "nearest" | "center" = "center") {
  pending.get(view)?.();
  const { doc } = view.state;
  const controller = new AbortController();
  let frame = 0;
  const cancel = () => {
    cancelAnimationFrame(frame);
    controller.abort();
    pending.delete(view);
  };
  pending.set(view, cancel);
  const options = { capture: true, passive: true, signal: controller.signal };
  const scroll = view.scrollDOM;
  scroll.addEventListener("wheel", cancel, options);
  scroll.addEventListener("pointerdown", cancel, options);
  scroll.addEventListener("touchstart", cancel, options);
  view.dom.addEventListener("keydown", cancel, options);

  view.dispatch({ selection: { anchor: position } });
  view.focus();

  let framesLeft = 16;
  let visibleFrames = 0;
  let center = y === "center";
  const settle = () => {
    if (!view.dom.isConnected || view.state.doc !== doc || view.state.selection.main.head !== position) return cancel();
    const caret = view.coordsAtPos(position);
    const { from, to } = view.viewport;
    const rendered = position >= from && position <= to;
    const bounds = scroll.getBoundingClientRect();
    if (!center && rendered && caret && caret.top >= bounds.top && caret.bottom <= bounds.bottom) {
      if (++visibleFrames === 2) return cancel();
    } else {
      visibleFrames = 0;
      center = false;
      // A distant selection can have DOM coordinates in a separate range.
      // Use the document's height map until the main viewport reaches it.
      const block = view.lineBlockAt(position);
      const midpoint = rendered && caret ? (caret.top + caret.bottom) / 2 : view.documentTop + (block.top + block.bottom) / 2;
      scroll.scrollTop += midpoint - (bounds.top + bounds.bottom) / 2;
      view.requestMeasure();
    }
    if (--framesLeft === 0) return cancel();
    frame = requestAnimationFrame(settle);
  };
  settle();
}
