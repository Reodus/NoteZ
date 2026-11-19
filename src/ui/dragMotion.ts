import { prefs } from "../core/store";

const ease = "cubic-bezier(.2,.7,.2,1)";
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const running = new Set<Animation>();
let nativeSource: HTMLElement | undefined;
let nativeRect: DOMRect | undefined;
let nativeOffset = { x: 0, y: 0 };
let nativeCarry: ReturnType<typeof carryDrag>;
let nativeListeners: AbortController | undefined;
const transparentDragImage = document.createElement("canvas");
transparentDragImage.width = transparentDragImage.height = 1;

export const dragMotionEnabled = () => prefs.animations && !reduced.matches;

function animate(el: HTMLElement, frames: Keyframe[], duration = 180) {
  if (!dragMotionEnabled()) return;
  const animation = el.animate(frames, { duration, easing: ease });
  running.add(animation);
  void animation.finished.catch(() => {}).finally(() => running.delete(animation));
  return animation;
}

export function cancelDragAnimations() {
  for (const animation of running) animation.cancel();
}

reduced.addEventListener("change", () => {
  if (reduced.matches) cancelDragAnimations();
});

export function startNativeDrag(e: DragEvent, source: HTMLElement) {
  endNativeDrag();
  cancelDragAnimations();
  nativeSource = source;
  nativeRect = source.getBoundingClientRect();
  nativeOffset = { x: e.clientX - nativeRect.left, y: e.clientY - nativeRect.top };
  nativeCarry = carryDrag([source], nativeRect, e);
  if (nativeCarry) {
    transparentDragImage.style.cssText = "position:fixed;top:0;left:0;pointer-events:none";
    document.body.append(transparentDragImage);
    e.dataTransfer?.setDragImage(transparentDragImage, 0, 0);
    nativeListeners = new AbortController();
    const { signal } = nativeListeners;
    document.addEventListener("dragover", ev => nativeCarry?.move(ev), { capture: true, signal });
    document.addEventListener("dragend", () => endNativeDrag(source), { signal });
    window.addEventListener("blur", () => endNativeDrag(source), { signal });
  } else {
    e.dataTransfer?.setDragImage(source, Math.max(0, nativeOffset.x), Math.max(0, nativeOffset.y));
    source.classList.add("nz-native-drag-source");
  }
}

export function endNativeDrag(source?: HTMLElement) {
  if (source && source !== nativeSource) return;
  nativeSource?.classList.remove("nz-native-drag-source");
  nativeListeners?.abort();
  nativeListeners = undefined;
  nativeCarry?.remove();
  nativeCarry = undefined;
  transparentDragImage.remove();
  nativeSource = undefined;
  nativeRect = undefined;
}

export function nativeDropRect(e: DragEvent) {
  if (!nativeRect || (!e.clientX && !e.clientY)) return nativeRect;
  return new DOMRect(e.clientX - nativeOffset.x, e.clientY - nativeOffset.y, nativeRect.width, nativeRect.height);
}

function overlay(label: string, rect: DOMRect, className: string) {
  const el = document.createElement("div");
  el.className = className;
  el.setAttribute("aria-hidden", "true");
  el.textContent = label;
  Object.assign(el.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  document.body.append(el);
  return el;
}

function visualCopy(item: HTMLElement) {
  const copy = item.cloneNode(true) as HTMLElement;
  copy.removeAttribute("id");
  for (const child of copy.querySelectorAll("[id]")) child.removeAttribute("id");
  copy.inert = true;
  return copy;
}

/** Carry the complete rendered item using an inert layer over its real layout. */
export function carryDrag(items: HTMLElement[], rect: DOMRect, start: MouseEvent, vertical = false) {
  if (!items.length || !dragMotionEnabled()) return;
  const el = overlay("", rect, "nz-drag-float nz-drag-carry");
  el.dir = getComputedStyle(items[0]).direction;
  el.style.font = getComputedStyle(items[0]).font;
  for (const item of items) {
    const bounds = item.getBoundingClientRect();
    const copy = visualCopy(item);
    Object.assign(copy.style, {
      position: "absolute", left: `${bounds.left - rect.left}px`, top: `${bounds.top - rect.top}px`,
      width: `${bounds.width}px`, height: `${bounds.height}px`, margin: "0",
      color: getComputedStyle(item).color, font: getComputedStyle(item).font,
    });
    el.append(copy);
    item.classList.add("nz-drag-projected");
  }
  const remove = () => {
    el.remove();
    items.forEach(item => item.classList.remove("nz-drag-projected"));
  };
  return {
    move(point: MouseEvent) {
      el.style.translate = `${vertical ? 0 : point.clientX - start.clientX}px ${point.clientY - start.clientY}px`;
    },
    remove,
  };
}

export function dragItems(scope: ParentNode, selector: string, key: (el: HTMLElement) => string) {
  return new Map([...scope.querySelectorAll<HTMLElement>(selector)].map(el => [key(el), el]));
}

export function settleDragItems(
  before: Map<string, DOMRect>, after: Map<string, HTMLElement>, moved?: { key: string; rect?: DOMRect },
) {
  if (!dragMotionEnabled()) return;
  for (const [key, el] of after) {
    const previous = key === moved?.key ? moved.rect ?? before.get(key) : before.get(key);
    if (!previous) continue;
    const now = el.getBoundingClientRect();
    const x = previous.left - now.left, y = previous.top - now.top;
    if (Math.hypot(x, y) < 1) continue;
    animate(el, [{ translate: `${x}px ${y}px` }, { translate: "0px 0px" }]);
  }
}

export function pulseDrop(el?: HTMLElement | null) {
  if (el) animate(el, [{ backgroundColor: "var(--accent-softer)" }, { backgroundColor: "transparent" }]);
}

/** Out-of-flow previews leave the hit targets in their original layout. */
export class DragProjection {
  private entries = new Map<HTMLElement, HTMLElement>();

  show(offsets: Map<HTMLElement, { x: number; y: number }>, clip?: DOMRect) {
    if (!dragMotionEnabled()) return this.clear();
    for (const [item, preview] of this.entries) {
      if (!item.isConnected) {
        item.classList.remove("nz-drag-projected");
        preview.remove();
        this.entries.delete(item);
      } else if (!offsets.has(item)) {
        offsets.set(item, { x: 0, y: 0 });
      }
    }
    for (const [item, offset] of offsets) {
      const rect = item.getBoundingClientRect();
      let preview = this.entries.get(item);
      if (!preview) {
        preview = overlay("", rect, "nz-drag-projection");
        const copy = visualCopy(item);
        preview.append(copy);
        const style = getComputedStyle(item);
        preview.dir = style.direction;
        preview.style.font = style.font;
        preview.style.color = style.color;
        item.classList.add("nz-drag-projected");
        this.entries.set(item, preview);
        preview.getBoundingClientRect();
      }
      const wrapper = preview.firstElementChild as HTMLElement;
      Object.assign(preview.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      if (clip) {
        const inset = [clip.top - rect.top, rect.right - clip.right, rect.bottom - clip.bottom, clip.left - rect.left];
        preview.style.clipPath = `inset(${inset.map((n, i) => `${Math.max(i % 2 ? -Math.abs(offset.x) : -Math.abs(offset.y), n)}px`).join(" ")})`;
      }
      wrapper.style.translate = `${offset.x}px ${offset.y}px`;
    }
  }

  capture(items: Map<string, HTMLElement>) {
    return new Map([...items].map(([key, el]) => [key, (this.entries.get(el)?.firstElementChild ?? el).getBoundingClientRect()]));
  }

  cancel(items: Map<string, HTMLElement>) {
    const before = this.capture(items);
    this.clear();
    settleDragItems(before, items);
  }

  clear() {
    for (const [item, preview] of this.entries) {
      item.classList.remove("nz-drag-projected");
      preview.remove();
    }
    this.entries.clear();
  }
}
