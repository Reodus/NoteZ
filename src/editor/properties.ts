// Editable Properties card (Obsidian-style) for a note's YAML frontmatter,
// plus the big document title (`title:`). Every edit goes through the
// `yaml` Document API (comments and key order survive) as one undo step.
import { WidgetType, EditorView } from "@codemirror/view";
import { parseDocument } from "yaml";
import { editFrontmatter, renameFrontmatterKey } from "../core/frontmatter";
import { getLiveOpts, inlineHtml } from "./livepreview";

type Scalar = string | number | boolean | null;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isScalar = (v: unknown): v is Scalar => v === null || ["string", "number", "boolean"].includes(typeof v);

function parse(src: string): [string, unknown][] {
  const yaml = src.split("\n").slice(1, -1).join("\n");
  try {
    const js = parseDocument(yaml).toJS();
    return js && typeof js === "object" && !Array.isArray(js) ? Object.entries(js) : [];
  } catch {
    return [];
  }
}

const show = (v: unknown) => (v == null ? "" : String(v));

/** Scalar typed in a text field → YAML value (numbers stay numbers). */
function typed(s: string, old: unknown): Scalar {
  const t = s.trim();
  if (t === "") return null;
  if (typeof old === "number" && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** A one-line contenteditable that shows rendered Markdown until focused. */
function inlineEditor(raw: string, placeholder: string, commit: (v: string) => void, render = true): HTMLElement {
  const el = h("div", "nz-prop-edit");
  el.contentEditable = "true";
  el.spellcheck = false;
  el.dir = "auto";
  el.dataset.placeholder = placeholder;
  let value = raw;
  const paint = () => (render ? (el.innerHTML = inlineHtml(value)) : (el.textContent = value));
  paint();
  el.addEventListener("focus", () => {
    if (el.textContent !== value) el.textContent = value;
  });
  el.addEventListener("mousedown", (e) => {
    const link = (e.target as HTMLElement).closest?.(".cm-nz-lp-link") as HTMLElement | null;
    if (link && document.activeElement !== el) {
      e.preventDefault();
      getLiveOpts()?.openLink(link.dataset.target ?? "");
    }
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      el.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      el.textContent = value;
      el.blur();
    }
  });
  el.addEventListener("paste", (e) => {
    e.preventDefault();
    const t = e.clipboardData?.getData("text/plain").replace(/\s*\n\s*/g, " ") ?? "";
    document.execCommand("insertText", false, t);
  });
  el.addEventListener("blur", () => {
    const next = (el.textContent ?? "").replace(/ /g, " ").trim();
    if (next !== value) {
      value = next;
      commit(next);
    }
    paint();
  });
  return el;
}

export class PropertiesWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }
  eq(o: PropertiesWidget) {
    return o.src === this.src;
  }
  ignoreEvent() {
    return true; // the card handles its own mouse/keyboard
  }

  toDOM(view: EditorView): HTMLElement {
    const outer = h("div", "nz-props-wrap");
    this.fill(outer, view);
    // A rebuild requested while the user was typing waits until focus leaves.
    outer.addEventListener("focusout", (e) => {
      if (outer.contains(e.relatedTarget as Node)) return;
      const pending = (outer as any)._pending as PropertiesWidget | undefined;
      if (pending) requestAnimationFrame(() => pending.fill(outer, view));
    });
    return outer;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    if (dom.contains(document.activeElement)) (dom as any)._pending = this;
    else this.fill(dom, view);
    return true;
  }

  private fill(outer: HTMLElement, view: EditorView) {
    (outer as any)._pending = undefined;
    outer.replaceChildren();
    const props = parse(this.src);
    const set = (key: string, value: unknown) =>
      editFrontmatter(view, (d) => d.set(key, value === null ? null : d.createNode(value)));
    const del = (key: string) => editFrontmatter(view, (d) => void d.delete(key));

    const card = h("div", "cm-nz-lp-props");
    const head = h("div", "cm-nz-lp-props-title", "Properties");
    const raw = h("button", "nz-prop-btn nz-prop-raw", "</>");
    raw.title = "Edit as YAML";
    raw.addEventListener("click", () => {
      view.dispatch({ selection: { anchor: 4 }, scrollIntoView: true });
      view.focus();
    });
    head.append(raw);
    card.append(head);

    const grid = h("div", "cm-nz-lp-props-grid");
    for (const [key, value] of props) {
      const k = inlineEditor(key, "name", (v) => (v ? renameFrontmatterKey(view, key, v) : del(key)), false);
      k.classList.add("k");
      const v = h("div", "v");
      v.dir = "auto";
      if (typeof value === "boolean") {
        const cb = h("input");
        cb.type = "checkbox";
        cb.checked = value;
        cb.addEventListener("change", () => set(key, cb.checked));
        v.append(cb);
      } else if (typeof value === "string" && DATE.test(value)) {
        const inp = h("input", "nz-prop-date");
        inp.type = "date";
        inp.value = value;
        inp.addEventListener("change", () => inp.value && set(key, inp.value));
        v.append(inp);
      } else if (Array.isArray(value) && value.every(isScalar)) {
        v.append(this.chips(value as Scalar[], (next) => set(key, next.length ? next : null)));
      } else if (isScalar(value)) {
        v.append(inlineEditor(show(value), "empty", (s) => set(key, typed(s, value))));
      } else {
        const more = h("button", "nz-prop-btn", "Edit YAML…");
        more.addEventListener("click", () => raw.click());
        v.append(h("span", "more", Array.isArray(value) ? `${value.length} items` : "{…}"), more);
      }
      const x = h("button", "nz-prop-btn nz-prop-del", "×");
      x.title = `Remove "${key}"`;
      x.addEventListener("click", () => del(key));
      v.append(x);
      grid.append(k, v);
    }
    card.append(grid);

    const add = h("button", "nz-prop-btn nz-prop-add", "+ Add property");
    add.addEventListener("click", () => {
      const name = inlineEditor("", "property name", (n) => {
        const key = n.replace(/:/g, "").trim();
        if (key && !props.some(([k]) => k === key)) set(key, null);
      }, false);
      name.classList.add("k");
      grid.append(name, h("div", "v"));
      add.remove();
      name.focus();
    });
    card.append(add);
    outer.append(card);

    // The `title:` property is the document title, shown like the PDF does.
    const title = props.find(([k]) => k === "title");
    if (title && isScalar(title[1])) {
      const t = inlineEditor(show(title[1]), "Untitled", (s) => set("title", s || null));
      t.classList.add("cm-nz-lp-doc-title");
      outer.append(t);
    }
  }

  private chips(items: Scalar[], commit: (next: Scalar[]) => void): HTMLElement {
    const box = h("div", "nz-chips");
    items.forEach((it, i) => {
      const c = h("span", "nz-chip");
      c.dir = "auto";
      c.innerHTML = inlineHtml(show(it));
      const x = h("button", "", "×");
      x.addEventListener("click", () => commit(items.filter((_, j) => j !== i)));
      c.append(x);
      box.append(c);
    });
    const inp = h("input", "nz-chip-input");
    inp.placeholder = items.length ? "" : "add…";
    inp.dir = "auto";
    inp.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === ",") && inp.value.trim()) {
        e.preventDefault();
        commit([...items, inp.value.trim().replace(/^#/, "")]);
      } else if (e.key === "Backspace" && !inp.value && items.length) {
        commit(items.slice(0, -1));
      }
    });
    inp.addEventListener("blur", () => inp.value.trim() && commit([...items, inp.value.trim().replace(/^#/, "")]));
    box.append(inp);
    return box;
  }
}
