// Plugin system. Built-in features and vault plugins
// (`<vault>/.notez/plugins/<id>/main.js`) get the same API object.
import { createSignal } from "solid-js";
import * as cmState from "@codemirror/state";
import * as cmView from "@codemirror/view";
import * as cmLanguage from "@codemirror/language";
import { app, notify, Disposer, Command, ToolbarButton, StatusItem, Panel, BlockRenderer, Events, SlashCommand } from "./app";
import type { CompletionSource } from "@codemirror/autocomplete";
import { ipc } from "./ipc";
import { prefs, setPrefs, state, editorView, openNote, root, isDark } from "./store";
import { askText } from "../ui/primitives";
import { insertText, insertBlock } from "../editor/format";
import { clearPreviewCache } from "../editor/widgets";

export const API_VERSION = "1.1.0";

export interface NoteZPlugin {
  onload(api: NoteZApi): void | Promise<void>;
  onunload?(): void;
}

/** The object every plugin receives. Everything registered through it is
 * removed automatically when the plugin is disabled. */
export function createApi(pluginId: string, track: (d: Disposer) => void) {
  const reg = <T>(fn: (x: T) => Disposer) => (x: T) => {
    const d = fn(x);
    track(d);
    return d;
  };
  const settingsKey = `notez.plugin.${pluginId}`;
  return {
    version: API_VERSION,
    pluginId,
    commands: {
      register: reg<Command>((c) => app.commands.register({ ...c, id: c.id.includes(".") ? c.id : `${pluginId}.${c.id}` })),
      run: (id: string) => app.commands.run(id),
    },
    events: {
      on: <K extends keyof Events>(event: K, fn: (p: Events[K]) => void) => {
        const d = app.events.on(event, fn);
        track(d);
        return d;
      },
    },
    toolbar: { addButton: reg<ToolbarButton>((b) => app.toolbar.add({ group: "plugins", ...b, id: `${pluginId}.${b.id}` })) },
    statusBar: { addItem: reg<StatusItem>((s) => app.statusBar.add({ ...s, id: `${pluginId}.${s.id}` })) },
    panels: { add: reg<Panel>((p) => app.panels.add({ ...p, id: `${pluginId}.${p.id}` })) },
    slash: { register: reg<SlashCommand>((c) => app.slash.add(c)) },
    blocks: {
      register: (r: BlockRenderer) => {
        const d = app.blocks.register(r);
        clearPreviewCache();
        track(d);
        return d;
      },
    },
    editor: {
      registerExtension: reg<cmState.Extension>((e) => app.editorExtensions.add(e)),
      /** Add a CodeMirror completion source (runs next to the built-in ones). */
      registerCompletion: reg<CompletionSource>((source) => app.completions.add({ id: `${pluginId}.${Math.random().toString(36).slice(2)}`, source })),
      view: () => editorView(),
      insert: (text: string) => {
        const v = editorView();
        if (v) insertText(v, text);
      },
      insertBlock: (text: string) => {
        const v = editorView();
        if (v) insertBlock(v, text);
      },
      selection: () => {
        const v = editorView();
        if (!v) return "";
        const r = v.state.selection.main;
        return v.state.sliceDoc(r.from, r.to);
      },
      /** CodeMirror modules — use these instead of bundling your own copy. */
      cm: { state: cmState, view: cmView, language: cmLanguage },
    },
    notes: {
      active: () => (state.active ? { path: state.active, content: state.buffers[state.active]?.content ?? "" } : null),
      open: (path: string) => openNote(path),
      list: () => ipc.notes(),
    },
    vault: {
      root: () => root(),
      read: (path: string) => ipc.read(path),
      write: (path: string, content: string) => ipc.write(path, content),
      search: (q: string) => ipc.search(q),
      /** Every tag with its note count. */
      tags: () => ipc.tags(),
      /** Tags, icon, cover, title and aliases of every note that has them. */
      meta: () => ipc.noteMeta(),
    },
    ui: {
      notify: (msg: string, kind: "info" | "success" | "error" = "info") => notify(msg, kind),
      prompt: (title: string, initial = "") => askText(title, initial),
      isDark: () => isDark(),
    },
    settings: {
      get: <T>(key: string, fallback: T): T => {
        try {
          const all = JSON.parse(localStorage.getItem(settingsKey) ?? "{}");
          return key in all ? all[key] : fallback;
        } catch {
          return fallback;
        }
      },
      set: (key: string, value: unknown) => {
        try {
          const all = JSON.parse(localStorage.getItem(settingsKey) ?? "{}");
          all[key] = value;
          localStorage.setItem(settingsKey, JSON.stringify(all));
        } catch {
          /* ignore */
        }
      },
    },
  };
}

export type NoteZApi = ReturnType<typeof createApi>;

interface Loaded {
  id: string;
  plugin?: NoteZPlugin;
  disposers: Disposer[];
  error?: string;
}

const [loaded, setLoaded] = createSignal<Loaded[]>([]);
export const loadedPlugins = loaded;

async function activate(id: string, plugin: NoteZPlugin) {
  const entry: Loaded = { id, plugin, disposers: [] };
  const api = createApi(id, (d) => entry.disposers.push(d));
  try {
    await plugin.onload(api);
  } catch (e) {
    entry.error = String(e);
    console.error(`plugin ${id} failed to load`, e);
    notify(`Plugin “${id}” failed: ${e}`, "error");
  }
  setLoaded((l) => [...l.filter((x) => x.id !== id), entry]);
}

function deactivate(id: string) {
  const entry = loaded().find((l) => l.id === id);
  if (!entry) return;
  try {
    entry.plugin?.onunload?.();
  } catch (e) {
    console.error(e);
  }
  entry.disposers.forEach((d) => d());
  setLoaded((l) => l.filter((x) => x.id !== id));
}

/** Load a vault plugin's main.js as an ES module. */
async function loadVaultPlugin(id: string) {
  try {
    const src = await ipc.pluginSource(id);
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const mod = await import(/* @vite-ignore */ url);
    URL.revokeObjectURL(url);
    const exported = mod.default ?? mod;
    const plugin: NoteZPlugin = typeof exported === "function" ? { onload: exported } : exported;
    if (typeof plugin?.onload !== "function") throw new Error("main.js must export default { onload(api) { … } }");
    await activate(id, plugin);
  } catch (e) {
    setLoaded((l) => [...l.filter((x) => x.id !== id), { id, disposers: [], error: String(e) }]);
    notify(`Plugin “${id}” failed: ${e}`, "error");
  }
}

export async function loadVaultPlugins() {
  for (const l of loaded()) if (!builtinPlugins.some((b) => b.id === l.id)) deactivate(l.id);
  let manifests: { id: string }[] = [];
  try {
    manifests = await ipc.plugins();
  } catch {
    return;
  }
  for (const m of manifests) if (prefs.enabledPlugins.includes(m.id)) await loadVaultPlugin(m.id);
}

export async function setPluginEnabled(id: string, on: boolean) {
  setPrefs("enabledPlugins", (list) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id)));
  if (on) await loadVaultPlugin(id);
  else deactivate(id);
}

// --------------------------------------------------------------- built-ins

export interface BuiltinPlugin extends NoteZPlugin {
  id: string;
  name: string;
  description: string;
  /** Can be switched off in Settings → Plugins. */
  optional?: boolean;
}

export const builtinPlugins: BuiltinPlugin[] = [];

export async function loadBuiltins(list: BuiltinPlugin[]) {
  builtinPlugins.push(...list);
  for (const p of list) if (!(p.optional && prefs.disabledBuiltins.includes(p.id))) await activate(p.id, p);
}

export async function setBuiltinEnabled(id: string, on: boolean) {
  const p = builtinPlugins.find((b) => b.id === id);
  if (!p?.optional) return;
  setPrefs("disabledBuiltins", (l) => (on ? l.filter((x) => x !== id) : [...new Set([...l, id])]));
  if (on) {
    if (!loaded().some((l) => l.id === id)) await activate(id, p);
  } else deactivate(id);
}
