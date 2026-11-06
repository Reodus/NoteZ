// Dragging a panel edge. The handle captures the pointer, so the drag keeps
// working over the PDF preview / iframes (which would otherwise swallow the
// moves and the release) and when the button is released outside the window.
// It starts from the panel's rendered width, not the stored one: CSS limits
// (max-width, a smaller window) can make them differ, and starting from the
// stored value left a dead zone before the panel moved.

/**
 * Start resizing `panel` from a pointerdown on its handle. `grow` is +1 when
 * dragging right widens the panel, -1 when dragging left does (before RTL
 * mirroring, which is applied here). `set` receives the new width.
 */
export function startResize(e: PointerEvent, panel: HTMLElement, grow: 1 | -1, set: (w: number) => void) {
  if (e.button !== 0) return;
  e.preventDefault();
  const handle = e.currentTarget as HTMLElement;
  const rtl = getComputedStyle(panel).direction === "rtl";
  const sign = rtl ? -grow : grow;
  const startX = e.clientX;
  const startW = panel.getBoundingClientRect().width;
  let frame = 0;
  let last = e.clientX;
  const move = (m: PointerEvent) => {
    last = m.clientX;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      set(Math.round(startW + sign * (last - startX)));
    });
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", stop);
    handle.removeEventListener("pointercancel", stop);
    handle.removeEventListener("lostpointercapture", stop);
    document.body.classList.remove("resizing");
  };
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing");
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  handle.addEventListener("lostpointercapture", stop);
}
