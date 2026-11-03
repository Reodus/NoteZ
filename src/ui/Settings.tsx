import { createResource, createSignal, For, Show } from "solid-js";
import { Paintbrush, Type, Puzzle, Keyboard, Info, RefreshCw, FolderOpen } from "lucide-solid";
import { openPath } from "../core/native";
import { app, notify } from "../core/app";
import { ipc } from "../core/ipc";
import { prefs, setPrefs, root } from "../core/store";
import { builtinPlugins, setPluginEnabled, loadedPlugins } from "../core/plugins";
import { Field, Modal, Segmented } from "./primitives";

const ACCENTS = ["#6d5efc", "#2f6fde", "#0e9f8e", "#1f9d55", "#e8590c", "#d6336c", "#7c3aed", "#475569"];

export default function Settings(props: { tab?: string; onClose: () => void }) {
  const [tab, setTab] = createSignal(props.tab ?? "appearance");
  const [plugins, { refetch }] = createResource(() => ipc.plugins().catch(() => []));
  const tabs = [
    { id: "appearance", label: "Appearance", icon: <Paintbrush size={16} /> },
    { id: "editor", label: "Editor", icon: <Type size={16} /> },
    { id: "plugins", label: "Plugins", icon: <Puzzle size={16} /> },
    { id: "keys", label: "Shortcuts", icon: <Keyboard size={16} /> },
    { id: "about", label: "About", icon: <Info size={16} /> },
  ];
  const fmtKey = (k?: string) => k?.replace("Mod", "Ctrl").replace(/-/g, " + ").replace(/ (\w)$/, (m) => m.toUpperCase());

  return (
    <Modal title="Settings" width="780px" class="settings-modal" onClose={props.onClose}>
      <div class="settings">
        <nav class="settings-nav">
          <For each={tabs}>
            {(t) => (
              <button classList={{ active: tab() === t.id }} onClick={() => setTab(t.id)}>
                {t.icon} {t.label}
              </button>
            )}
          </For>
        </nav>
        <div class="settings-body">
          <Show when={tab() === "appearance"}>
            <Field label="Theme">
              <Segmented value={prefs.themeMode} onChange={(v) => setPrefs("themeMode", v)}
                options={[{ value: "light", label: "Light" }, { value: "system", label: "System" }, { value: "dark", label: "Dark" }]} />
            </Field>
            <Field label="Accent color">
              <div class="accent-row">
                <For each={ACCENTS}>
                  {(c) => (
                    <button class="accent-dot" classList={{ active: prefs.accent === c }} style={{ background: c }} onClick={() => setPrefs("accent", c)} />
                  )}
                </For>
                <input type="color" value={prefs.accent} onInput={(e) => setPrefs("accent", e.currentTarget.value)} title="Custom" />
              </div>
            </Field>
            <Field label={`Editor font size — ${prefs.editorFontSize}px`}>
              <input type="range" min="12" max="24" value={prefs.editorFontSize} onInput={(e) => setPrefs("editorFontSize", Number(e.currentTarget.value))} />
            </Field>
            <label class="check">
              <input type="checkbox" checked={prefs.readableWidth} onChange={(e) => setPrefs("readableWidth", e.currentTarget.checked)} />
              Readable line width (center the text column)
            </label>
          </Show>

          <Show when={tab() === "editor"}>
            <Field label="Editing mode" hint="Live preview hides Markdown syntax except on the line you are editing (Ctrl+Shift+M).">
              <Segmented value={prefs.editorMode} onChange={(v) => setPrefs("editorMode", v as "live" | "source")}
                options={[{ value: "live", label: "Live preview" }, { value: "source", label: "Source" }]} />
            </Field>
            <label class="check">
              <input type="checkbox" checked={prefs.inlinePreviews} onChange={(e) => setPrefs("inlinePreviews", e.currentTarget.checked)} />
              Render charts & diagrams inline in the editor
            </label>
            <label class="check">
              <input type="checkbox" checked={prefs.lineNumbers} onChange={(e) => setPrefs("lineNumbers", e.currentTarget.checked)} />
              Show line numbers
            </label>
            <Field label={`Autosave delay — ${prefs.autosaveMs} ms`}>
              <input type="range" min="200" max="3000" step="100" value={prefs.autosaveMs} onInput={(e) => setPrefs("autosaveMs", Number(e.currentTarget.value))} />
            </Field>
          </Show>

          <Show when={tab() === "plugins"}>
            <p class="field-hint">
              Built-in features are plugins too. Vault plugins live in <code>.notez/plugins/&lt;id&gt;/</code> with a <code>manifest.json</code> and <code>main.js</code>.
            </p>
            <h4 class="settings-h">Built-in</h4>
            <For each={builtinPlugins}>
              {(p) => (
                <div class="plugin-row">
                  <div>
                    <b>{p.name}</b>
                    <span>{p.description}</span>
                  </div>
                  <span class="pill soft">core</span>
                </div>
              )}
            </For>
            <h4 class="settings-h">
              In this vault
              <button class="icon-btn small" title="Rescan" onClick={() => refetch()}><RefreshCw size={14} /></button>
              <button class="icon-btn small" title="Open plugins folder" onClick={async () => {
                try {
                  await ipc.write(".notez/plugins/.keep", "");
                  await openPath(`${root()}/.notez/plugins`);
                } catch (e) {
                  notify(String(e), "error");
                }
              }}><FolderOpen size={14} /></button>
            </h4>
            <For each={plugins() ?? []} fallback={<div class="pane-empty">No plugins found in this vault.</div>}>
              {(p) => (
                <div class="plugin-row">
                  <div>
                    <b>{p.name} <small>{p.version}</small></b>
                    <span>{p.description}</span>
                    <Show when={loadedPlugins().find((l) => l.id === p.id)?.error}>
                      {(err) => <span class="plugin-error">{err()}</span>}
                    </Show>
                  </div>
                  <label class="switch">
                    <input
                      type="checkbox"
                      checked={prefs.enabledPlugins.includes(p.id)}
                      onChange={(e) => setPluginEnabled(p.id, e.currentTarget.checked)}
                    />
                    <span />
                  </label>
                </div>
              )}
            </For>
          </Show>

          <Show when={tab() === "keys"}>
            <div class="keys">
              <For each={app.commands.list().filter((c) => c.key)}>
                {(c) => (
                  <div class="key-row">
                    <span>{c.title}</span>
                    <kbd>{fmtKey(c.key)}</kbd>
                  </div>
                )}
              </For>
              <For each={[
                ["Bold / Italic / Underline", "Ctrl + B / I / U"],
                ["Heading 1–4 / Normal", "Ctrl + 1…4 / 0"],
                ["Link", "Ctrl + K"],
                ["Open link under cursor", "Ctrl + Click"],
                ["Find in note", "Ctrl + F"],
              ]}>
                {([a, b]) => (
                  <div class="key-row"><span>{a}</span><kbd>{b}</kbd></div>
                )}
              </For>
            </div>
          </Show>

          <Show when={tab() === "about"}>
            <div class="about">
              <h3>NoteZ 0.1.0</h3>
              <p>Bilingual notes with Typst-quality PDF output.</p>
              <ul>
                <li>Typesetting: Typst 0.15 (embedded)</li>
                <li>Charts & diagrams: Lilaq, CeTZ, Fletcher, Mermaid</li>
                <li>Math: MiTeX (LaTeX syntax)</li>
                <li>Fonts: Vazirmatn, New Computer Modern, Libertinus</li>
              </ul>
            </div>
          </Show>
        </div>
      </div>
    </Modal>
  );
}
