import { createEffect, createResource, createSignal, For, JSX, Show } from "solid-js";
import { Paintbrush, Type, Puzzle, Keyboard, Info, RefreshCw, FolderOpen, Files, FileDown, Search, RotateCcw, X, Languages, CalendarDays, History, GraduationCap, Download } from "lucide-solid";
import { openDialog, openPath, spellcheckLanguages } from "../core/native";
import { languageLabel, languageOptions } from "../core/languages";
import { cssFolder } from "../core/native";
import { HistorySettings, SyncSettingsView } from "./SyncSettings";
import { UpdatePanel } from "./UpdatePanel";
import { loadUserCss, snippets, themesFor, UiTheme } from "../core/uithemes";

async function openCssFolder(kind: "themes" | "snippets", vault: string | null) {
  try {
    await openPath(await cssFolder(kind, vault));
  } catch (e) {
    notify(String(e), "error");
  }
}

/** Colors of a theme for its preview card (base light/dark use the defaults). */
function swatch(t: UiTheme) {
  const v = (name: string, fallback: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(t.css)?.[1].trim() ?? fallback;
  const dark = t.mode === "dark";
  return {
    bg: v("bg", dark ? "#121216" : "#f4f4f6"),
    surface: v("surface", dark ? "#18181d" : "#ffffff"),
    sidebar: v("sidebar", dark ? "#141419" : "#f0f0f3"),
    fg: v("fg", dark ? "#e9e9ef" : "#1b1c21"),
    muted: v("fg-muted", dark ? "#8d91a1" : "#6b6f7e"),
    border: v("border", dark ? "#26262e" : "#e4e4ea"),
    accent: t.accent ?? "#6d5efc",
  };
}

/** A row of theme cards for one mode. */
function ThemePicker(props: { mode: "light" | "dark" }) {
  const key = props.mode === "light" ? "uiThemeLight" : "uiThemeDark";
  return (
    <Field label={props.mode === "light" ? t("Light theme") : t("Dark theme")}>
      <div class="ui-theme-grid">
        <For each={themesFor(props.mode)}>
          {(t) => {
            const c = swatch(t);
            return (
              <button
                type="button"
                class="ui-theme-card"
                classList={{ active: prefs[key] === t.id }}
                title={t.description}
                onClick={() => setPrefs(key, t.id)}
              >
                <div class="ui-theme-mock" style={{ background: c.bg, "border-color": c.border }}>
                  <i class="side" style={{ background: c.sidebar }} />
                  <div class="page" style={{ background: c.surface }}>
                    <b style={{ background: c.fg }} />
                    <i style={{ background: c.muted }} />
                    <i style={{ background: c.muted, width: "60%" }} />
                    <u style={{ background: c.accent }} />
                  </div>
                </div>
                <span class="ui-theme-name">{t.name}<Show when={t.source !== "builtin"}> <span class="badge">{t.source}</span></Show></span>
              </button>
            );
          }}
        </For>
      </div>
    </Field>
  );
}
import { app, notify } from "../core/app";
import { ipc } from "../core/ipc";
import { prefs, setPrefs, root, state, notesList, setDialog } from "../core/store";
import { attachmentDir, pastedName } from "../editor/attachments";
import { builtinPlugins, setPluginEnabled, setBuiltinEnabled, loadedPlugins } from "../core/plugins";
import { templatesDir } from "../plugins/templates";
import { dailyPath } from "../plugins/daily";
import { ComboBox, Field, Modal, Segmented } from "./primitives";

import { t, UI_LANGUAGES, setUiLanguage } from "../core/i18n";
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
    const r = await openDialog({ title: t("Choose folder"), directory: true, defaultPath: root() ?? undefined });
    if (typeof r !== "string") return;
    if (props.absolute) return props.onChange(r);
    const base = root() ?? "";
    if (r === base) return props.onChange("");
    if (!r.startsWith(base + "/")) return notify(t("Choose a folder inside the vault."), "error");
    props.onChange(r.slice(base.length + 1));
  };
  return (
    <div class="row gap">
      <input class="input" value={props.value} placeholder={props.placeholder} onChange={(e) => props.onChange(e.currentTarget.value.trim())} />
      <button class="btn" type="button" onClick={browse}><FolderOpen size={15} /> {t("Browse")}</button>
    </div>
  );
}

/** Records a global shortcut in Electron accelerator syntax ("CommandOrControl+Shift+Space"). */
function ShortcutInput(props: { value: string; onChange: (v: string) => void }) {
  const show = (v: string) => v.replace("CommandOrControl", navigator.platform.startsWith("Mac") ? "Cmd" : "Ctrl").replace(/\+/g, " + ");
  return (
    <input
      class="input"
      readOnly
      value={props.value ? show(props.value) : ""}
      placeholder={t("Off — click and press keys")}
      onKeyDown={(e) => {
        e.preventDefault();
        if (e.key === "Escape" || e.key === "Backspace") return props.onChange("");
        if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
        const mods = [e.ctrlKey || e.metaKey ? "CommandOrControl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : ""].filter(Boolean);
        if (!mods.length) return;
        const key = e.code === "Space" ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
        props.onChange([...mods, key].join("+"));
      }}
    />
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
        <Show when={conflict()}>{(c) => <span class="key-conflict" title={t("Also used by “{x}”", { x: c().title })}>conflict</span>}</Show>
        <button
          class="key-rec"
          classList={{ recording: rec(), custom: custom() }}
          title={t("Click, then press the new shortcut (Backspace = none, Esc = cancel)")}
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
          {rec() ? t("Press keys…") : key() ? <kbd>{fmtKey(key())}</kbd> : <span class="muted">—</span>}
        </button>
        <button
          class="icon-btn small"
          title={t("Reset to default")}
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
  const [docThemes] = createResource(() => ipc.themes().catch(() => []));
  const [spellList] = createResource(() => spellcheckLanguages().catch(() => [] as string[]));
  const spellLangs = () => [...(spellList() ?? [])].sort((a, b) => languageLabel(a).localeCompare(languageLabel(b)));
  const tabs = [
    { id: "appearance", label: t("Appearance"), icon: <Paintbrush size={16} /> },
    { id: "editor", label: t("Editor"), icon: <Type size={16} /> },
    { id: "language", label: t("Languages"), icon: <Languages size={16} /> },
    { id: "files", label: t("Files & links"), icon: <Files size={16} /> },
    { id: "daily", label: t("Daily notes & capture"), icon: <CalendarDays size={16} /> },
    { id: "history", label: t("History & snapshots"), icon: <History size={16} /> },
    { id: "sync", label: t("Sync"), icon: <RefreshCw size={16} /> },
    { id: "flashcards", label: t("Flashcards"), icon: <GraduationCap size={16} /> },
    { id: "pdf", label: t("PDF & preview"), icon: <FileDown size={16} /> },
    { id: "plugins", label: t("Plugins"), icon: <Puzzle size={16} /> },
    { id: "keys", label: t("Shortcuts"), icon: <Keyboard size={16} /> },
    { id: "updates", label: t("Updates"), icon: <Download size={16} /> },
    { id: "about", label: t("About"), icon: <Info size={16} /> },
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
    <Modal title={t("Settings")} width="840px" class="settings-modal" onClose={props.onClose}>
      <div class="settings">
        <nav class="settings-nav">
          <div class="settings-search">
            <Search size={14} />
            <input placeholder={t("Search settings")} value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
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
            <Field label={t("Mode")}>
              <Segmented value={prefs.themeMode} onChange={(v) => setPrefs("themeMode", v)}
                options={[{ value: "light", label: t("Light") }, { value: "system", label: t("System") }, { value: "dark", label: t("Dark") }]} />
            </Field>
            <ThemePicker mode="light" />
            <ThemePicker mode="dark" />
            <Field label={t("Accent color")} hint={t("Theme = the accent the selected theme comes with.")}>
              <div class="accent-row">
                <button class="btn small" classList={{ active: !prefs.accent }} onClick={() => setPrefs("accent", "")}>{t("Theme")}</button>
                <For each={ACCENTS}>
                  {(c) => (
                    <button class="accent-dot" classList={{ active: prefs.accent === c }} style={{ background: c }} onClick={() => setPrefs("accent", c)} />
                  )}
                </For>
                <input type="color" value={prefs.accent || "#6d5efc"} onInput={(e) => setPrefs("accent", e.currentTarget.value)} title={t("Custom")} />
              </div>
            </Field>
            <Field label={t("Custom themes & CSS snippets")} hint={t("Put .css files in a themes or snippets folder (see Help → UI themes). Vault folders apply to this vault only.")}>
              <div class="row gap wrap">
                <Show when={root()}>
                  <button class="btn" onClick={() => openCssFolder("themes", root())}><FolderOpen size={14} /> {t("Vault themes")}</button>
                  <button class="btn" onClick={() => openCssFolder("snippets", root())}><FolderOpen size={14} /> {t("Vault snippets")}</button>
                </Show>
                <button class="btn" onClick={() => openCssFolder("themes", null)}><FolderOpen size={14} /> {t("Global themes")}</button>
                <button class="btn" onClick={() => openCssFolder("snippets", null)}><FolderOpen size={14} /> {t("Global snippets")}</button>
                <button class="btn" onClick={() => void loadUserCss(root())}><RefreshCw size={14} /> {t("Reload")}</button>
              </div>
            </Field>
            <Show when={snippets().length}>
              <Field label={t("CSS snippets")}>
                <div class="snippet-list">
                  <For each={snippets()}>
                    {(sn) => (
                      <Check
                        checked={prefs.enabledSnippets.includes(sn.id)}
                        onChange={(on) => setPrefs("enabledSnippets", (cur) => (on ? [...cur, sn.id] : cur.filter((x) => x !== sn.id)))}
                        hint={sn.path}
                      >
                        {sn.id} <span class="badge">{sn.source}</span>
                      </Check>
                    )}
                  </For>
                </div>
              </Field>
            </Show>
            <Field label={t("Interface zoom — {x}%", { x: Math.round(prefs.uiZoom * 100) })} hint={t("Scales the whole window (Ctrl+= / Ctrl+- also work).")}>
              <input type="range" min="0.75" max="1.5" step="0.05" value={prefs.uiZoom} onInput={(e) => setPrefs("uiZoom", Number(e.currentTarget.value))} />
            </Field>
            <Check checked={prefs.showTabBar} onChange={(v) => setPrefs("showTabBar", v)}>{t("Show the tab bar")}</Check>
            <Check checked={prefs.showStatusBar} onChange={(v) => setPrefs("showStatusBar", v)}>{t("Show the status bar")}</Check>
            <Check checked={prefs.animations} onChange={(v) => setPrefs("animations", v)}>{t("Animations (sliding sidebar, transitions)")}</Check>
          </Section>

          <Section id="editor">
            <Field label={t("Editing mode")} hint={t("Live preview hides Markdown syntax except on the line you are editing (Ctrl+Shift+M).")}>
              <Segmented value={prefs.editorMode} onChange={(v) => setPrefs("editorMode", v as "live" | "source")}
                options={[{ value: "live", label: t("Live preview") }, { value: "source", label: t("Source") }]} />
            </Field>
            <Field label={t("Editor font")} hint={t("Empty = Inter, with a bundled font for every other script. A note's theme can still set its own body font.")}>
              <div class="row gap">
                <ComboBox value={prefs.editorFont} placeholder={t("Default")} options={fonts() ?? []} onChange={(v) => setPrefs("editorFont", v)}
                  renderOption={(o) => <span style={{ "font-family": `"${o}"` }}>{o}</span>} />
                <Show when={prefs.editorFont}>
                  <button class="btn" onClick={() => setPrefs("editorFont", "")}>{t("Default")}</button>
                </Show>
              </div>
            </Field>
            <Field label={t("Font size — {editorFontSize}px", { editorFontSize: prefs.editorFontSize })}>
              <input type="range" min="12" max="26" value={prefs.editorFontSize} onInput={(e) => setPrefs("editorFontSize", Number(e.currentTarget.value))} />
            </Field>
            <Field label={t("Line spacing — {x}", { x: prefs.lineHeight.toFixed(2) })}>
              <input type="range" min="1.2" max="2.4" step="0.05" value={prefs.lineHeight} onInput={(e) => setPrefs("lineHeight", Number(e.currentTarget.value))} />
            </Field>
            <Check checked={prefs.readableWidth} onChange={(v) => setPrefs("readableWidth", v)}>{t("Readable line width (center the text column)")}</Check>
            <Field label={t("Tab size")}>
              <Segmented value={String(prefs.tabSize)} onChange={(v) => setPrefs("tabSize", Number(v))}
                options={[{ value: "2", label: "2" }, { value: "4", label: "4" }, { value: "8", label: "8" }]} />
            </Field>
            <Check checked={prefs.autoPair} onChange={(v) => setPrefs("autoPair", v)}>{t("Auto-close brackets and quotes")}</Check>
            <Check checked={prefs.spellcheck} onChange={(v) => setPrefs("spellcheck", v)} hint={t("In the languages chosen under Languages; right-click a marked word for suggestions.")}>
              {t("Check spelling")}
            </Check>
            <Check checked={prefs.vimMode} onChange={(v) => setPrefs("vimMode", v)}>{t("Vim key bindings")}</Check>
            <Check checked={prefs.inlinePreviews} onChange={(v) => setPrefs("inlinePreviews", v)}>{t("Render charts & diagrams inline in the editor")}</Check>
            <Check checked={prefs.lineNumbers} onChange={(v) => setPrefs("lineNumbers", v)}>{t("Show line numbers")}</Check>
            <Field label={t("Autosave delay — {autosaveMs} ms", { autosaveMs: prefs.autosaveMs })}>
              <input type="range" min="200" max="3000" step="100" value={prefs.autosaveMs} onInput={(e) => setPrefs("autosaveMs", Number(e.currentTarget.value))} />
            </Field>
          </Section>

          <Section id="language">
            <Field label={t("Interface language")} hint={t("The language of menus, dialogs and messages. NoteZ reloads to apply it; your notes are saved first.")}>
              <select class="input" value={prefs.uiLanguage} onChange={(e) => void setUiLanguage(e.currentTarget.value)}>
                <For each={UI_LANGUAGES}>{(o) => <option value={o.value}>{o.value === "auto" ? t(o.label) : o.label}</option>}</For>
              </select>
            </Field>
            <Field
              label={t("Language of new notes")}
              hint={t("Automatic: each note's language is detected from its text. A note's own `lang:` property always wins. The language sets the text direction, hyphenation, quotation marks, fonts and digits in the PDF.")}
            >
              <select class="input" value={prefs.defaultLanguage} onChange={(e) => setPrefs("defaultLanguage", e.currentTarget.value)}>
                <For each={languageOptions()}>{(o) => <option value={o.value}>{o.label}</option>}</For>
              </select>
            </Field>
            <Field
              label={t("Spell-checking languages")}
              hint={spellLangs().length ? t("None selected = the system language and English.") : t("On this system the spell checker follows the system's languages.")}
            >
              <Show when={spellLangs().length}>
                <div class="lang-grid">
                  <For each={spellLangs()}>
                    {(l) => (
                      <Check
                        checked={prefs.spellcheckLanguages.includes(l)}
                        onChange={(on) => setPrefs("spellcheckLanguages", (cur) => (on ? [...cur, l] : cur.filter((x) => x !== l)))}
                      >
                        {languageLabel(l)}
                      </Check>
                    )}
                  </For>
                </div>
              </Show>
            </Field>
          </Section>

          <Section id="files">
            <Field label={t("New notes go to")}>
              <Segmented value={prefs.newNoteLocation} onChange={(v) => setPrefs("newNoteLocation", v as any)}
                options={[{ value: "root", label: t("Vault root") }, { value: "current", label: t("Current note's folder") }, { value: "folder", label: t("A folder") }]} />
            </Field>
            <Show when={prefs.newNoteLocation === "folder"}>
              <FolderInput value={prefs.newNoteFolder} placeholder={t("e.g. Inbox")} onChange={(v) => setPrefs("newNoteFolder", v)} />
            </Show>
            <Field label={t("Default note type")}>
              <Segmented value={prefs.defaultNoteType} onChange={(v) => setPrefs("defaultNoteType", v as "md" | "typ")}
                options={[{ value: "md", label: t("Markdown (.md)") }, { value: "typ", label: t("Typst (.typ)") }]} />
            </Field>
            <Field label={t("Default location for new attachments")} hint={t("Where pasted, dropped and inserted images and files are stored.")}>
              <select class="input" value={prefs.attachmentMode} onChange={(e) => setPrefs("attachmentMode", e.currentTarget.value as any)}>
                <option value="root">{t("Vault folder (root)")}</option>
                <option value="folder">{t("In the folder specified below")}</option>
                <option value="same">{t("Same folder as current note")}</option>
                <option value="subfolder">{t("In subfolder under current note's folder")}</option>
              </select>
            </Field>
            <Show when={prefs.attachmentMode === "folder"}>
              <Field label={t("Attachment folder path")}>
                <FolderInput value={prefs.attachmentFolder} placeholder="attachments" onChange={(v) => setPrefs("attachmentFolder", v || "attachments")} />
              </Field>
            </Show>
            <Show when={prefs.attachmentMode === "subfolder"}>
              <Field label={t("Subfolder name")} hint={t("Created inside the note's folder when needed.")}>
                <input class="input" value={prefs.attachmentFolder} placeholder="attachments" onChange={(e) => setPrefs("attachmentFolder", e.currentTarget.value.trim().replace(/^[./]+|\/+$/g, "") || "attachments")} />
              </Field>
            </Show>
            <Field label={t("Name for pasted images")} hint={t("{{date:YYYYMMDDHHmmss}} = time of pasting, {{note}} = the note's name.")}>
              <input class="input" value={prefs.attachmentName} placeholder={t("Pasted image {{date:YYYYMMDDHHmmss}}")} onChange={(e) => setPrefs("attachmentName", e.currentTarget.value.trim() || "Pasted image {{date:YYYYMMDDHHmmss}}")} />
            </Field>
            <div class="field-hint attach-preview">
              → {(() => { const d = attachmentDir(state.active); return (d ? d + "/" : "") + pastedName(state.active, "png"); })()}
            </div>
            <Field label={t("Templates folder")} hint={templatesDir() ? t("Empty = find a top-level folder named like \"Templates\" (now: {dir}).", { dir: templatesDir() }) : t("Empty = find a top-level folder named like \"Templates\".")}>
              <FolderInput value={prefs.templatesFolder} placeholder="auto" onChange={(v) => setPrefs("templatesFolder", v)} />
            </Field>
            <Field label={t("When a note or folder is renamed or moved")}>
              <Segmented value={prefs.updateLinks} onChange={(v) => setPrefs("updateLinks", v as any)}
                options={[{ value: "always", label: t("Update links") }, { value: "ask", label: t("Ask") }, { value: "never", label: t("Don't update") }]} />
            </Field>
            <Check checked={prefs.deleteToTrash} onChange={(v) => setPrefs("deleteToTrash", v)}>{t("Delete to the system trash (recoverable)")}</Check>
            <Check checked={prefs.confirmDelete} onChange={(v) => setPrefs("confirmDelete", v)}>{t("Ask before deleting")}</Check>
            <Field label={t("Excluded folders")} hint={t("One per line. Left out of search and the graph.")}>
              <textarea class="input" rows="3" value={prefs.excludedFolders.join("\n")}
                onChange={(e) => setPrefs("excludedFolders", e.currentTarget.value.split("\n").map((s) => s.trim()).filter(Boolean))} />
            </Field>
          </Section>

          <Section id="daily">
            <Field label={t("Daily notes folder")} hint={t("Empty = the vault's top level.")}>
              <FolderInput value={prefs.dailyFolder} placeholder={t("Daily")} onChange={(v) => setPrefs("dailyFolder", v)} />
            </Field>
            <Field label={t("File name format")} hint={t("YYYY year, MM month, DD day, ddd weekday, MMMM month name, ww week; [text] is kept as is; / makes subfolders.")}>
              <input class="input" value={prefs.dailyFormat} placeholder="YYYY-MM-DD" onChange={(e) => setPrefs("dailyFormat", e.currentTarget.value.trim() || "YYYY-MM-DD")} />
            </Field>
            <div class="field-hint attach-preview">→ {dailyPath(new Date())}</div>
            <Field label={t("Template")} hint={t("A note whose text new daily notes start with ({{date}}, {{title}}, {{time}} are filled in).")}>
              <input class="input" list="settings-notes" value={prefs.dailyTemplate} placeholder="none" onChange={(e) => setPrefs("dailyTemplate", e.currentTarget.value.trim())} />
              <datalist id="settings-notes"><For each={notesList()}>{(n) => <option value={n} />}</For></datalist>
            </Field>
            <Field label={t("Weeks start on")}>
              <select class="input" value={String(prefs.weekStart)} onChange={(e) => setPrefs("weekStart", Number(e.currentTarget.value))}>
                <option value="1">{t("Monday")}</option>
                <option value="0">{t("Sunday")}</option>
                <option value="6">{t("Saturday")}</option>
              </select>
            </Field>
            <Field label={t("Quick capture shortcut")} hint={t("Works from any app, even when NoteZ is in the background: a small window takes a thought and adds it to a note. Click and press the keys; Esc clears.")}>
              <ShortcutInput value={prefs.captureShortcut} onChange={(v) => setPrefs("captureShortcut", v)} />
            </Field>
            <Field label={t("Capture to")}>
              <select class="input" value={prefs.captureTarget === "daily" ? "daily" : "note"} onChange={(e) => setPrefs("captureTarget", e.currentTarget.value === "daily" ? "daily" : "Inbox.md")}>
                <option value="daily">{t("Today's daily note")}</option>
                <option value="note">{t("A note…")}</option>
              </select>
            </Field>
            <Show when={prefs.captureTarget !== "daily"}>
              <Field label={t("Capture note")}>
                <input class="input" list="settings-notes" value={prefs.captureTarget} placeholder="Inbox.md" onChange={(e) => setPrefs("captureTarget", e.currentTarget.value.trim() || "Inbox.md")} />
              </Field>
            </Show>
            <Field label={t("Captured line")} hint={t("{{text}} = what you typed; {{date}}, {{time}}, {{date:FORMAT}} as in templates.")}>
              <input class="input" value={prefs.captureFormat} placeholder="- {{time}} {{text}}" onChange={(e) => setPrefs("captureFormat", e.currentTarget.value || "- {{time}} {{text}}")} />
            </Field>
          </Section>
          <Section id="pdf">
            <Field label={t("Theme for new notes")} hint={t("The document theme written into new notes (see Help → PDF themes).")}>
              <select class="input" value={prefs.newNoteTheme} onChange={(e) => setPrefs("newNoteTheme", e.currentTarget.value)}>
                <For each={docThemes() ?? [{ id: prefs.newNoteTheme, name: prefs.newNoteTheme }]}>{(t) => <option value={t.id}>{t.name}</option>}</For>
              </select>
            </Field>
            <Field label={t("Export to")} hint={t("Where PDF, Word, HTML and Markdown exports are saved.")}>
              <Segmented value={!prefs.pdfFolder ? "root" : prefs.pdfFolder === "./" ? "note" : "folder"}
                onChange={(v) => setPrefs("pdfFolder", v === "root" ? "" : v === "note" ? "./" : prefs.pdfFolder && prefs.pdfFolder !== "./" ? prefs.pdfFolder : (root() ?? ""))}
                options={[{ value: "root", label: t("Vault root") }, { value: "note", label: t("Next to the note") }, { value: "folder", label: t("A folder") }]} />
            </Field>
            <Show when={prefs.pdfFolder && prefs.pdfFolder !== "./"}>
              <FolderInput absolute value={prefs.pdfFolder} placeholder="/home/…/Exports" onChange={(v) => setPrefs("pdfFolder", v)} />
            </Show>
            <Check checked={prefs.openAfterExport} onChange={(v) => setPrefs("openAfterExport", v)}>{t("Open the file after exporting")}</Check>
            <Field label={t("Preview update delay — {previewDelayMs} ms", { previewDelayMs: prefs.previewDelayMs })} hint={t("How long after you stop typing the PDF preview re-renders.")}>
              <input type="range" min="100" max="2000" step="50" value={prefs.previewDelayMs} onInput={(e) => setPrefs("previewDelayMs", Number(e.currentTarget.value))} />
            </Field>
            <Field label={t("Default preview zoom")}>
              <Segmented value={String(prefs.previewZoom)} onChange={(v) => setPrefs("previewZoom", Number(v))}
                options={[{ value: "0", label: t("Fit width") }, { value: "0.75", label: "75%" }, { value: "1", label: "100%" }, { value: "1.25", label: "125%" }]} />
            </Field>
          </Section>

          <Section id="history">
            <HistorySettings />
          </Section>

          <Section id="sync">
            <SyncSettingsView />
          </Section>

          <Section id="flashcards">
            <p class="field-hint">
              {t("Cards come from notes tagged")} <code>#flashcards</code> {t("and are scheduled with FSRS. Review progress is kept in")}
              <code>.notez/srs.json</code>{t("; your notes are not changed.")}
            </p>
            <Field label={t("Desired retention — {x}%", { x: Math.round(prefs.srsRetention * 100) })}
              hint={t("How likely you should be to remember a card when it comes up. Higher means more reviews; 90% suits most people.")}>
              <input type="range" min="0.7" max="0.99" step="0.01" value={prefs.srsRetention} onInput={(e) => setPrefs("srsRetention", Number(e.currentTarget.value))} />
            </Field>
            <Field label={t("New cards per day")}>
              <input class="input narrow" type="number" min="0" value={prefs.srsNewPerDay} onChange={(e) => setPrefs("srsNewPerDay", Math.max(0, Math.round(Number(e.currentTarget.value) || 0)))} />
            </Field>
            <Field label={t("Maximum interval (days)")}>
              <input class="input narrow" type="number" min="1" value={prefs.srsMaxInterval} onChange={(e) => setPrefs("srsMaxInterval", Math.max(1, Math.round(Number(e.currentTarget.value) || 36500)))} />
            </Field>
            <Field label={t("Learning steps (minutes)")} hint={t("Short steps a new card goes through before its first interval in days, e.g. 1 10. Empty: none.")}>
              <input class="input narrow" value={prefs.srsLearningSteps} onChange={(e) => setPrefs("srsLearningSteps", e.currentTarget.value.trim())} />
            </Field>
            <Field label={t("Relearning steps (minutes)")} hint={t("Steps after you forget a card (Again), e.g. 10.")}>
              <input class="input narrow" value={prefs.srsRelearningSteps} onChange={(e) => setPrefs("srsRelearningSteps", e.currentTarget.value.trim())} />
            </Field>
            <div class="row gap">
              <button class="btn" onClick={() => setDialog({ kind: "review" })}>{t("Open flashcards…")}</button>
              <button class="btn" onClick={() => setDialog({ kind: "help", doc: "FLASHCARDS" })}>{t("How to write cards")}</button>
            </div>
          </Section>

          <Section id="plugins">
            <p class="field-hint">
              {t("Built-in features are plugins too. Vault plugins live in")} <code>.notez/plugins/&lt;id&gt;/</code> {t("with a")} <code>manifest.json</code> and <code>main.js</code>.
            </p>
            <h4 class="settings-h">{t("Built-in")}</h4>
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
              {t("In this vault")}
              <button class="icon-btn small" title={t("Rescan")} onClick={() => refetch()}><RefreshCw size={14} /></button>
              <button class="icon-btn small" title={t("Open plugins folder")} onClick={async () => {
                try {
                  await ipc.write(".notez/plugins/.keep", "");
                  await openPath(`${root()}/.notez/plugins`);
                } catch (e) {
                  notify(String(e), "error");
                }
              }}><FolderOpen size={14} /></button>
            </h4>
            <For each={plugins() ?? []} fallback={<div class="pane-empty">{t("No plugins found in this vault.")}</div>}>
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
            <p class="field-hint">{t("Click a shortcut and press the new keys. Backspace removes it, Esc cancels.")}</p>
            <div class="keys">
              <For each={app.commands.list().filter((c) => c.palette !== false || c.key).sort((a, b) => a.title.localeCompare(b.title))}>
                {(c) => <HotkeyRow id={c.id} title={c.title} />}
              </For>
              <h4 class="settings-h">{t("Editor (fixed)")}</h4>
              <For each={[
                ["Bold / Italic / Underline", "Ctrl + B / I / U"],
                ["Heading 1–4 / Normal", "Ctrl + 1…4 / 0"],
                ["Title", "Ctrl + Shift + T"],
                ["Link", "Ctrl + K"],
                ["Open link under cursor", "Ctrl + Click"],
                ["Find in note", "Ctrl + F"],
                [t("Leave focus mode"), "Esc"],
              ]}>
                {([a, b]) => (
                  <div class="key-row"><span>{a}</span><kbd>{b}</kbd></div>
                )}
              </For>
            </div>
          </Section>

          <Section id="updates">
            <Check checked={prefs.checkUpdates} onChange={(v) => setPrefs("checkUpdates", v)} hint={t("At startup and every few hours. Nothing is downloaded until you choose Update.")}>
              {t("Check for updates automatically")}
            </Check>
            <UpdatePanel />
          </Section>

          <Show when={tab() === "about" && !q()}>
            <div class="about">
              <h3>NoteZ {__APP_VERSION__}</h3>
              <p>{t("Bilingual notes with Typst-quality PDF output.")}</p>
              <ul>
                <li>{t("Typesetting: Typst 0.15 (embedded)")}</li>
                <li>{t("Charts & diagrams: Lilaq, CeTZ, Fletcher, Mermaid")}</li>
                <li>{t("Math: MiTeX (LaTeX syntax)")}</li>
                <li>{t("Fonts: Noto (every major script), Vazirmatn, New Computer Modern, Libertinus")}</li>
              </ul>
            </div>
          </Show>
        </div>
      </div>
    </Modal>
  );
}
