import { createResource, createSignal, For, Show, JSX } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { Check, Copy, RotateCcw, Bold as BoldIcon, Italic as ItalicIcon, Underline as UnderlineIcon } from "lucide-solid";
import { notify } from "../core/app";
import { ipc, TextStyle, PageStyle, HeaderFooter, Theme } from "../core/ipc";
import { editorView, state, setActiveTheme, prefs, setPrefs } from "../core/store";
import { readFrontmatter, setFrontmatter } from "../core/frontmatter";
import { runPreview } from "../core/render";
import { fontList, FONT_SIZES } from "../core/fonts";
import { isTypst } from "../editor/format";
import { ColorGrid, ComboBox, Field, Modal, Popover, Segmented, askText } from "./primitives";
import { previewCss } from "./Toolbar";
import { STYLE_LABELS } from "./RightPanel";

/** Theme id of the active note. */
export function docThemeId(): string {
  const path = state.active;
  if (!path) return "default";
  const text = state.buffers[path]?.content ?? "";
  if (path.endsWith(".typ")) return /^\/\/ theme:\s*(\S+)/.exec(text)?.[1] ?? "default";
  return readFrontmatter(text).theme ?? "default";
}

/** Set the active note's theme. */
export function setDocTheme(id: string) {
  const view = editorView();
  if (!view) return;
  if (isTypst()) {
    const first = view.state.doc.line(1);
    if (/^\/\/ theme:/.test(first.text)) view.dispatch({ changes: { from: first.from, to: first.to, insert: `// theme: ${id}` } });
    else view.dispatch({ changes: { from: 0, insert: `// theme: ${id}\n` } });
  } else {
    setFrontmatter(view, ["theme"], id === "default" ? null : id);
  }
}

async function refreshTheme() {
  const path = state.active;
  if (!path) return;
  try {
    setActiveTheme(await ipc.noteTheme(path, state.buffers[path]?.content ?? ""));
  } catch {
    /* ignore */
  }
  runPreview();
}

/** Fields of `edited` that differ from `base` (for minimal frontmatter). */
function diff<T extends object>(edited: T, base: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(edited) as (keyof T)[]) {
    const a = edited[k];
    const b = base[k];
    if (a !== undefined && a !== null && a !== "" && JSON.stringify(a) !== JSON.stringify(b)) out[k] = a;
  }
  return out;
}

const WEIGHTS = ["light", "regular", "medium", "semibold", "bold", "extrabold"];
const SPACING = [
  { v: 1.0, l: "Single (1.0)" },
  { v: 1.15, l: "1.15" },
  { v: 1.3, l: "1.3" },
  { v: 1.5, l: "1.5" },
  { v: 1.75, l: "1.75" },
  { v: 2.0, l: "Double (2.0)" },
];
const NUMBERING = [
  { v: "none", l: "None" },
  { v: "1.", l: "1.  2.  3." },
  { v: "1.1.", l: "1.1.  1.2." },
  { v: "1.1.1.", l: "1.1.1." },
  { v: "۱.", l: "۱.  ۲.  ۳." },
  { v: "۱.۱.", l: "۱.۱.  ۱.۲." },
  { v: "۱.۱.۱.", l: "۱.۱.۱." },
  { v: "I.", l: "I.  II.  III." },
  { v: "A.", l: "A.  B.  C." },
  { v: "a)", l: "a)  b)  c)" },
  { v: "1)", l: "1)  2)  3)" },
  { v: "(1)", l: "(1)  (2)  (3)" },
  { v: "1-1", l: "1-1  1-2" },
  { v: "i.", l: "i.  ii.  iii." },
  { v: "α.", l: "α.  β.  γ." },
];

function ScopeSwitch(props: { scope: "note" | "theme"; onChange: (s: "note" | "theme") => void; themeId: string }) {
  return (
    <Show when={!isTypst()}>
      <div class="scope-switch">
        <span>Apply to</span>
        <Segmented
          value={props.scope}
          onChange={props.onChange}
          options={[
            { value: "note", label: "This note only" },
            { value: "theme", label: <>Theme “{props.themeId}”</>, title: "All notes using this theme" },
          ]}
        />
      </div>
    </Show>
  );
}

function ColorField(props: { label: string; value?: string | null; onChange: (c: string | null) => void }) {
  return (
    <Field label={props.label}>
      <Popover
        class="color-field"
        trigger={() => (
          <>
            <i class="color-chip" style={{ background: props.value ?? "transparent" }} classList={{ none: !props.value }} />
            <span>{props.value ?? "Default"}</span>
          </>
        )}
      >
        {(close) => <ColorGrid value={props.value} onPick={(c) => (close(), props.onChange(c))} />}
      </Popover>
    </Field>
  );
}

// ------------------------------------------------------------ Modify Style

export function StyleDialog(props: { styleKey: string; scope: "note" | "theme"; onClose: () => void }) {
  const [scope, setScope] = createSignal(props.scope);
  const themeId = docThemeId();
  const label = STYLE_LABELS.find(([k]) => k === props.styleKey)?.[1] ?? props.styleKey;
  const [st, setSt] = createStore<TextStyle>({});
  const [base] = createResource(async () => {
    const t = await ipc.theme(themeId);
    const baseStyle = t.styles[props.styleKey] ?? {};
    const text = state.active ? state.buffers[state.active]?.content ?? "" : "";
    const noteOver = (readFrontmatter(text).styles ?? {})[props.styleKey] ?? {};
    setSt(reconcile({ ...baseStyle, ...noteOver }));
    return t;
  });
  const isHeading = /^h\d$/.test(props.styleKey);
  const boxy = props.styleKey === "quote" || props.styleKey === "code";
  const body = props.styleKey === "body";
  const fonts = () => fontList();

  const save = async () => {
    const theme = base();
    if (!theme) return;
    const edited = unwrap(st);
    try {
      if (scope() === "note") {
        const view = editorView();
        if (!view) return;
        setFrontmatter(view, ["styles", props.styleKey], diff(edited, theme.styles[props.styleKey] ?? {}));
      } else {
        const t: Theme = structuredClone(unwrap(theme));
        t.styles[props.styleKey] = { ...edited };
        await ipc.saveTheme(themeId, t);
        // Remove note-level overrides so the theme change is visible.
        const view = editorView();
        if (view && !isTypst()) setFrontmatter(view, ["styles", props.styleKey], null);
        notify(`Updated theme “${themeId}”`, "success");
      }
      await refreshTheme();
      props.onClose();
    } catch (e) {
      notify(String(e), "error");
    }
  };

  const set = <K extends keyof TextStyle>(k: K, v: TextStyle[K]) => setSt(k, v === "" ? (null as any) : v);

  return (
    <Modal
      title={`Modify style — ${label}`}
      subtitle="Formatting is stored with the document and used for both the editor and the PDF."
      width="640px"
      onClose={props.onClose}
      footer={
        <>
          <ScopeSwitch scope={scope()} onChange={setScope} themeId={themeId} />
          <div class="spacer" />
          <button class="btn" onClick={props.onClose}>Cancel</button>
          <button class="btn primary" onClick={save}><Check size={15} /> Apply</button>
        </>
      }
    >
      <Show when={!base.loading} fallback={<div class="pane-empty">Loading…</div>}>
        <div class="style-preview" dir="auto">
          <span style={{ ...previewCss(st), "text-align": (st.align === "justify" ? "justify" : st.align ?? "start") as any, "text-decoration": st.underline ? "underline" : undefined }}>
            {isHeading || props.styleKey === "title" ? "عنوان نمونه — Sample Heading" : "این یک متن نمونه است. The quick brown fox jumps over the lazy dog."}
          </span>
        </div>

        <div class="form-grid">
          <Field label="Font (Latin)">
            <ComboBox value={st.font ?? ""} placeholder="Inherit" options={fonts()} onChange={(v) => set("font", v)}
              renderOption={(f) => <span style={{ "font-family": `"${f}"` }}>{f}</span>} />
          </Field>
          <Field label="Font (Persian)">
            <ComboBox value={st["font-fa"] ?? ""} placeholder="Inherit" options={fonts()} onChange={(v) => set("font-fa", v)}
              renderOption={(f) => <span style={{ "font-family": `"${f}"` }}>{f} — فارسی</span>} />
          </Field>
          <Field label="Size">
            <ComboBox value={st.size ?? ""} placeholder="Inherit" options={FONT_SIZES}
              onChange={(v) => set("size", /^\d+(\.\d+)?$/.test(v) ? `${v}pt` : v)} />
          </Field>
          <Field label="Weight">
            <select class="input" value={st.weight ?? ""} onChange={(e) => set("weight", e.currentTarget.value || null)}>
              <option value="">Inherit</option>
              <For each={WEIGHTS}>{(w) => <option value={w}>{w}</option>}</For>
            </select>
          </Field>
          <Field label="Emphasis">
            <div class="toggle-row">
              <button type="button" class="tb-btn" classList={{ active: st.weight === "bold" }} onClick={() => set("weight", st.weight === "bold" ? null : "bold")} title="Bold"><BoldIcon size={15} /></button>
              <button type="button" class="tb-btn" classList={{ active: !!st.italic }} onClick={() => set("italic", st.italic ? null : true)} title="Italic"><ItalicIcon size={15} /></button>
              <button type="button" class="tb-btn" classList={{ active: !!st.underline }} onClick={() => set("underline", st.underline ? null : true)} title="Underline"><UnderlineIcon size={15} /></button>
            </div>
          </Field>
          <ColorField label="Color" value={st.color} onChange={(c) => set("color", c)} />
          <Field label="Alignment" wide>
            <Segmented
              value={st.align ?? "inherit"}
              onChange={(v) => set("align", v === "inherit" ? null : v)}
              options={[
                { value: "inherit", label: "Inherit" },
                { value: "start", label: "Start" },
                { value: "left", label: "Left" },
                { value: "center", label: "Center" },
                { value: "right", label: "Right" },
                ...(body ? [{ value: "justify", label: "Justify" }] : []),
              ]}
            />
          </Field>
          <Show when={body}>
            <Field label="Line spacing">
              <select class="input" value={st["line-spacing"] ?? ""} onChange={(e) => set("line-spacing", e.currentTarget.value ? Number(e.currentTarget.value) : null)}>
                <option value="">Inherit</option>
                <For each={SPACING}>{(s) => <option value={s.v}>{s.l}</option>}</For>
              </select>
            </Field>
            <Field label="First-line indent" hint="e.g. 1.2em, 0.5cm">
              <input class="input" value={st.indent ?? ""} placeholder="none" onChange={(e) => set("indent", e.currentTarget.value.trim() || null)} />
            </Field>
          </Show>
          <Show when={!body}>
            <Field label="Space before" hint="e.g. 12pt, 1em">
              <input class="input" value={st["space-before"] ?? ""} placeholder="Inherit" onChange={(e) => set("space-before", e.currentTarget.value.trim() || null)} />
            </Field>
          </Show>
          <Field label={body ? "Paragraph spacing" : "Space after"} hint="e.g. 8pt, 0.8em">
            <input class="input" value={st["space-after"] ?? ""} placeholder="Inherit" onChange={(e) => set("space-after", e.currentTarget.value.trim() || null)} />
          </Field>
          <Show when={isHeading}>
            <Field label="Numbering">
              <select class="input" value={st.numbering ?? "none"} onChange={(e) => set("numbering", e.currentTarget.value === "none" ? null : e.currentTarget.value)}>
                <For each={NUMBERING}>{(n) => <option value={n.v}>{n.l}</option>}</For>
              </select>
            </Field>
            <ColorField label="Underline rule" value={st.border} onChange={(c) => set("border", c)} />
          </Show>
          <Show when={boxy}>
            <ColorField label="Background" value={st.background} onChange={(c) => set("background", c)} />
            <ColorField label="Border / accent" value={st.border} onChange={(c) => set("border", c)} />
          </Show>
        </div>
      </Show>
    </Modal>
  );
}

// ------------------------------------------------------------- Page setup

const PAPERS = [
  ["a4", "A4"], ["a5", "A5"], ["a3", "A3"], ["b5", "B5"], ["us-letter", "Letter"], ["us-legal", "Legal"],
];

function HFEditor(props: { label: string; value: HeaderFooter; onChange: (v: HeaderFooter) => void }) {
  const up = (k: keyof HeaderFooter, v: any) => props.onChange({ ...props.value, [k]: v === "" ? null : v });
  return (
    <div class="hf-editor">
      <div class="hf-head">
        <b>{props.label}</b>
        <label class="check">
          <input type="checkbox" checked={!!props.value.line} onChange={(e) => up("line", e.currentTarget.checked || null)} /> Separator line
        </label>
      </div>
      <div class="hf-row">
        <input class="input" dir="auto" placeholder="Left" value={props.value.left ?? ""} onChange={(e) => up("left", e.currentTarget.value)} />
        <input class="input center" dir="auto" placeholder="Center" value={props.value.center ?? ""} onChange={(e) => up("center", e.currentTarget.value)} />
        <input class="input right" dir="auto" placeholder="Right" value={props.value.right ?? ""} onChange={(e) => up("right", e.currentTarget.value)} />
      </div>
    </div>
  );
}

export function PageSetupDialog(props: { onClose: () => void }) {
  const [scope, setScope] = createSignal<"note" | "theme">(isTypst() ? "theme" : "note");
  const themeId = docThemeId();
  const [pg, setPg] = createStore<PageStyle>({});
  const [margins, setMargins] = createStore({ top: "", right: "", bottom: "", left: "" });
  const [base] = createResource(async () => {
    const t = await ipc.theme(themeId);
    const text = state.active ? state.buffers[state.active]?.content ?? "" : "";
    const merged: PageStyle = { ...t.page, ...(readFrontmatter(text).page ?? {}) };
    setPg(reconcile(structuredClone(merged)));
    const parts = (merged.margin ?? "2.5cm").split(/\s+/);
    const [a, b, c, d] = parts.length === 4 ? parts : parts.length === 2 ? [parts[0], parts[1], parts[0], parts[1]] : [parts[0], parts[0], parts[0], parts[0]];
    setMargins({ top: a, right: b, bottom: c, left: d });
    return t;
  });

  const save = async () => {
    const theme = base();
    if (!theme) return;
    const m = margins;
    const margin = m.top === m.right && m.right === m.bottom && m.bottom === m.left ? m.top : `${m.top} ${m.right} ${m.bottom} ${m.left}`;
    const page: PageStyle = { ...unwrap(pg), margin };
    try {
      if (scope() === "note") {
        const view = editorView();
        if (view) setFrontmatter(view, ["page"], diff(page, theme.page));
      } else {
        const t: Theme = structuredClone(unwrap(theme));
        t.page = page;
        await ipc.saveTheme(themeId, t);
        const view = editorView();
        if (view && !isTypst()) setFrontmatter(view, ["page"], null);
        notify(`Updated theme “${themeId}”`, "success");
      }
      await refreshTheme();
      props.onClose();
    } catch (e) {
      notify(String(e), "error");
    }
  };

  return (
    <Modal
      title="Page setup"
      subtitle="Paper, margins, columns, header and footer."
      width="680px"
      onClose={props.onClose}
      footer={
        <>
          <ScopeSwitch scope={scope()} onChange={setScope} themeId={themeId} />
          <div class="spacer" />
          <button class="btn" onClick={props.onClose}>Cancel</button>
          <button class="btn primary" onClick={save}><Check size={15} /> Apply</button>
        </>
      }
    >
      <Show when={!base.loading} fallback={<div class="pane-empty">Loading…</div>}>
        <div class="page-setup">
          <div class="page-mock" classList={{ landscape: pg.orientation === "landscape" }}>
            <div class="mock-hf" classList={{ line: !!pg.header?.line }}>
              <span>{pg.header?.left}</span><span>{pg.header?.center}</span><span>{pg.header?.right}</span>
            </div>
            <div class="mock-body" style={{ "column-count": pg.columns ?? 1 }}>
              <For each={Array.from({ length: 14 })}>{() => <i />}</For>
            </div>
            <div class="mock-hf foot" classList={{ line: !!pg.footer?.line }}>
              <span>{pg.footer?.left}</span><span>{pg.footer?.center}</span><span>{pg.footer?.right}</span>
            </div>
          </div>
          <div class="form-grid">
            <Field label="Paper">
              <select class="input" value={pg.paper ?? "a4"} onChange={(e) => setPg("paper", e.currentTarget.value)}>
                <For each={PAPERS}>{([v, l]) => <option value={v}>{l}</option>}</For>
              </select>
            </Field>
            <Field label="Orientation">
              <Segmented value={pg.orientation ?? "portrait"} onChange={(v) => setPg("orientation", v)}
                options={[{ value: "portrait", label: "Portrait" }, { value: "landscape", label: "Landscape" }]} />
            </Field>
            <Field label="Margins (top · right · bottom · left)" wide>
              <div class="margin-row">
                <For each={["top", "right", "bottom", "left"] as const}>
                  {(k) => <input class="input" value={margins[k]} onChange={(e) => setMargins(k, e.currentTarget.value.trim())} title={k} />}
                </For>
              </div>
            </Field>
            <Field label="Columns">
              <Segmented value={String(pg.columns ?? 1)} onChange={(v) => setPg("columns", v === "1" ? null : Number(v))}
                options={[{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }]} />
            </Field>
            <Field label="Page numbers">
              <select class="input" value={pg.numbering ?? "1"} onChange={(e) => setPg("numbering", e.currentTarget.value)}>
                <option value="1">1, 2, 3</option>
                <option value="۱">۱، ۲، ۳</option>
                <option value="i">i, ii, iii</option>
                <option value="I">I, II, III</option>
                <option value="a">a, b, c</option>
              </select>
            </Field>
            <Field label="Heading number digits" hint="Applies to numbered headings (set the numbering shape per heading style).">
              <select class="input" value={pg["heading-digits"] ?? ""} onChange={(e) => setPg("heading-digits", e.currentTarget.value || null)}>
                <option value="">As set in each heading style</option>
                <option value="auto">Automatic (Persian in Persian documents)</option>
                <option value="persian">Persian — ۱.۲.۳</option>
                <option value="latin">Western — 1.2.3</option>
                <option value="arabic">Arabic-Indic — ١.٢.٣</option>
              </select>
            </Field>
          </div>
        </div>
        <HFEditor label="Header" value={pg.header ?? {}} onChange={(v) => setPg("header", v)} />
        <HFEditor label="Footer" value={pg.footer ?? {}} onChange={(v) => setPg("footer", v)} />
        <div class="row gap">
          <label class="check">
            <input type="checkbox" checked={!!pg["skip-first"]} onChange={(e) => setPg("skip-first", e.currentTarget.checked || null)} />
            Different first page (no header/footer on page 1)
          </label>
        </div>
        <p class="field-hint">
          Placeholders: <code>{"{page}"}</code> <code>{"{total}"}</code> <code>{"{title}"}</code> <code>{"{author}"}</code> <code>{"{date}"}</code> <code>{"{chapter}"}</code>
        </p>
      </Show>
    </Modal>
  );
}

// ----------------------------------------------------------------- Themes

export function ThemesDialog(props: { onClose: () => void }) {
  const current = docThemeId();
  const [themes, { refetch }] = createResource(async () => {
    const list = await ipc.themes();
    return Promise.all(list.map(async (info) => ({ info, theme: await ipc.theme(info.id) })));
  });

  const choose = async (id: string) => {
    setDocTheme(id);
    await refreshTheme();
    props.onClose();
  };

  const duplicate = async (from: Theme, fromId: string) => {
    const id = await askText("New theme id (letters, digits, -)", `${fromId}-custom`);
    if (!id) return;
    const t: Theme = structuredClone(unwrap(from));
    t.name = id;
    t.description = `Based on ${fromId}`;
    try {
      await ipc.saveTheme(id, t);
      refetch();
      notify(`Created theme “${id}”`, "success");
    } catch (e) {
      notify(String(e), "error");
    }
  };

  const swatch = (t: Theme): JSX.Element => {
    const colors = [t.styles.h1?.color, t.styles.h2?.color, t.styles.h3?.color, t.styles.quote?.border, t.styles.link?.color].filter(Boolean) as string[];
    return <For each={[...new Set(colors)].slice(0, 4)}>{(c) => <i style={{ background: c }} />}</For>;
  };

  return (
    <Modal title="Document themes" subtitle="A theme bundles page setup and every paragraph style — like Word templates." width="760px" onClose={props.onClose}>
      <div class="theme-grid">
        <For each={themes() ?? []}>
          {({ info, theme }) => (
            <div class="theme-card" classList={{ active: info.id === current }} onClick={() => choose(info.id)}>
              <div class="theme-thumb" style={{ "font-family": `"${theme.styles.body?.font ?? "serif"}", var(--font-editor)` }}>
                <div class="tt-title" style={{ color: theme.styles.title?.color ?? theme.styles.h1?.color ?? "#222" }}>Aa · الف</div>
                <div class="tt-h" style={{ color: theme.styles.h1?.color ?? "#222" }}>{theme.styles.h1?.numbering ? theme.styles.h1.numbering.replace(/\.$/, "") + ". " : ""}Heading</div>
                <For each={[1, 2, 3]}>{() => <i class="tt-line" />}</For>
              </div>
              <div class="theme-info">
                <div class="theme-name">
                  {info.name}
                  <Show when={info.id === current}><span class="pill">current</span></Show>
                  <Show when={!info.builtin}><span class="pill soft">custom</span></Show>
                  <Show when={info.builtin && info.customized}><span class="pill soft">modified</span></Show>
                </div>
                <div class="theme-desc">{info.description}</div>
                <div class="theme-swatches">{swatch(theme)}</div>
              </div>
              <div class="theme-actions" onClick={(e) => e.stopPropagation()}>
                <button class="icon-btn small" title="Duplicate" onClick={() => duplicate(theme, info.id)}><Copy size={14} /></button>
                <Show when={info.customized}>
                  <button
                    class="icon-btn small"
                    title={info.builtin ? "Reset to factory settings" : "Delete theme"}
                    onClick={async () => {
                      await ipc.resetTheme(info.id);
                      refetch();
                      refreshTheme();
                    }}
                  >
                    <RotateCcw size={14} />
                  </button>
                </Show>
              </div>
            </div>
          )}
        </For>
      </div>
      <div class="row gap theme-default">
        <span>Default theme for new notes:</span>
        <select class="input" value={prefs.newNoteTheme} onChange={(e) => setPrefs("newNoteTheme", e.currentTarget.value)}>
          <For each={themes() ?? []}>{({ info }) => <option value={info.id}>{info.name}</option>}</For>
        </select>
      </div>
    </Modal>
  );
}
