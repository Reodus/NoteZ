import { createEffect, createSignal, For, JSX, onCleanup, onMount, Show, splitProps } from "solid-js";
import { Portal } from "solid-js/web";
import { X } from "lucide-solid";
import { app, dismissToast } from "../core/app";

import { t, t as tr, uiRtl } from "../core/i18n";
// ----------------------------------------------------------------- Layers

/**
 * Dialogs, popovers, menus and dropdowns stack in the order they open; Esc
 * closes only the top one. The listener runs in the bubbling phase, after
 * the focused element: a control that uses Esc itself (the shortcut
 * recorder, the editor) calls preventDefault and keeps its dialog open.
 * Popovers and menus close on Esc in any case — they never own the key.
 */
const layers: { close: () => void; modal: boolean }[] = [];

export function pushLayer(close: () => void, modal = false): () => void {
  const layer = { close, modal };
  layers.push(layer);
  return () => {
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
  };
}

/** Whether a dialog is open (global shortcuts stay off while one is). */
export const modalOpen = () => layers.some((l) => l.modal);

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !layers.length) return;
  const top = layers[layers.length - 1];
  if (top.modal && e.defaultPrevented) return;
  e.preventDefault();
  top.close();
});

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

// ------------------------------------------------------------------ Modal

let modalSeq = 0;

export function Modal(props: {
  title?: string;
  subtitle?: string;
  /** Accessible name when there is no visible title. */
  label?: string;
  width?: string;
  onClose: () => void;
  children: JSX.Element;
  footer?: JSX.Element;
  class?: string;
}) {
  const id = `nz-modal-${++modalSeq}`;
  let box!: HTMLDivElement;
  // Focus goes back where it was when the dialog closes (usually the editor).
  const before = document.activeElement as HTMLElement | null;
  onCleanup(pushLayer(() => props.onClose(), true));
  onMount(() => {
    // Inputs that focus themselves (prompts, the palette) do it first.
    setTimeout(() => {
      if (box.isConnected && !box.contains(document.activeElement)) box.focus({ preventScroll: true });
    });
  });
  onCleanup(() => {
    if (before?.isConnected && (!document.activeElement || document.activeElement === document.body || box.contains(document.activeElement))) {
      before.focus({ preventScroll: true });
    }
  });
  // Tab and Shift+Tab cycle inside the dialog.
  const trapTab = (e: KeyboardEvent) => {
    if (e.key !== "Tab" || e.defaultPrevented) return;
    const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return e.preventDefault();
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === box)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <Portal>
      <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
        <div
          ref={box}
          class={`modal ${props.class ?? ""}`}
          style={{ width: props.width ?? "520px" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby={props.title ? id : undefined}
          aria-label={props.title ? undefined : props.label}
          tabindex="-1"
          onKeyDown={trapTab}
        >
          <Show when={props.title}>
            <header class="modal-head">
              <div>
                <h2 id={id}>{props.title}</h2>
                <Show when={props.subtitle}>
                  <p>{props.subtitle}</p>
                </Show>
              </div>
              <button class="icon-btn" onClick={props.onClose} title={t("Close (Esc)")}>
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
  createEffect(() => {
    if (open()) onCleanup(pushLayer(() => setOpen(false)));
  });
  onMount(() => document.addEventListener("mousedown", onDoc));
  onCleanup(() => document.removeEventListener("mousedown", onDoc));

  return (
    <>
      <button
        ref={btn}
        class={`pop-trigger ${props.class ?? ""}`}
        classList={{ open: open() }}
        title={props.title}
        aria-haspopup="true"
        aria-expanded={open()}
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
/** Where focus was when the menu opened; it goes back there after Esc or a choice. */
let menuBefore: HTMLElement | null = null;

/** Open the context menu at a point (e.g. under a "more" button). */
export function openMenuAt(x: number, y: number, items: (MenuItem | "-")[]) {
  if (!menu()) menuBefore = document.activeElement as HTMLElement | null;
  setMenu({ x, y, items });
}

export function openMenu(e: MouseEvent, items: (MenuItem | "-")[]) {
  e.preventDefault();
  e.stopPropagation();
  openMenuAt(e.clientX, e.clientY, items);
}

/** Close the menu; `restore` puts focus back (not after a click elsewhere, which moves it itself). */
function closeMenu(restore: boolean) {
  if (!menu()) return;
  setMenu(null);
  const el = menuBefore;
  menuBefore = null;
  if (restore && el?.isConnected) el.focus({ preventScroll: true });
}

/** Arrow keys between the items of one menu level. */
function menuNav(e: KeyboardEvent, list: Element, from: Element | null): boolean {
  const items = [...list.querySelectorAll<HTMLButtonElement>(":scope > .menu-entry > .menu-item")];
  if (!items.length) return false;
  const i = from ? items.indexOf(from as HTMLButtonElement) : -1;
  const go = (n: number) => items[(n + items.length) % items.length].focus();
  switch (e.key) {
    case "ArrowDown": go(i + 1); return true;
    case "ArrowUp": go(i < 0 ? -1 : i - 1); return true;
    case "Home": go(0); return true;
    case "End": go(-1); return true;
  }
  return false;
}

export function MenuHost() {
  const onMouse = () => closeMenu(false);
  onMount(() => {
    window.addEventListener("mousedown", onMouse);
    window.addEventListener("blur", onMouse);
  });
  onCleanup(() => {
    window.removeEventListener("mousedown", onMouse);
    window.removeEventListener("blur", onMouse);
  });
  createEffect(() => {
    if (menu()) onCleanup(pushLayer(() => closeMenu(true)));
  });
  return (
    <Show when={menu()}>
      {(m) => (
        <Portal>
          <div
            class="context-menu"
            role="menu"
            tabindex="-1"
            ref={(el) => {
              // Keep inside the window, measured once laid out; take the keyboard.
              requestAnimationFrame(() => {
                const r = el.getBoundingClientRect();
                if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`;
                if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`;
                el.focus({ preventScroll: true });
              });
            }}
            style={{ left: `${m().x}px`, top: `${m().y}px` }}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              // Keys on the menu itself (nothing chosen yet): start at the top or bottom.
              if (e.target === e.currentTarget && menuNav(e, e.currentTarget, null)) e.preventDefault();
            }}
          >
            <MenuList items={m().items} close={() => closeMenu(true)} />
          </div>
        </Portal>
      )}
    </Show>
  );
}

function MenuList(props: { items: (MenuItem | "-")[]; close: () => void; onBack?: () => void }) {
  const [open, setOpen] = createSignal<number | null>(null);
  let hoverTimer = 0;
  onCleanup(() => clearTimeout(hoverTimer));
  // Into a submenu: towards the side it opens on.
  const forward = uiRtl ? "ArrowLeft" : "ArrowRight";
  const back = uiRtl ? "ArrowRight" : "ArrowLeft";
  const openSub = (i: number, entry: Element, focus: boolean) => {
    clearTimeout(hoverTimer);
    setOpen(i);
    if (focus)
      requestAnimationFrame(() => entry.querySelector<HTMLButtonElement>(":scope > .context-menu > .menu-entry > .menu-item")?.focus());
  };
  return (
    <For each={props.items}>
      {(it, i) =>
        it === "-" ? (
          <div class="menu-sep" role="separator" />
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
              role="menuitem"
              aria-haspopup={it.items ? "menu" : undefined}
              aria-expanded={it.items ? open() === i() : undefined}
              classList={{ danger: it.danger, "has-sub": !!it.items, open: open() === i() }}
              // detail 0 = Enter/Space: move into the submenu.
              onClick={(e) => (it.items ? openSub(i(), e.currentTarget.parentElement!, e.detail === 0) : (props.close(), it.run()))}
              onKeyDown={(e) => {
                const btn = e.currentTarget;
                if (menuNav(e, btn.closest(".context-menu")!, btn)) {
                  if (open() !== null) setOpen(null);
                } else if (e.key === forward && it.items) openSub(i(), btn.parentElement!, true);
                else if (e.key === back && props.onBack) props.onBack();
                else return;
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <span class="menu-icon">{it.icon}</span>
              <span class="menu-label">{it.label}</span>
              <Show when={it.hint}>
                <kbd dir="auto">{it.hint}</kbd>
              </Show>
              <Show when={it.items}>
                <span class="menu-sub-caret">›</span>
              </Show>
            </button>
            <Show when={it.items && open() === i()}>
              <div
                class="context-menu submenu"
                role="menu"
                ref={(el) =>
                  requestAnimationFrame(() => {
                    // Flip to the other side / up when the submenu would leave the window.
                    const r = el.getBoundingClientRect();
                    if (r.right > window.innerWidth - 4 || r.left < 4) el.classList.add("left");
                    if (r.bottom > window.innerHeight - 4) el.style.top = `${Math.max(-r.top + 4, window.innerHeight - 4 - r.bottom)}px`;
                  })
                }
              >
                <MenuList
                  items={it.items!}
                  close={props.close}
                  onBack={() => {
                    // Back out of the submenu onto the item that opened it.
                    const owner = document.activeElement?.closest(".submenu")?.parentElement?.querySelector<HTMLButtonElement>(":scope > .menu-item");
                    setOpen(null);
                    owner?.focus();
                  }}
                />
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
        <Modal onClose={() => close(null)} width="420px" class="prompt-modal" label={req().title}>
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
              <button type="button" class="btn" onClick={() => close(null)}>{t("Cancel")}</button>
              <button type="submit" class="btn primary">{t("OK")}</button>
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
    <div class="toasts" role="status" aria-live="polite">
      <For each={app.toasts()}>
        {(t) => (
          <div class={`toast ${t.kind}`}>
            <span class="toast-msg">{t.message}</span>
            <Show when={t.action}>
              <button class="btn small" onClick={() => (t.action!.run(), dismissToast(t.id))}>{t.action!.label}</button>
            </Show>
            <button class="icon-btn small" title={tr("Dismiss")} aria-label={tr("Dismiss")} onClick={() => dismissToast(t.id)}>
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
          <button type="button" class="btn small" onClick={() => props.onPick(null)}>{props.noneLabel ?? t("Default")}</button>
        </Show>
        <button type="button" class="btn small" onClick={() => input.click()}>{t("Custom…")}</button>
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
  // The option Enter takes: moved with the arrow keys, the first match while typing.
  const [hi, setHi] = createSignal(-1);
  let wrap!: HTMLDivElement;
  const filtered = () => {
    const s = q().toLowerCase();
    return (s ? props.options.filter((o) => o.toLowerCase().includes(s)) : props.options).slice(0, 200);
  };
  let list: HTMLDivElement | undefined;
  createEffect(() => {
    if (open()) onCleanup(pushLayer(() => setOpen(false)));
  });
  createEffect(() => {
    const i = hi();
    if (open() && i >= 0) (list?.children[i] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  });
  /** Enter: an exact match, else the highlighted option, else the typed text. */
  const choice = () => {
    const text = q().trim();
    const exact = props.options.find((o) => o.toLowerCase() === text.toLowerCase());
    return exact ?? filtered()[hi()] ?? text;
  };
  const [pos, setPos] = createSignal({ x: 0, y: 0, w: 0 });
  const onDoc = (e: MouseEvent) => !within(wrap, e.target) && !within(list, e.target) && setOpen(false);
  onMount(() => document.addEventListener("mousedown", onDoc));
  onCleanup(() => document.removeEventListener("mousedown", onDoc));
  const show = () => {
    const r = wrap.getBoundingClientRect();
    setPos({ x: r.left, y: r.bottom + 4, w: r.width });
    setQ("");
    setHi(props.options.slice(0, 200).indexOf(props.value));
    setOpen(true);
  };
  return (
    <div class={`combo ${props.class ?? ""}`} ref={wrap}>
      <input
        class="input"
        value={open() ? q() : props.value}
        placeholder={props.value || props.placeholder}
        role="combobox"
        aria-expanded={open()}
        aria-autocomplete="list"
        onFocus={show}
        onBlur={() => setOpen(false)}
        onInput={(e) => {
          // Typing after Esc reopens the list (read the text before show() resets it).
          const text = e.currentTarget.value;
          if (!open()) show();
          setQ(text);
          setHi(text.trim() ? 0 : -1);
        }}
        onKeyDown={(e) => {
          const n = filtered().length;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open()) return show();
            if (n) setHi((h) => (e.key === "ArrowDown" ? (h + 1) % n : h <= 0 ? n - 1 : h - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const v = open() ? choice() : "";
            if (v) props.onChange(v);
            setOpen(false);
            e.currentTarget.blur();
          }
        }}
      />
      <Show when={open()}>
        {/* In a portal: toolbars and popovers clip overflowing children. */}
        <Portal>
          <div
            class="combo-list"
            role="listbox"
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
            <For each={filtered()} fallback={<div class="combo-empty">{t("No matches")}</div>}>
              {(o, i) => (
                <button
                  type="button"
                  class="combo-item"
                  role="option"
                  aria-selected={o === props.value}
                  tabindex="-1"
                  classList={{ active: o === props.value, hi: hi() === i() }}
                  onMouseMove={() => setHi(i())}
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
