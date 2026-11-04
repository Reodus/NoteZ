import { createEffect, createResource, createSignal, For, JSX, Show } from "solid-js";
import { Paintbrush, Type, Puzzle, Keyboard, Info, RefreshCw, FolderOpen, Files, FileDown, Search, RotateCcw, X } from "lucide-solid";
import { openDialog, openPath } from "../core/native";
import { app, notify } from "../core/app";
import { ipc } from "../core/ipc";
import { prefs, setPrefs, root, state } from "../core/store";
import { attachmentDir, pastedName } from "../editor/attachments";
import { builtinPlugins, setPluginEnabled, setBuiltinEnabled, loadedPlugins } from "../core/plugins";
import { templatesDir } from "../plugins/templates";
import { ComboBox, Field, Modal, Segmented } from "./primitives";

const ACCENTS = ["#6d5efc", "#2f6fde", "#0e9f8e", "#1f9d55", "#e8590c", "#d6336c", "#7c3aed", "#475569"];

export const fmtKey = (k?: string) =>
  k?.replace("Mod", "Ctrl").replace(/-/g, " + ").replace(/ (\w)$/, (m) => m.toUpperCase());

/** "Mod-Shift-k" from a key event, or null for a lone modifier. */
function keySpec(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(e.key)) return null;
  const code = e.code.replace(/^Key|^Digit/, "");
  const key = e.key.length === 1 ? (/^[A-Za-z0-9]$/.test(code) ? code.toLowerCase() : e.key.toLowerCase()) : e.key;
  return [e.ctrlKey || e.metaKey ? "Mod" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : "", key].filter(Boolean).join("-");
}

function Check(props: { checked: boolean; onChange: (v: boolean) => void; children: JSX.Element; hint?: string }) {
  return (
    <label class="check">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      <span>
        {props.children}
        <Show when={props.hint}><span class="field-hint block">{props.hint}</span></Show>
      </span>
    </label>
  );
}

function FolderInput(props: { value: string; placeholder: string; onChange: (v: string) => void; absolute?: boolean }) {
  const browse = async () => {
    const r = await openDialog({ title: "Choose folder", directory: true, defaultPath: root() ?? undefined });
    if (typeof r !== "string") return;
    if (props.absolute) return props.onChange(r);
    const base = root() ?? "";
    if (r === base) return props.onChange("");
    if (!r.startsWith(base + "/")) return notify("Choose a folder inside the vault.", "error");
    props.onChange(r.slice(base.length + 1));
  };
  return (
    <div class="row gap">
      <input class="input" value={props.value} placeholder={props.placeholder} onChange={(e) => props.onChange(e.currentTarget.value.trim())} />
      <button class="btn" type="button" onClick={browse}><FolderOpen size={15} /> Browse</button>
    </div>
  );
}

function HotkeyRow(props: { id: string; title: string }) {
  const [rec, setRec] = createSignal(false);
  const key = () => app.commands.effectiveKey(props.id);
  const custom = () => props.id in prefs.hotkeys;
  const conflict = () => {
    const k = key();
    return k ? app.commands.list().find((c) => c.id !== props.id && app.commands.effectiveKey(c.id) === k) : undefined;
  };
  return (
    <div class="key-row">
      <span>{props.title}</span>
      <span class="row gap-sm">
        <Show when={conflict()}>{(c) => <span class="key-conflict" title={`Also used by “${c().title}”`}>conflict</span>}</Show>
        <button
          class="key-rec"
          classList={{ recording: rec(), custom: custom() }}
          title="Click, then press the new shortcut (Backspace = none, Esc = cancel)"
          onClick={() => setRec(true)}
          onBlur={() => setRec(false)}
          onKeyDown={(e) => {
            if (!rec()) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Escape") return setRec(false);
            if (e.key === "Backspace" || e.key === "Delete") {
              setPrefs("hotkeys", props.id, "");
              return setRec(false);
            }
            const spec = keySpec(e);
            if (!spec) return;
            setPrefs("hotkeys", props.id, spec);
            setRec(false);
          }}
        >
          {rec() ? "Press keys…" : key() ? <kbd>{fmtKey(key())}</kbd> : <span class="muted">—</span>}
        </button>
        <button
          class="icon-btn small"
          title="Reset to default"
          style={{ visibility: custom() ? "visible" : "hidden" }}
          onClick={() => setPrefs("hotkeys", (h) => {
            const n = { ...h };
            delete n[props.id];
            return n;
          })}
        >
          <RotateCcw size={13} />
        </button>
      </span>
    </div>
  );
}

export default function Settings(props: { tab?: string; onClose: () => void }) {
  const [tab, setTab] = createSignal(props.tab ?? "appearance");
  const [q, setQ] = createSignal("");
  const [plugins, { refetch }] = createResource(() => ipc.plugins().catch(() => []));
  const [fonts] = createResource(() => ipc.fonts().catch(() => [] as string[]));
  const tabs = [
    { id: "appearance", label: "Appearance", icon: <Paintbrush size={16} /> },
    { id: "editor", label: "Editor", icon: <Type size={16} /> },
    { id: "files", label: "Files & links", icon: <Files size={16} /> },
    { id: "pdf", label: "PDF & preview", icon: <FileDown size={16} /> },
    { id: "plugins", label: "Plugins", icon: <Puzzle size={16} /> },
    { id: "keys", label: "Shortcuts", icon: <Keyboard size={16} /> },
    { id: "about", label: "About", icon: <Info size={16} /> },
  ];
  const shown = (id: string) => (q() ? id !== "about" : tab() === id);

  // Search: hide settings whose text does not match.
  let body!: HTMLDivElement;
  createEffect(() => {
    const s = q().trim().toLowerCase();
    queueMicrotask(() => {
      for (const sec of body.querySelectorAll<HTMLElement>(".settings-section")) {
        let any = false;
        for (const item of sec.querySelectorAll<HTMLElement>(":scope > *:not(h3)")) {
          const hit = !s || (item.textContent ?? "").toLowerCase().includes(s);
          item.style.display = hit ? "" : "none";
          any ||= hit;
        }
        sec.style.display = any ? "" : "none";
      }
    });
  });

  const Section = (p: { id: string; children: JSX.Element }) => (
    <Show when={shown(p.id)}>
      <section class="settings-section">
        <Show when={q()}><h3>{tabs.find((t) => t.id === p.id)?.label}</h3></Show>
        {p.children}
      </section>
    </Show>
  );

  return (
    <Modal title="Settings" width="840px" class="settings-modal" onClose={props.onClose}>
      <div class="settings">
        <nav class="settings-nav">
          <div class="settings-search">
            <Search size={14} />
            <input placeholder="Search settings" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
            <Show when={q()}><button class="icon-btn small" onClick={() => setQ("")}><X size={13} /></button></Show>
          </div>
          <For each={tabs}>
            {(t) => (
              <button classList={{ active: !q() && tab() === t.id }} onClick={() => (setQ(""), setTab(t.id))}>
                {t.icon} {t.label}
              </button>
            )}
          </For>
        </nav>
        <div class="settings-body" ref={body}>
          <Section id="appearance">
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
            <Field label={`Interface zoom — ${Math.round(prefs.uiZoom * 100)}%`} hint="Scales the whole window (Ctrl+= / Ctrl+- also work).">
              <input type="range" min="0.75" max="1.5" step="0.05" value={prefs.uiZoom} onInput={(e) => setPrefs("uiZoom", Number(e.currentTarget.value))} />
            </Field>
            <Check checked={prefs.showTabBar} onChange={(v) => setPrefs("showTabBar", v)}>Show the tab bar</Check>
            <Check checked={prefs.showStatusBar} onChange={(v) => setPrefs("showStatusBar", v)}>Show the status bar</Check>
            <Check checked={prefs.animations} onChange={(v) => setPrefs("animations", v)}>Animations (sliding sidebar, transitions)</Check>
          </Section>

          <Section id="editor">
            <Field label="Editing mode" hint="Live preview hides Markdown syntax except on the line you are editing (Ctrl+Shift+M).">
              <Segmented value={prefs.editorMode} onChange={(v) => setPrefs("editorMode", v as "live" | "source")}
                options={[{ value: "live", label: "Live preview" }, { value: "source", label: "Source" }]} />
            </Field>
            <Field label="Editor font" hint="Empty = Vazirmatn / Inter. A note's theme can still set its own body font.">
              <div class="row gap">
                <ComboBox value={prefs.editorFont} placeholder="Default" options={fonts() ?? []} onChange={(v) => setPrefs("editorFont", v)}
                  renderOption={(o) => <span style={{ "font-family": `"${o}"` }}>{o}</span>} />
                <Show when={prefs.editorFont}>
                  <button class="btn" onClick={() => setPrefs("editorFont", "")}>Default</button>
                </Show>
              </div>
            </Field>
            <Field label={`Font size — ${prefs.editorFontSize}px`}>
              <input type="range" min="12" max="26" value={prefs.editorFontSize} onInput={(e) => setPrefs("editorFontSize", Number(e.currentTarget.value))} />
            </Field>
            <Field label={`Line spacing — ${prefs.lineHeight.toFixed(2)}`}>
              <input type="range" min="1.2" max="2.4" step="0.05" value={prefs.lineHeight} onInput={(e) => setPrefs("lineHeight", Number(e.currentTarget.value))} />
            </Field>
            <Check checked={prefs.readableWidth} onChange={(v) => setPrefs("readableWidth", v)}>Readable line width (center the text column)</Check>
            <Field label="Tab size">
              <Segmented value={String(prefs.tabSize)} onChange={(v) => setPrefs("tabSize", Number(v))}
                options={[{ value: "2", label: "2" }, { value: "4", label: "4" }, { value: "8", label: "8" }]} />
            </Field>
            <Check checked={prefs.autoPair} onChange={(v) => setPrefs("autoPair", v)}>Auto-close brackets and quotes</Check>
            <Check checked={prefs.spellcheck} onChange={(v) => setPrefs("spellcheck", v)} hint="English and Persian; right-click a marked word for suggestions.">
              Check spelling
            </Check>
            <Check checked={prefs.vimMode} onChange={(v) => setPrefs("vimMode", v)}>Vim key bindings</Check>
            <Check checked={prefs.inlinePreviews} onChange={(v) => setPrefs("inlinePreviews", v)}>Render charts & diagrams inline in the editor</Check>
            <Check checked={prefs.lineNumbers} onChange={(v) => setPrefs("lineNumbers", v)}>Show line numbers</Check>
            <Field label={`Autosave delay — ${prefs.autosaveMs} ms`}>
              <input type="range" min="200" max="3000" step="100" value={prefs.autosaveMs} onInput={(e) => setPrefs("autosaveMs", Number(e.currentTarget.value))} />
            </Field>
          </Section>

          <Section id="files">
            <Field label="New notes go to">
              <Segmented value={prefs.newNoteLocation} onChange={(v) => setPrefs("newNoteLocation", v as any)}
                options={[{ value: "root", label: "Vault root" }, { value: "current", label: "Current note's folder" }, { value: "folder", label: "A folder" }]} />
            </Field>
            <Show when={prefs.newNoteLocation === "folder"}>
              <FolderInput value={prefs.newNoteFolder} placeholder="e.g. Inbox" onChange={(v) => setPrefs("newNoteFolder", v)} />
            </Show>
            <Field label="Default note type">
              <Segmented value={prefs.defaultNoteType} onChange={(v) => setPrefs("defaultNoteType", v as "md" | "typ")}
                options={[{ value: "md", label: "Markdown (.md)" }, { value: "typ", label: "Typst (.typ)" }]} />
            </Field>
            <Field label="Default location for new attachments" hint="Where pasted, dropped and inserted images and files are stored.">
              <select class="input" value={prefs.attachmentMode} onChange={(e) => setPrefs("attachmentMode", e.currentTarget.value as any)}>
                <option value="root">Vault folder (root)</option>
                <option value="folder">In the folder specified below</option>
                <option value="same">Same folder as current note</option>
                <option value="subfolder">In subfolder under current note's folder</option>
              </select>
            </Field>
            <Show when={prefs.attachmentMode === "folder"}>
              <Field label="Attachment folder path">
                <FolderInput value={prefs.attachmentFolder} placeholder="attachments" onChange={(v) => setPrefs("attachmentFolder", v || "attachments")} />
              </Field>
            </Show>
            <Show when={prefs.attachmentMode === "subfolder"}>
              <Field label="Subfolder name" hint="Created inside the note's folder when needed.">
                <input class="input" value={prefs.attachmentFolder} placeholder="attachments" onChange={(e) => setPrefs("attachmentFolder", e.currentTarget.value.trim().replace(/^[./]+|\/+$/g, "") || "attachments")} />
              </Field>
            </Show>
            <Field label="Name for pasted images" hint="{{date:YYYYMMDDHHmmss}} = time of pasting, {{note}} = the note's name.">
              <input class="input" value={prefs.attachmentName} placeholder="Pasted image {{date:YYYYMMDDHHmmss}}" onChange={(e) => setPrefs("attachmentName", e.currentTarget.value.trim() || "Pasted image {{date:YYYYMMDDHHmmss}}")} />
            </Field>
            <div class="field-hint attach-preview">
              → {(() => { const d = attachmentDir(state.active); return (d ? d + "/" : "") + pastedName(state.active, "png"); })()}
            </div>
            <Field label="Templates folder" hint={`Empty = find a top-level folder named like "Templates"${templatesDir() ? ` (now: ${templatesDir()})` : ""}.`}>
              <FolderInput value={prefs.templatesFolder} placeholder="auto" onChange={(v) => setPrefs("templatesFolder", v)} />
            </Field>
            <Field label="When a note or folder is renamed or moved">
              <Segmented value={prefs.updateLinks} onChange={(v) => setPrefs("updateLinks", v as any)}
                options={[{ value: "always", label: "Update links" }, { value: "ask", label: "Ask" }, { value: "never", label: "Don't update" }]} />
            </Field>
            <Check checked={prefs.deleteToTrash} onChange={(v) => setPrefs("deleteToTrash", v)}>Delete to the system trash (recoverable)</Check>
            <Check checked={prefs.confirmDelete} onChange={(v) => setPrefs("confirmDelete", v)}>Ask before deleting</Check>
            <Field label="Excluded folders" hint="One per line. Left out of search and the graph.">
              <textarea class="input" rows="3" value={prefs.excludedFolders.join("\n")}
                onChange={(e) => setPrefs("excludedFolders", e.currentTarget.value.split("\n").map((s) => s.trim()).filter(Boolean))} />
            </Field>
          </Section>

          <Section id="pdf">
            <Field label="Export PDF to">
              <Segmented value={!prefs.pdfFolder ? "root" : prefs.pdfFolder === "./" ? "note" : "folder"}
                onChange={(v) => setPrefs("pdfFolder", v === "root" ? "" : v === "note" ? "./" : prefs.pdfFolder && prefs.pdfFolder !== "./" ? prefs.pdfFolder : (root() ?? ""))}
                options={[{ value: "root", label: "Vault root" }, { value: "note", label: "Next to the note" }, { value: "folder", label: "A folder" }]} />
            </Field>
            <Show when={prefs.pdfFolder && prefs.pdfFolder !== "./"}>
              <FolderInput absolute value={prefs.pdfFolder} placeholder="/home/…/PDFs" onChange={(v) => setPrefs("pdfFolder", v)} />
            </Show>
            <Check checked={prefs.openAfterExport} onChange={(v) => setPrefs("openAfterExport", v)}>Open the PDF after exporting</Check>
            <Field label={`Preview update delay — ${prefs.previewDelayMs} ms`} hint="How long after you stop typing the PDF preview re-renders.">
              <input type="range" min="100" max="2000" step="50" value={prefs.previewDelayMs} onInput={(e) => setPrefs("previewDelayMs", Number(e.currentTarget.value))} />
            </Field>
            <Field label="Default preview zoom">
              <Segmented value={String(prefs.previewZoom)} onChange={(v) => setPrefs("previewZoom", Number(v))}
                options={[{ value: "0", label: "Fit width" }, { value: "0.75", label: "75%" }, { value: "1", label: "100%" }, { value: "1.25", label: "125%" }]} />
            </Field>
          </Section>

          <Section id="plugins">
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
                  <Show when={p.optional} fallback={<span class="pill soft">core</span>}>
                    <label class="switch">
                      <input type="checkbox" checked={!prefs.disabledBuiltins.includes(p.id)} onChange={(e) => setBuiltinEnabled(p.id, e.currentTarget.checked)} />
                      <span />
                    </label>
                  </Show>
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
                    <input type="checkbox" checked={prefs.enabledPlugins.includes(p.id)} onChange={(e) => setPluginEnabled(p.id, e.currentTarget.checked)} />
                    <span />
                  </label>
                </div>
              )}
            </For>
          </Section>

          <Section id="keys">
            <p class="field-hint">Click a shortcut and press the new keys. Backspace removes it, Esc cancels.</p>
            <div class="keys">
              <For each={app.commands.list().filter((c) => c.palette !== false || c.key).sort((a, b) => a.title.localeCompare(b.title))}>
                {(c) => <HotkeyRow id={c.id} title={c.title} />}
              </For>
              <h4 class="settings-h">Editor (fixed)</h4>
              <For each={[
                ["Bold / Italic / Underline", "Ctrl + B / I / U"],
                ["Heading 1–4 / Normal", "Ctrl + 1…4 / 0"],
                ["Title", "Ctrl + Shift + T"],
                ["Link", "Ctrl + K"],
                ["Open link under cursor", "Ctrl + Click"],
                ["Find in note", "Ctrl + F"],
                ["Leave focus mode", "Esc"],
              ]}>
                {([a, b]) => (
                  <div class="key-row"><span>{a}</span><kbd>{b}</kbd></div>
                )}
              </For>
            </div>
          </Section>

          <Show when={tab() === "about" && !q()}>
            <div class="about">
              <h3>NoteZ {__APP_VERSION__}</h3>
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
