// The NoteZ core: registries every feature (built-in or plugin) plugs into.
// `createApi()` wraps these into the object handed to plugins.
import { createSignal } from "solid-js";
import type { Extension } from "@codemirror/state";

type Handler<T> = (payload: T) => void;
export type Disposer = () => void;

export interface Events {
  "vault:opened": { root: string };
  "vault:changed": void;
  "note:opened": { path: string };
  "note:changed": { path: string; content: string };
  "note:saved": { path: string };
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

  list(): Command[] {
    this.version[0]();
    return [...this.map.values()];
  }

  keyFor(id: string): string | undefined {
    return this.map.get(id)?.key;
  }

  handleKey(e: KeyboardEvent): boolean {
    if (e.defaultPrevented) return false;
    for (const cmd of this.map.values()) {
      if (cmd.key && matchKey(cmd.key, e)) {
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

export function notify(message: string, kind: Toast["kind"] = "info", action?: Toast["action"]) {
  const id = ++toastId;
  setToasts((t) => [...t, { id, message, kind, action }]);
  setTimeout(() => dismissToast(id), kind === "error" ? 8000 : 4500);
}

export function dismissToast(id: number) {
  setToasts((t) => t.filter((x) => x.id !== id));
}

const blockRegistry = registry<BlockRenderer & { id: string }>();
const [extensions, setExtensions] = createSignal<Extension[]>([]);

export const app = {
  events: new EventBus(),
  commands: new CommandRegistry(),
  toolbar: registry<ToolbarButton>(),
  statusBar: registry<StatusItem>(),
  panels: registry<Panel>(),
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
