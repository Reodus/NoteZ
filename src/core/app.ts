// The NoteZ core: registries every feature (built-in or plugin) plugs into.
// `createApi()` wraps these into the object handed to plugins.
import { createSignal } from "solid-js";
import type { Extension } from "@codemirror/state";

type Handler<T> = (payload: T) => void;
export type Disposer = () => void;

export interface Events {
  "vault:opened": { root: string };
  "vault:changed": void;
  /** A flashcard was graded (or a grade undone). */
  "srs:changed": void;
  "note:opened": { path: string };
  "note:changed": { path: string; content: string };
  "note:saved": { path: string };
  /** The note changed on disk and its buffer was replaced. */
  "note:reloaded": { path: string; content: string };
  "preview:rendered": { path: string; pages: number; millis: number; errors: number };
}

class EventBus {
  private handlers = new Map<keyof Events, Set<Handler<any>>>();

  on<K extends keyof Events>(event: K, fn: Handler<Events[K]>): Disposer {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.handlers.get(event)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        console.error(`handler for ${event} failed`, e);
      }
    });
  }
}

export interface Command {
  id: string;
  title: string;
  /** CodeMirror-style key, e.g. "Mod-s", "Mod-Shift-p". Mod = Ctrl. */
  key?: string;
  /** Shown in the command palette (default true). */
  palette?: boolean;
  run: () => unknown;
}

function matchKey(spec: string, e: KeyboardEvent): boolean {
  const parts = spec.split("-");
  const key = parts.pop()!.toLowerCase();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const mod = mods.has("mod") || mods.has("ctrl");
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  // Shift changes e.key for symbols; also compare the physical key.
  const code = e.code.replace(/^Key|^Digit/, "").toLowerCase();
  return (
    (k === key || code === key) &&
    (e.ctrlKey || e.metaKey) === mod &&
    e.shiftKey === mods.has("shift") &&
    e.altKey === mods.has("alt")
  );
}

class CommandRegistry {
  private map = new Map<string, Command>();
  private version = createSignal(0);
  private overrides: () => Record<string, string> = () => ({});

  /** User-defined shortcuts (command id → key, "" = none) take precedence. */
  setOverrides(get: () => Record<string, string>) {
    this.overrides = get;
  }

  /** The key a command currently runs on. */
  effectiveKey(id: string): string | undefined {
    const o = this.overrides();
    return id in o ? o[id] || undefined : this.map.get(id)?.key;
  }

  /** Commands' default (built-in) key. */
  defaultKey(id: string): string | undefined {
    return this.map.get(id)?.key;
  }

  register(cmd: Command): Disposer {
    this.map.set(cmd.id, cmd);
    this.version[1]((v) => v + 1);
    return () => {
      this.map.delete(cmd.id);
      this.version[1]((v) => v + 1);
    };
  }

  run(id: string): void {
    const cmd = this.map.get(id);
    if (!cmd) return console.warn(`unknown command: ${id}`);
    Promise.resolve(cmd.run()).catch((e) => {
      console.error(`command ${id} failed`, e);
      notify(String(e), "error");
    });
  }

  /** Whether `id` is registered (reactive). */
  has(id: string): boolean {
    this.version[0]();
    return this.map.has(id);
  }

  list(): Command[] {
    this.version[0]();
    return [...this.map.values()];
  }

  keyFor(id: string): string | undefined {
    return this.effectiveKey(id);
  }

  handleKey(e: KeyboardEvent): boolean {
    if (e.defaultPrevented) return false;
    for (const cmd of this.map.values()) {
      const key = this.effectiveKey(cmd.id);
      if (key && matchKey(key, e)) {
        e.preventDefault();
        e.stopPropagation();
        this.run(cmd.id);
        return true;
      }
    }
    return false;
  }
}

/** A reactive list registry (toolbar buttons, panels, status items...). */
function registry<T extends { id: string }>() {
  const [items, setItems] = createSignal<T[]>([]);
  return {
    items,
    add(item: T): Disposer {
      setItems((xs) => [...xs.filter((x) => x.id !== item.id), item]);
      return () => setItems((xs) => xs.filter((x) => x !== item));
    },
  };
}

export interface ToolbarButton {
  id: string;
  /** Group name; plugin buttons default to "plugins". */
  group?: string;
  title: string;
  /** Inline SVG markup or a short text label. */
  icon: string;
  run: () => void;
}

export interface StatusItem {
  id: string;
  /** Lower = further left. */
  priority?: number;
  render: () => string;
  title?: string;
  onClick?: () => void;
}

export interface Panel {
  id: string;
  title: string;
  /** Inline SVG markup. */
  icon: string;
  /** Mount into `el`; return a cleanup function. */
  mount: (el: HTMLElement) => void | (() => void);
  /** Show the title next to the icon in the tab strip. */
  label?: boolean;
}

/** A command of the "/" menu. */
export interface SlashCommand {
  /** The word typed after "/", e.g. "table" for /table. Letters, digits, "-". */
  id: string;
  title: string;
  /** One or two characters (or an emoji) shown in front of the title. */
  icon?: string;
  /** Group in the menu (default "Plugins"). */
  section?: string;
  /** More words that find the command, in any language. */
  keys?: string;
  /** Shown at the right, e.g. the Markdown it inserts. */
  hint?: string;
  /**
   * Arguments typed after the command, separated by spaces (the last one
   * takes the rest of the line). `options` lists completions for one.
   */
  args?: { name: string; options?: () => string[] | Promise<string[]> }[];
  /** Only in Markdown notes / only in Typst notes. */
  mdOnly?: boolean;
  typOnly?: boolean;
  /** Run with the arguments typed (missing ones are ""). The "/command" text is already removed. */
  run: (view: import("@codemirror/view").EditorView, args: string[]) => void;
}

export interface BlockContext {
  dark: boolean;
}

export interface BlockRenderer {
  /** Fenced code language this renderer handles, e.g. "mermaid". */
  lang: string;
  /** Typst code embedded into the PDF for this block. */
  toTypst: (code: string) => string | Promise<string>;
  /** Optional SVG/HTML for the inline editor preview. */
  preview?: (code: string, ctx: BlockContext) => string | Promise<string>;
}

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "success" | "error";
  action?: { label: string; run: () => void };
}

const [toasts, setToasts] = createSignal<Toast[]>([]);
let toastId = 0;

export function notify(message: string, kind: Toast["kind"] = "info", action?: Toast["action"], ms?: number) {
  const id = ++toastId;
  setToasts((t) => [...t, { id, message, kind, action }]);
  setTimeout(() => dismissToast(id), ms ?? (kind === "error" ? 8000 : 4500));
}

export function dismissToast(id: number) {
  setToasts((t) => t.filter((x) => x.id !== id));
}

const blockRegistry = registry<BlockRenderer & { id: string }>();
const completionRegistry = registry<{ id: string; source: import("@codemirror/autocomplete").CompletionSource }>();
const [extensions, setExtensions] = createSignal<Extension[]>([]);

export const app = {
  events: new EventBus(),
  commands: new CommandRegistry(),
  toolbar: registry<ToolbarButton>(),
  statusBar: registry<StatusItem>(),
  panels: registry<Panel>(),
  /** Extra "/" commands (plugins). */
  slash: registry<SlashCommand>(),
  /** Extra completion sources for the editor (plugins). */
  completions: completionRegistry,
  blocks: {
    items: blockRegistry.items,
    register(r: BlockRenderer): Disposer {
      return blockRegistry.add({ ...r, id: r.lang });
    },
    get(lang: string): BlockRenderer | undefined {
      return blockRegistry.items().find((b) => b.lang === lang);
    },
  },
  editorExtensions: {
    items: extensions,
    add(ext: Extension): Disposer {
      setExtensions((xs) => [...xs, ext]);
      return () => setExtensions((xs) => xs.filter((x) => x !== ext));
    },
  },
  toasts,
};

export type App = typeof app;
