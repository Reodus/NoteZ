import { EditorView } from "@codemirror/view";

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

  view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y }) });
  view.focus();

  let attempts = 0;
  const settle = () => {
    if (!view.dom.isConnected || view.state.doc !== doc || view.state.selection.main.head !== position) return cancel();
    const bounds = scroll.getBoundingClientRect();
    const caret = view.coordsAtPos(position);
    const { from, to } = view.viewport;
    if (position >= from && position <= to && caret && caret.top >= bounds.top && caret.bottom <= bounds.bottom) return cancel();
    if (++attempts > 8) return cancel();

    // The selected line can be rendered in a separate viewport while the
    // main viewport is still at the old scroll position.
    const block = view.lineBlockAt(position);
    const midpoint = caret ? (caret.top + caret.bottom) / 2 : view.documentTop + (block.top + block.bottom) / 2;
    scroll.scrollTop += midpoint - (bounds.top + bounds.bottom) / 2;
    view.requestMeasure();
    frame = requestAnimationFrame(settle);
  };
  frame = requestAnimationFrame(settle);
}
