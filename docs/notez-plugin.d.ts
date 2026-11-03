// NoteZ plugin API — type definitions (API version 1.0.0).
// Use with JSDoc in main.js:  /** @param {import("./notez-plugin").NoteZApi} api */

import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export type Disposer = () => void;

export interface Command {
  /** Without a dot it is prefixed with your plugin id. */
  id: string;
  title: string;
  /** e.g. "Mod-Shift-k" (Mod = Ctrl). */
  key?: string;
  palette?: boolean;
  run: () => unknown;
}

export interface ToolbarButton { id: string; title: string; /** inline SVG or short text */ icon: string; group?: string; run: () => void }
export interface StatusItem { id: string; priority?: number; title?: string; render: () => string; onClick?: () => void }
export interface Panel { id: string; title: string; icon: string; mount: (el: HTMLElement) => void | (() => void); /** Show the title next to the icon. */ label?: boolean }

export interface BlockRenderer {
  /** Fenced-code language, e.g. "progress" for ```progress blocks. */
  lang: string;
  /** Typst markup inserted into the PDF in place of the block. */
  toTypst: (code: string) => string | Promise<string>;
  /** HTML/SVG shown inside the editor. */
  preview?: (code: string, ctx: { dark: boolean }) => string | Promise<string>;
}

export interface Events {
  "vault:opened": { root: string };
  "vault:changed": void;
  "note:opened": { path: string };
  "note:changed": { path: string; content: string };
  "note:saved": { path: string };
  "preview:rendered": { path: string; pages: number; millis: number; errors: number };
}

export interface NoteZApi {
  version: string;
  pluginId: string;
  commands: { register(c: Command): Disposer; run(id: string): void };
  events: { on<K extends keyof Events>(event: K, fn: (p: Events[K]) => void): Disposer };
  toolbar: { addButton(b: ToolbarButton): Disposer };
  statusBar: { addItem(s: StatusItem): Disposer };
  panels: { add(p: Panel): Disposer };
  blocks: { register(r: BlockRenderer): Disposer };
  editor: {
    registerExtension(e: Extension): Disposer;
    view(): EditorView | null;
    insert(text: string): void;
    insertBlock(text: string): void;
    selection(): string;
    cm: { state: typeof import("@codemirror/state"); view: typeof import("@codemirror/view"); language: typeof import("@codemirror/language") };
  };
  notes: {
    active(): { path: string; content: string } | null;
    open(path: string): Promise<void>;
    list(): Promise<string[]>;
  };
  vault: {
    root(): string | null;
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    search(q: string): Promise<unknown[]>;
  };
  ui: {
    notify(msg: string, kind?: "info" | "success" | "error"): void;
    prompt(title: string, initial?: string): Promise<string | null>;
    isDark(): boolean;
  };
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void };
}

export interface NoteZPlugin {
  onload(api: NoteZApi): void | Promise<void>;
  onunload?(): void;
}
