import { createSignal, For, JSX, onCleanup, onMount, Show, splitProps } from "solid-js";
import { Portal } from "solid-js/web";
import { X } from "lucide-solid";
import { app, dismissToast } from "../core/app";

// ------------------------------------------------------------------ Modal

export function Modal(props: {
  title?: string;
  subtitle?: string;
  width?: string;
  onClose: () => void;
  children: JSX.Element;
  footer?: JSX.Element;
  class?: string;
}) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      props.onClose();
    }
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  return (
    <Portal>
      <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
        <div class={`modal ${props.class ?? ""}`} style={{ width: props.width ?? "520px" }} role="dialog">
          <Show when={props.title}>
            <header class="modal-head">
              <div>
                <h2>{props.title}</h2>
                <Show when={props.subtitle}>
                  <p>{props.subtitle}</p>
                </Show>
              </div>
              <button class="icon-btn" onClick={props.onClose} title="Close (Esc)">
                <X size={18} />
              </button>
            </header>
          </Show>
          <div class="modal-body">{props.children}</div>
          <Show when={props.footer}>
            <footer class="modal-foot">{props.footer}</footer>
          </Show>
        </div>
      </div>
    </Portal>
  );
}

// ---------------------------------------------------------------- Popover

/** Floating panels (popovers, combo lists) live in portals; each remembers
 * the element that opened it, so "inside" can follow nesting. */
const OWNER = Symbol("owner");
function markPortal(el: HTMLElement, owner: Element) {
  el.dataset.portal = "";
  (el as any)[OWNER] = owner;
}

/** Is `t` inside `root`, counting panels opened from within `root`? */
export function within(root: Element | undefined, t: EventTarget | null): boolean {
  let n = t instanceof Node ? t : null;
  for (let hops = 0; n && root && hops < 16; hops++) {
    if (root.contains(n)) return true;
    const el = n instanceof Element ? n : n.parentElement;
    const portal = el?.closest("[data-portal]") as HTMLElement | null;
    n = portal ? ((portal as any)[OWNER] as Element | undefined) ?? null : null;
  }
  return false;
}

/** A button that opens a floating panel below it. */
export function Popover(props: {
  trigger: (open: boolean) => JSX.Element;
  children: (close: () => void) => JSX.Element;
  title?: string;
  class?: string;
  align?: "start" | "end";
  disabled?: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ x: 0, y: 0 });
  let btn!: HTMLButtonElement;
  let panel: HTMLDivElement | undefined;

  const toggle = () => {
    if (props.disabled) return;
    const r = btn.getBoundingClientRect();
    setPos({ x: props.align === "end" ? r.right : r.left, y: r.bottom + 6 });
    setOpen(!open());
  };
  const onDoc = (e: MouseEvent) => {
    if (!open()) return;
    if (within(panel, e.target) || btn.contains(e.target as Node)) return;
    setOpen(false);
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
  onMount(() => {
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
  });
  onCleanup(() => {
    document.removeEventListener("mousedown", onDoc);
    window.removeEventListener("keydown", onKey);
  });

  return (
    <>
      <button
        ref={btn}
        class={`pop-trigger ${props.class ?? ""}`}
        classList={{ open: open() }}
        title={props.title}
        disabled={props.disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
      >
        {props.trigger(open())}
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={(el) => {
              panel = el;
              markPortal(el, btn);
              // Keep inside the window.
              requestAnimationFrame(() => {
                const r = el.getBoundingClientRect();
                if (r.right > window.innerWidth - 8) el.style.left = `${window.innerWidth - r.width - 8}px`;
                if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`;
              });
            }}
            class="popover"
            style={{
              left: props.align === "end" ? undefined : `${pos().x}px`,
              right: props.align === "end" ? `${window.innerWidth - pos().x}px` : undefined,
              top: `${pos().y}px`,
            }}
            onMouseDown={(e) => {
              // Keep editor selection while clicking inside menus (but allow inputs).
              const t = e.target as HTMLElement;
              if (!t.closest("input, select, textarea")) e.preventDefault();
            }}
          >
            {props.children(() => setOpen(false))}
          </div>
        </Portal>
      </Show>
    </>
  );
}

// ----------------------------------------------------------- Context menu

export interface MenuItem {
  label: string;
  icon?: JSX.Element;
  danger?: boolean;
  hint?: string;
  run: () => void;
  /** A submenu, shown on hover. */
  items?: (MenuItem | "-")[];
}

const [menu, setMenu] = createSignal<{ x: number; y: number; items: (MenuItem | "-")[] } | null>(null);

/** Open the context menu at a point (e.g. under a "more" button). */
export function openMenuAt(x: number, y: number, items: (MenuItem | "-")[]) {
  setMenu({ x, y, items });
}

export function openMenu(e: MouseEvent, items: (MenuItem | "-")[]) {
  e.preventDefault();
  e.stopPropagation();
  setMenu({ x: e.clientX, y: e.clientY, items });
}

export function MenuHost() {
  const close = () => setMenu(null);
  onMount(() => {
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
  });
  onCleanup(() => {
    window.removeEventListener("mousedown", close);
    window.removeEventListener("blur", close);
  });
  return (
    <Show when={menu()}>
      {(m) => (
        <Portal>
          <div
            class="context-menu"
            ref={(el) => {
              // Keep inside the window, measured once laid out.
              requestAnimationFrame(() => {
                const r = el.getBoundingClientRect();
                if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`;
                if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`;
              });
            }}
            style={{ left: `${m().x}px`, top: `${m().y}px` }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <MenuList items={m().items} close={close} />
          </div>
        </Portal>
      )}
    </Show>
  );
}

function MenuList(props: { items: (MenuItem | "-")[]; close: () => void }) {
  const [open, setOpen] = createSignal<number | null>(null);
  let hoverTimer = 0;
  return (
    <For each={props.items}>
      {(it, i) =>
        it === "-" ? (
          <div class="menu-sep" />
        ) : (
          <div
            class="menu-entry"
            onMouseEnter={() => {
              clearTimeout(hoverTimer);
              hoverTimer = window.setTimeout(() => setOpen(it.items ? i() : null), it.items ? 60 : 120);
            }}
          >
            <button
              class="menu-item"
              classList={{ danger: it.danger, "has-sub": !!it.items, open: open() === i() }}
              onClick={() => (it.items ? setOpen(i()) : (props.close(), it.run()))}
            >
              <span class="menu-icon">{it.icon}</span>
              <span class="menu-label">{it.label}</span>
              <Show when={it.hint}>
                <kbd>{it.hint}</kbd>
              </Show>
              <Show when={it.items}>
                <span class="menu-sub-caret">›</span>
              </Show>
            </button>
            <Show when={it.items && open() === i()}>
              <div
                class="context-menu submenu"
                ref={(el) =>
                  requestAnimationFrame(() => {
                    // Flip left / up when the submenu would leave the window.
                    const r = el.getBoundingClientRect();
                    if (r.right > window.innerWidth - 4) el.classList.add("left");
                    if (r.bottom > window.innerHeight - 4) el.style.top = `${Math.max(-r.top + 4, window.innerHeight - 4 - r.bottom)}px`;
                  })
                }
              >
                <MenuList items={it.items!} close={props.close} />
              </div>
            </Show>
          </div>
        )
      }
    </For>
  );
}

// ----------------------------------------------------------------- Prompt

interface PromptReq {
  title: string;
  initial: string;
  placeholder?: string;
  resolve: (v: string | null) => void;
}
const [promptReq, setPromptReq] = createSignal<PromptReq | null>(null);

export function askText(title: string, initial = "", placeholder?: string): Promise<string | null> {
  return new Promise((resolve) => setPromptReq({ title, initial, placeholder, resolve }));
}

export function PromptHost() {
  const close = (v: string | null) => {
    promptReq()?.resolve(v);
    setPromptReq(null);
  };
  return (
    <Show when={promptReq()}>
      {(req) => (
        <Modal onClose={() => close(null)} width="420px" class="prompt-modal">
          <form
            class="prompt"
            onSubmit={(e) => {
              e.preventDefault();
              const v = (e.currentTarget.elements.namedItem("v") as HTMLInputElement).value.trim();
              close(v || null);
            }}
          >
            <label>{req().title}</label>
            <input
              name="v"
              class="input"
              dir="auto"
              value={req().initial}
              placeholder={req().placeholder}
              ref={(el) =>
                setTimeout(() => {
                  el.focus();
                  const dot = el.value.lastIndexOf(".");
                  el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
                })
              }
            />
            <div class="row end">
              <button type="button" class="btn" onClick={() => close(null)}>Cancel</button>
              <button type="submit" class="btn primary">OK</button>
            </div>
          </form>
        </Modal>
      )}
    </Show>
  );
}

// ----------------------------------------------------------------- Toasts

export function Toasts() {
  return (
    <div class="toasts">
      <For each={app.toasts()}>
        {(t) => (
          <div class={`toast ${t.kind}`}>
            <span class="toast-msg">{t.message}</span>
            <Show when={t.action}>
              <button class="btn small" onClick={() => (t.action!.run(), dismissToast(t.id))}>{t.action!.label}</button>
            </Show>
            <button class="icon-btn small" onClick={() => dismissToast(t.id)}>
              <X size={14} />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

// ----------------------------------------------------------- Form helpers

export function Field(props: { label: string; children: JSX.Element; hint?: string; wide?: boolean }) {
  return (
    <label class="field" classList={{ wide: props.wide }}>
      <span class="field-label">{props.label}</span>
      {props.children}
      <Show when={props.hint}>
        <span class="field-hint">{props.hint}</span>
      </Show>
    </label>
  );
}

export function Segmented<T extends string>(props: {
  value: T | null | undefined;
  options: { value: T; label: JSX.Element; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div class="segmented">
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            classList={{ active: props.value === o.value }}
            title={o.title}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

export const SWATCHES = [
  "#1f2328", "#5b6478", "#9aa1ae", "#c0392b", "#e15759", "#f28e2b", "#d4a017", "#3fb68b",
  "#1f9d55", "#17becf", "#2f6fde", "#4e79d6", "#1d2b4f", "#6d5efc", "#9467bd", "#d6336c",
];

export function ColorGrid(props: { value?: string | null; onPick: (c: string | null) => void; allowNone?: boolean; noneLabel?: string }) {
  let input!: HTMLInputElement;
  return (
    <div class="color-grid">
      <div class="swatches">
        <For each={SWATCHES}>
          {(c) => (
            <button
              type="button"
              class="swatch"
              classList={{ active: props.value?.toLowerCase() === c }}
              style={{ background: c }}
              title={c}
              onClick={() => props.onPick(c)}
            />
          )}
        </For>
      </div>
      <div class="row">
        <Show when={props.allowNone !== false}>
          <button type="button" class="btn small" onClick={() => props.onPick(null)}>{props.noneLabel ?? "Default"}</button>
        </Show>
        <button type="button" class="btn small" onClick={() => input.click()}>Custom…</button>
        <input
          ref={input}
          type="color"
          class="hidden-color"
          value={props.value ?? "#000000"}
          onChange={(e) => props.onPick(e.currentTarget.value)}
        />
      </div>
    </div>
  );
}

/** A text input with a datalist-like filtered dropdown (font pickers). */
export function ComboBox(props: {
  value: string;
  options: string[];
  placeholder?: string;
  onChange: (v: string) => void;
  renderOption?: (o: string) => JSX.Element;
  class?: string;
}) {
  const [open, setOpen] = createSignal(false);
  const [q, setQ] = createSignal("");
  let wrap!: HTMLDivElement;
  const filtered = () => {
    const s = q().toLowerCase();
    return (s ? props.options.filter((o) => o.toLowerCase().includes(s)) : props.options).slice(0, 200);
  };
  let list: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal({ x: 0, y: 0, w: 0 });
  const onDoc = (e: MouseEvent) => !within(wrap, e.target) && !within(list, e.target) && setOpen(false);
  onMount(() => document.addEventListener("mousedown", onDoc));
  onCleanup(() => document.removeEventListener("mousedown", onDoc));
  const show = () => {
    const r = wrap.getBoundingClientRect();
    setPos({ x: r.left, y: r.bottom + 4, w: r.width });
    setQ("");
    setOpen(true);
  };
  return (
    <div class={`combo ${props.class ?? ""}`} ref={wrap}>
      <input
        class="input"
        value={open() ? q() : props.value}
        placeholder={props.value || props.placeholder}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onInput={(e) => setQ(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = filtered()[0] ?? q();
            if (v) props.onChange(v);
            setOpen(false);
            e.currentTarget.blur();
          }
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <Show when={open()}>
        {/* In a portal: toolbars and popovers clip overflowing children. */}
        <Portal>
          <div
            class="combo-list"
            ref={(el) => {
              list = el;
              markPortal(el, wrap);
              requestAnimationFrame(() => {
                const r = el.getBoundingClientRect();
                if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`;
                if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, pos().y - r.height - wrap.offsetHeight - 8)}px`;
              });
            }}
            style={{ left: `${pos().x}px`, top: `${pos().y}px`, "min-width": `${pos().w}px` }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <For each={filtered()} fallback={<div class="combo-empty">No matches</div>}>
              {(o) => (
                <button
                  type="button"
                  class="combo-item"
                  classList={{ active: o === props.value }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    props.onChange(o);
                    setOpen(false);
                  }}
                >
                  {props.renderOption ? props.renderOption(o) : o}
                </button>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </div>
  );
}

/** Render trusted SVG markup (icons from plugins). */
export function SvgIcon(props: { svg: string; size?: number } & JSX.HTMLAttributes<HTMLSpanElement>) {
  const [local, rest] = splitProps(props, ["svg", "size"]);
  return local.svg.trim().startsWith("<") ? (
    <span class="svg-icon" style={{ width: `${local.size ?? 18}px`, height: `${local.size ?? 18}px` }} innerHTML={local.svg} {...rest} />
  ) : (
    <span class="text-icon" {...rest}>{local.svg}</span>
  );
}
