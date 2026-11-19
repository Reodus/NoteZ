import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { t } from "../core/i18n";

class FootnoteComposer {
  private close: (() => void) | undefined;

  constructor(readonly view: EditorView) {}

  open(pos: number, commit: (text: string) => void) {
    this.close?.();
    const view = this.view;
    const listeners = new AbortController();
    const signal = listeners.signal;
    const popup = document.createElement("div");
    popup.className = "nz-footnote-compose";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", t("Footnote"));
    const input = document.createElement("textarea");
    input.dir = "auto";
    input.rows = 2;
    input.placeholder = t("Footnote text");
    input.setAttribute("aria-label", input.placeholder);
    const keys = document.createElement("div");
    keys.className = "nz-footnote-compose-keys";
    keys.textContent = t("Enter to insert · Shift+Enter for a new line");
    input.setAttribute("aria-description", keys.textContent);
    popup.append(input, keys);
    document.body.append(popup);

    let frame = 0;
    const finish = (focus: boolean) => {
      listeners.abort();
      cancelAnimationFrame(frame);
      popup.remove();
      this.close = undefined;
      if (focus) view.focus();
    };
    this.close = () => finish(false);

    const place = () => {
      frame = 0;
      const bounds = view.scrollDOM.getBoundingClientRect();
      const caret = view.coordsAtPos(pos, -1) ?? bounds;
      const gap = 6;
      const left = Math.max(bounds.left, 0) + gap;
      const right = Math.min(bounds.right, window.innerWidth) - gap;
      const top = Math.max(bounds.top, 0) + gap;
      const bottom = Math.min(bounds.bottom, window.innerHeight) - gap;
      popup.style.maxWidth = `${Math.max(0, right - left)}px`;
      popup.style.maxHeight = `${Math.max(0, bottom - top)}px`;
      const { width, height } = popup.getBoundingClientRect();
      const x = Math.max(left, Math.min(caret.left, right - width));
      const y = caret.bottom + gap + height <= bottom ? caret.bottom + gap : caret.top - gap - height;
      popup.style.left = `${x}px`;
      popup.style.top = `${Math.max(top, Math.min(y, bottom - height))}px`;
      if (!popup.classList.contains("visible")) {
        popup.classList.add("visible");
        input.focus({ preventScroll: true });
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };

    popup.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        const body = input.value.trim();
        if (!body) return;
        finish(false);
        commit(body);
        view.focus();
      }
    }, { signal });
    document.addEventListener("pointerdown", (e) => {
      if (!popup.contains(e.target as Node)) finish(false);
    }, { signal, capture: true });
    view.scrollDOM.addEventListener("scroll", schedule, { signal, passive: true });
    window.addEventListener("resize", schedule, { signal });
    schedule();
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet) this.close?.();
  }

  destroy() {
    this.close?.();
  }
}

export const footnoteComposer = ViewPlugin.fromClass(FootnoteComposer);
