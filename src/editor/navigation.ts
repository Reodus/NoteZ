import { EditorView } from "@codemirror/view";

const pending = new WeakMap<EditorView, () => void>();

function isVisible(view: EditorView, position: number, caret: ReturnType<EditorView["coordsAtPos"]>, bounds: DOMRect) {
  const { from, to } = view.viewport;
  return position >= from && position <= to && caret && caret.top >= bounds.top && caret.bottom <= bounds.bottom;
}

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

  // Center offscreen targets so that estimated heights do not place them on
  // the edge of the viewport before the destination has been measured.
  const align = y === "nearest" && isVisible(view, position, view.coordsAtPos(position), scroll.getBoundingClientRect())
    ? "nearest" : "center";
  view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: align }) });
  view.focus();

  let framesLeft = 32;
  let visibleFrames = 0;
  const settle = () => {
    if (!view.dom.isConnected || view.state.doc !== doc || view.state.selection.main.head !== position) return cancel();
    const bounds = scroll.getBoundingClientRect();
    const caret = view.coordsAtPos(position);
    if (isVisible(view, position, caret, bounds)) {
      if (++visibleFrames === 2) return cancel();
    } else {
      visibleFrames = 0;
      const block = view.lineBlockAt(position);
      const midpoint = caret ? (caret.top + caret.bottom) / 2 : view.documentTop + (block.top + block.bottom) / 2;
      const delta = midpoint - (bounds.top + bounds.bottom) / 2;
      // Keep successive viewports overlapping. A distant caret can initially
      // sit in a separate rendered range surrounded by estimated gaps.
      const step = scroll.clientHeight / 2;
      scroll.scrollTop += Math.max(-step, Math.min(step, delta));
      view.requestMeasure();
    }
    if (--framesLeft === 0) return cancel();
    frame = requestAnimationFrame(settle);
  };
  frame = requestAnimationFrame(settle);
}
