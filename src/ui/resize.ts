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
  let moved = false;
  const move = (m: PointerEvent) => {
    if (m.pointerId !== e.pointerId) return;
    moved = true;
    last = m.clientX;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      set(Math.round(startW + sign * (last - startX)));
    });
  };
  const finish = () => {
    cancelAnimationFrame(frame);
    if (moved) set(Math.round(startW + sign * (last - startX)));
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", stop, true);
    window.removeEventListener("pointercancel", stop, true);
    window.removeEventListener("blur", finish);
    handle.removeEventListener("lostpointercapture", lost);
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    document.body.classList.remove("resizing");
    handle.classList.remove("nz-resize-active");
  };
  const stop = (event: PointerEvent) => { if (event.pointerId === e.pointerId) finish(); };
  // Window tracking can continue when Chromium releases capture while held.
  const lost = (event: PointerEvent) => { if (!event.buttons) stop(event); };
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing");
  handle.classList.add("nz-resize-active");
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", stop, true);
  window.addEventListener("pointercancel", stop, true);
  window.addEventListener("blur", finish);
  handle.addEventListener("lostpointercapture", lost);
}
