import { createResource, createSignal, For, Show, JSX } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { Check, Copy, RotateCcw, Bold as BoldIcon, Italic as ItalicIcon, Underline as UnderlineIcon } from "lucide-solid";
import { notify } from "../core/app";
import { ipc, TextStyle, PageStyle, HeaderFooter, Theme } from "../core/ipc";
import { editorView, state, setActiveTheme, prefs, setPrefs } from "../core/store";
import { readFrontmatter, setFrontmatter } from "../core/frontmatter";
import { runPreview } from "../core/render";
import { fontList, FONT_SIZES } from "../core/fonts";
import { DIGIT_OPTIONS, SCRIPT_FONT_KEYS, languageOptions } from "../core/languages";
import { isTypst } from "../editor/format";
import { ColorGrid, ComboBox, Field, Modal, Popover, Segmented, askText } from "./primitives";
import { previewCss } from "./Toolbar";
import { STYLE_LABELS } from "./RightPanel";

import { t } from "../core/i18n";
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

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const norm = (v: unknown) => (v === undefined || v === "" ? null : v);

/**
 * Fields of `edited` that differ from `base` (for minimal frontmatter).
 * A field cleared in `edited` but set in `base` comes out as `null`, which
 * the core reads as "remove the theme's value"; nested objects (header,
 * footer) are diffed field by field.
 */
function diff<T extends object>(edited: T, base: T): Partial<T> {
  const out: Record<string, unknown> = {};
  const e = edited as Record<string, unknown>;
  const b = base as Record<string, unknown>;
  for (const k of new Set([...Object.keys(e), ...Object.keys(b)])) {
    const x = norm(e[k]);
    const y = norm(b[k]);
    if (isObj(x) && isObj(y)) {
      const d = diff(x, y);
      if (Object.keys(d).length) out[k] = d;
    } else if (JSON.stringify(x) !== JSON.stringify(y)) {
      out[k] = x;
    }
  }
  return out as Partial<T>;
}

/** The active note's effective theme (theme + its frontmatter overrides). */
async function effectiveTheme(fallback: Theme): Promise<Theme> {
  const path = state.active;
  if (!path) return fallback;
  try {
    return await ipc.noteTheme(path, state.buffers[path]?.content ?? "");
  } catch {
    return fallback;
  }
}

/** "12" → "12pt" for spacing fields; empty → null. */
const pt = (v: string) => (/^\d+(\.\d+)?$/.test(v.trim()) ? `${v.trim()}pt` : v.trim() || null);

/** "2" → "2cm": a bare number in a length field means centimetres. */
const withUnit = (v: string, unit = "cm") => (/^-?\d+(\.\d+)?$/.test(v.trim()) ? `${v.trim()}${unit}` : v.trim());

/**
 * Fonts for other scripts (`fonts:` of a style): one row per script that has
 * its own font. Scripts without one use the main font if it has the letters,
 * else the bundled Noto font. The old `font-fa` shows as the Arabic-script row.
 */
function ScriptFonts(props: {
  value: Record<string, string>;
  legacy?: string | null;
  fonts: string[];
  onChange: (fonts: Record<string, string>, clearLegacy: boolean) => void;
}) {
  const rows = () => {
    const m = { ...props.value };
    if (props.legacy && !m.arabic) m.arabic = props.legacy;
    return m;
  };
  const used = () => Object.keys(rows());
  const unused = () => SCRIPT_FONT_KEYS.filter((k) => !used().includes(k.key));
  const put = (m: Record<string, string>) => props.onChange(m, true);
  const label = (key: string) => SCRIPT_FONT_KEYS.find((k) => k.key === key)?.label ?? key;
  const sample = (key: string) => SCRIPT_FONT_KEYS.find((k) => k.key === key)?.sample ?? "";
  return (
    <div class="field wide script-fonts">
      <span class="field-label">{t("Fonts for other scripts")}</span>
      <For each={used()}>
        {(key) => (
          <div class="script-font-row">
            <span class="script-name" title={label(key)}>{label(key)}</span>
            <ComboBox value={rows()[key] ?? ""} placeholder={t("Bundled default")} options={props.fonts}
              onChange={(v) => put(v ? { ...rows(), [key]: v } : Object.fromEntries(Object.entries(rows()).filter(([k]) => k !== key)))}
              renderOption={(f) => <span style={{ "font-family": `"${f}", var(--font-ui)` }}>{f} — {sample(key)}</span>} />
            <button type="button" class="icon-btn small" title={t("Remove")} onClick={() => put(Object.fromEntries(Object.entries(rows()).filter(([k]) => k !== key)))}>×</button>
          </div>
        )}
      </For>
      <select class="input add-script" value="" onChange={(e) => {
        const key = e.currentTarget.value;
        e.currentTarget.value = "";
        if (key) put({ ...rows(), [key]: SCRIPT_FONT_KEYS.find((k) => k.key === key)?.font ?? "" });
      }}>
        <option value="">{t("+ Add a font for a script…")}</option>
        <For each={unused()}>{(k) => <option value={k.key}>{k.label} ({k.sample})</option>}</For>
      </select>
      <span class="field-hint">{t("Scripts not listed use this style's font when it has their letters, else a bundled Noto font.")}</span>
    </div>
  );
}

const WEIGHTS = ["light", "regular", "medium", "semibold", "bold", "extrabold"];
const SPACING = [
  { v: 1.0, l: t("Single (1.0)") },
  { v: 1.15, l: "1.15" },
  { v: 1.3, l: "1.3" },
  { v: 1.5, l: "1.5" },
  { v: 1.75, l: "1.75" },
  { v: 2.0, l: t("Double (2.0)") },
];
const NUMBERING = [
  { v: "none", l: t("None") },
  { v: "1.", l: "1.  2.  3." },
  { v: "1.1.", l: "1.1.  1.2." },
  { v: "1.1.1.", l: "1.1.1." },
  { v: "1", l: "1  2  3 (no period)" },
  { v: "1.1", l: "1.1  1.2 (no period)" },
  { v: "I.", l: "I.  II.  III." },
  { v: "A.", l: "A.  B.  C." },
  { v: "a)", l: "a)  b)  c)" },
  { v: "1)", l: "1)  2)  3)" },
  { v: "(1)", l: "(1)  (2)  (3)" },
  { v: "1-1", l: "1-1  1-2" },
  { v: "i.", l: "i.  ii.  iii." },
  { v: "α.", l: "α.  β.  γ." },
  { v: "一、", l: "一、 二、 三、" },
  { v: "第1章", l: "第1章  第2章" },
  { v: "i.", l: "i.  ii.  iii." },
  { v: "α.", l: "α.  β.  γ." },
];

function ScopeSwitch(props: { scope: "note" | "theme"; onChange: (s: "note" | "theme") => void; themeId: string }) {
  return (
    <Show when={!isTypst()}>
      <div class="scope-switch">
        <span>{t("Apply to")}</span>
        <Segmented
          value={props.scope}
          onChange={props.onChange}
          options={[
            { value: "note", label: t("This note only") },
            { value: "theme", label: <>{t("Theme “{name}”", { name: props.themeId })}</>, title: t("All notes using this theme") },
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
            <span>{props.value ?? t("Default")}</span>
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
    const eff = await effectiveTheme(t);
    setSt(reconcile(structuredClone(eff.styles[props.styleKey] ?? {})));
    return t;
  });
  const isHeading = /^h\d$/.test(props.styleKey);
  const boxy = props.styleKey === "quote" || props.styleKey === "code";
  const body = props.styleKey === "body";
  // Links are inline: alignment and paragraph spacing don't apply.
  const inline = props.styleKey === "link";
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
        const th: Theme = structuredClone(unwrap(theme));
        th.styles[props.styleKey] = { ...edited };
        await ipc.saveTheme(themeId, th);
        // Remove note-level overrides so the theme change is visible.
        const view = editorView();
        if (view && !isTypst()) setFrontmatter(view, ["styles", props.styleKey], null);
        notify(t("Updated theme “{themeId}”", { themeId }), "success");
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
      title={t("Modify style — {label}", { label })}
      subtitle={t("Formatting is stored with the document and used for both the editor and the PDF.")}
      width="640px"
      onClose={props.onClose}
      footer={
        <>
          <ScopeSwitch scope={scope()} onChange={setScope} themeId={themeId} />
          <div class="spacer" />
          <button class="btn" onClick={props.onClose}>{t("Cancel")}</button>
          <button class="btn primary" onClick={save}><Check size={15} /> {t("Apply")}</button>
        </>
      }
    >
      <Show when={!base.loading} fallback={<div class="pane-empty">{t("Loading…")}</div>}>
        <div class="style-preview" dir="auto">
          <span style={{ ...previewCss(st), "text-align": (st.align === "justify" ? "justify" : st.align ?? "start") as any, "text-decoration": st.underline ? "underline" : undefined }}>
            {isHeading || props.styleKey === "title" ? "Sample Heading — عنوان — 見出し" : "The quick brown fox jumps over the lazy dog. Съешь ещё этих булок. 敏捷的棕色狐狸。"}
          </span>
        </div>

        <div class="form-grid">
          <Field label={t("Font")} hint={t("Used for every script it has letters for.")}>
            <ComboBox value={st.font ?? ""} placeholder={t("Inherit")} options={fonts()} onChange={(v) => set("font", v)}
              renderOption={(f) => <span style={{ "font-family": `"${f}"` }}>{f}</span>} />
          </Field>
          <Field label={t("Size")}>
            <ComboBox value={st.size ?? ""} placeholder={t("Inherit")} options={FONT_SIZES}
              onChange={(v) => set("size", /^\d+(\.\d+)?$/.test(v) ? `${v}pt` : v)} />
          </Field>
          <Field label={t("Weight")}>
            <select class="input" value={st.weight ?? ""} onChange={(e) => set("weight", e.currentTarget.value || null)}>
              <option value="">{t("Inherit")}</option>
              <For each={WEIGHTS}>{(w) => <option value={w}>{w}</option>}</For>
            </select>
          </Field>
          <Field label={t("Emphasis")}>
            <div class="toggle-row">
              <button type="button" class="tb-btn" classList={{ active: st.weight === "bold" }} onClick={() => set("weight", st.weight === "bold" ? null : "bold")} title={t("Bold")}><BoldIcon size={15} /></button>
              <button type="button" class="tb-btn" classList={{ active: !!st.italic }} onClick={() => set("italic", st.italic ? null : true)} title={t("Italic")}><ItalicIcon size={15} /></button>
              <button type="button" class="tb-btn" classList={{ active: !!st.underline }} onClick={() => set("underline", st.underline ? null : true)} title={t("Underline")}><UnderlineIcon size={15} /></button>
              <button type="button" class="tb-btn sc" classList={{ active: !!st.smallcaps }} onClick={() => set("smallcaps", st.smallcaps ? null : true)} title={t("Small capitals")}>Aᴀ</button>
            </div>
          </Field>
          <ColorField label={t("Color")} value={st.color} onChange={(c) => set("color", c)} />
          <Field label={t("Letter spacing")} hint={t("e.g. 0.05em; empty = normal")}>
            <input class="input" value={st.tracking ?? ""} placeholder={t("Normal")} onChange={(e) => set("tracking", withUnit(e.currentTarget.value.trim(), "em") || null)} />
          </Field>
          <ScriptFonts value={st.fonts ?? {}} legacy={st["font-fa"]} fonts={fonts()} onChange={(m, clearLegacy) => {
            setSt("fonts", Object.keys(m).length ? m : (null as any));
            if (clearLegacy) setSt("font-fa", null as any);
          }} />
          <Show when={!inline}>
          <Field label={t("Alignment")} wide>
            <Segmented
              value={st.align ?? "inherit"}
              onChange={(v) => set("align", v === "inherit" ? null : v)}
              options={[
                { value: "inherit", label: t("Inherit") },
                { value: "start", label: t("Start") },
                { value: "left", label: t("Left") },
                { value: "center", label: t("Center") },
                { value: "right", label: t("Right") },
                ...(body ? [{ value: "justify", label: t("Justify") }] : []),
              ]}
            />
          </Field>
          </Show>
          <Show when={body}>
            <Field label={t("Line spacing")}>
              <select class="input" value={st["line-spacing"] ?? ""} onChange={(e) => set("line-spacing", e.currentTarget.value ? Number(e.currentTarget.value) : null)}>
                <option value="">{t("Inherit")}</option>
                <For each={SPACING}>{(s) => <option value={s.v}>{s.l}</option>}</For>
              </select>
            </Field>
            <Field label={t("First-line indent")} hint={t("e.g. 1.2em, 0.5cm")}>
              <input class="input" value={st.indent ?? ""} placeholder="none" onChange={(e) => set("indent", pt(e.currentTarget.value))} />
            </Field>
          </Show>
          <Show when={!body && !inline}>
            <Field label={props.styleKey === "caption" ? t("Gap above caption") : t("Space before")} hint={t("e.g. 12pt, 1em")}>
              <input class="input" value={st["space-before"] ?? ""} placeholder={t("Inherit")} onChange={(e) => set("space-before", pt(e.currentTarget.value))} />
            </Field>
          </Show>
          <Show when={!inline}>
          <Field label={body ? t("Paragraph spacing") : t("Space after")} hint={t("e.g. 8pt, 0.8em")}>
            <input class="input" value={st["space-after"] ?? ""} placeholder={t("Inherit")} onChange={(e) => set("space-after", pt(e.currentTarget.value))} />
          </Field>
          </Show>
          <Show when={isHeading}>
            <Field label={t("Numbering")}>
              <select class="input" value={st.numbering ?? "none"} onChange={(e) => set("numbering", e.currentTarget.value === "none" ? null : e.currentTarget.value)}>
                <For each={NUMBERING}>{(n) => <option value={n.v}>{n.l}</option>}</For>
              </select>
            </Field>
            <ColorField label={t("Underline rule")} value={st.border} onChange={(c) => set("border", c)} />
          </Show>
          <Show when={boxy}>
            <ColorField label={t("Background")} value={st.background} onChange={(c) => set("background", c)} />
            <ColorField label={t("Border / accent")} value={st.border} onChange={(c) => set("border", c)} />
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
          <input type="checkbox" checked={!!props.value.line} onChange={(e) => up("line", e.currentTarget.checked || null)} /> {t("Separator line")}
        </label>
      </div>
      <div class="hf-row">
        <input class="input" dir="auto" placeholder={t("Left")} value={props.value.left ?? ""} onChange={(e) => up("left", e.currentTarget.value)} />
        <input class="input center" dir="auto" placeholder={t("Center")} value={props.value.center ?? ""} onChange={(e) => up("center", e.currentTarget.value)} />
        <input class="input right" dir="auto" placeholder={t("Right")} value={props.value.right ?? ""} onChange={(e) => up("right", e.currentTarget.value)} />
      </div>
    </div>
  );
}

export function PageSetupDialog(props: { onClose: () => void }) {
  const [scope, setScope] = createSignal<"note" | "theme">(isTypst() ? "theme" : "note");
  const themeId = docThemeId();
  const [pg, setPg] = createStore<PageStyle>({});
  const [margins, setMargins] = createStore({ top: "", right: "", bottom: "", left: "" });
  const [lang, setLang] = createSignal("");
  const [base] = createResource(async () => {
    const t = await ipc.theme(themeId);
    const eff = await effectiveTheme(t);
    setLang(eff.lang && eff.lang !== "auto" ? eff.lang : "");
    const merged: PageStyle = eff.page ?? {};
    setPg(reconcile(structuredClone(merged)));
    const parts = (merged.margin ?? "2.5cm").split(/\s+/);
    const [a, b, c, d] = parts.length === 4 ? parts : parts.length === 2 ? [parts[0], parts[1], parts[0], parts[1]] : [parts[0], parts[0], parts[0], parts[0]];
    setMargins({ top: a, right: b, bottom: c, left: d });
    return t;
  });

  const save = async () => {
    const theme = base();
    if (!theme) return;
    const m = { top: withUnit(margins.top), right: withUnit(margins.right), bottom: withUnit(margins.bottom), left: withUnit(margins.left) };
    const margin = m.top === m.right && m.right === m.bottom && m.bottom === m.left ? m.top : `${m.top} ${m.right} ${m.bottom} ${m.left}`;
    const page: PageStyle = { ...unwrap(pg), margin };
    try {
      if (scope() === "note") {
        const view = editorView();
        if (view) {
          setFrontmatter(view, ["page"], diff(page, theme.page));
          setFrontmatter(view, ["lang"], lang() && lang() !== theme.lang ? lang() : null);
        }
      } else {
        const th: Theme = structuredClone(unwrap(theme));
        th.page = page;
        th.lang = lang() || null;
        await ipc.saveTheme(themeId, th);
        const view = editorView();
        if (view && !isTypst()) {
          setFrontmatter(view, ["page"], null);
          setFrontmatter(view, ["lang"], null);
        }
        notify(t("Updated theme “{themeId}”", { themeId }), "success");
      }
      await refreshTheme();
      props.onClose();
    } catch (e) {
      notify(String(e), "error");
    }
  };

  return (
    <Modal
      title={t("Page setup")}
      subtitle={t("Paper, margins, columns, language, numbering, header and footer.")}
      width="680px"
      onClose={props.onClose}
      footer={
        <>
          <ScopeSwitch scope={scope()} onChange={setScope} themeId={themeId} />
          <div class="spacer" />
          <button class="btn" onClick={props.onClose}>{t("Cancel")}</button>
          <button class="btn primary" onClick={save}><Check size={15} /> {t("Apply")}</button>
        </>
      }
    >
      <Show when={!base.loading} fallback={<div class="pane-empty">{t("Loading…")}</div>}>
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
            <Field label={t("Paper")}>
              <select class="input" value={pg.paper ?? "a4"} onChange={(e) => setPg("paper", e.currentTarget.value)}>
                <For each={PAPERS}>{([v, l]) => <option value={v}>{l}</option>}</For>
              </select>
            </Field>
            <Field label={t("Orientation")}>
              <Segmented value={pg.orientation ?? "portrait"} onChange={(v) => setPg("orientation", v)}
                options={[{ value: "portrait", label: t("Portrait") }, { value: "landscape", label: t("Landscape") }]} />
            </Field>
            <Field label={t("Margins (top · right · bottom · left)")} wide>
              <div class="margin-row">
                <For each={["top", "right", "bottom", "left"] as const}>
                  {(k) => <input class="input" value={margins[k]} onChange={(e) => setMargins(k, e.currentTarget.value.trim())} title={k} />}
                </For>
              </div>
            </Field>
            <Field label={t("Columns")}>
              <Segmented value={String(pg.columns ?? 1)} onChange={(v) => setPg("columns", v === "1" ? null : Number(v))}
                options={[{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }]} />
            </Field>
            <Field label={t("Document language")} hint={t("Direction, hyphenation, quotes and automatic digits follow it.")}>
              <select class="input" value={lang()} onChange={(e) => setLang(e.currentTarget.value)}>
                <For each={languageOptions()}>{(o) => <option value={o.value}>{o.label}</option>}</For>
              </select>
            </Field>
            <Field label={t("Page numbers")}>
              <select class="input" value={pg.numbering ?? "1"} onChange={(e) => setPg("numbering", e.currentTarget.value)}>
                <option value="1">1, 2, 3</option>
                <option value="1 / 1">1 / 3, 2 / 3 …</option>
                <option value="i">{t("i, ii, iii")}</option>
                <option value="I">{t("I, II, III")}</option>
                <option value="a">a, b, c</option>
                <option value="A">A, B, C</option>
                <option value="α">α, β, γ</option>
                <option value="一">一, 二, 三</option>
                <option value="あ">あ, い, う</option>
                <option value="가">가, 나, 다</option>
                <Show when={!["1", "1 / 1", "i", "I", "a", "A", "α", "一", "あ", "가"].includes(pg.numbering ?? "1")}>
                  <option value={pg.numbering!}>{pg.numbering}</option>
                </Show>
              </select>
            </Field>
            <Field label={t("Digits")} hint={t("For page numbers and numbered headings.")}>
              <select class="input" value={pg.digits ?? ""} onChange={(e) => setPg("digits", e.currentTarget.value || null)}>
                <For each={DIGIT_OPTIONS}>{(o) => <option value={o.value}>{o.label}</option>}</For>
              </select>
            </Field>
            <Field label={t("Heading digits")} hint={t("Overrides Digits for numbered headings only.")}>
              <select class="input" value={pg["heading-digits"] ?? ""} onChange={(e) => setPg("heading-digits", e.currentTarget.value || null)}>
                <option value="">{t("Same as page numbers")}</option>
                <For each={DIGIT_OPTIONS.slice(1)}>{(o) => <option value={o.value}>{o.label}</option>}</For>
              </select>
            </Field>
          </div>
        </div>
        <HFEditor label={t("Header")} value={pg.header ?? {}} onChange={(v) => setPg("header", v)} />
        <HFEditor label={t("Footer")} value={pg.footer ?? {}} onChange={(v) => setPg("footer", v)} />
        <div class="row gap">
          <label class="check">
            <input type="checkbox" checked={!!pg["skip-first"]} onChange={(e) => setPg("skip-first", e.currentTarget.checked || null)} />
            {t("Different first page (no header/footer on page 1)")}
          </label>
        </div>
        <p class="field-hint">
          {t("Placeholders:")} <code>{"{page}"}</code> <code>{"{total}"}</code> <code>{"{title}"}</code> <code>{"{author}"}</code> <code>{"{date}"}</code> <code>{"{chapter}"}</code>
        </p>
      </Show>
    </Modal>
  );
}

// ----------------------------------------------------------------- Themes

/** Rendered first pages, kept while the app runs. */
const thumbCache = new Map<string, Promise<string>>();

/** The real first page of a sample note in the theme. */
function ThemeThumb(props: { id: string; theme: Theme }) {
  // Keyed by the theme's content: an edited theme renders again.
  const [url] = createResource(
    () => `${props.id}@${JSON.stringify(props.theme)}`,
    (key) => {
      if (!thumbCache.has(key)) {
        thumbCache.set(
          key,
          ipc.themeThumbnail(props.id).then((svg) => URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }))),
        );
      }
      return thumbCache.get(key)!.catch(() => "");
    },
  );
  return (
    <div class="theme-thumb">
      <Show when={url()} fallback={<div class="theme-thumb-loading" />}>
        <img src={url()} alt="" draggable={false} />
      </Show>
    </div>
  );
}

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
    const id = await askText(t("New theme id (letters, digits, -)"), `${fromId}-custom`);
    if (!id) return;
    const th: Theme = structuredClone(unwrap(from));
    th.name = id;
    th.description = t("Based on {fromId}", { fromId });
    try {
      await ipc.saveTheme(id, th);
      refetch();
      notify(t("Created theme “{id}”", { id }), "success");
    } catch (e) {
      notify(String(e), "error");
    }
  };

  const swatch = (t: Theme): JSX.Element => {
    const colors = [t.styles.h1?.color, t.styles.h2?.color, t.styles.h3?.color, t.styles.quote?.border, t.styles.link?.color].filter(Boolean) as string[];
    return <For each={[...new Set(colors)].slice(0, 4)}>{(c) => <i style={{ background: c }} />}</For>;
  };

  return (
    <Modal title={t("Document themes")} subtitle={t("A theme bundles page setup and every paragraph style — like Word templates.")} width="760px" onClose={props.onClose}>
      <div class="theme-grid">
        <For each={themes() ?? []}>
          {({ info, theme }) => (
            <div class="theme-card" classList={{ active: info.id === current }} onClick={() => choose(info.id)}>
              <ThemeThumb id={info.id} theme={theme} />
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
                <button class="icon-btn small" title={t("Duplicate")} onClick={() => duplicate(theme, info.id)}><Copy size={14} /></button>
                <Show when={info.customized}>
                  <button
                    class="icon-btn small"
                    title={info.builtin ? t("Reset to factory settings") : t("Delete theme")}
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
        <span>{t("Default theme for new notes:")}</span>
        <select class="input" value={prefs.newNoteTheme} onChange={(e) => setPrefs("newNoteTheme", e.currentTarget.value)}>
          <For each={themes() ?? []}>{({ info }) => <option value={info.id}>{info.name}</option>}</For>
        </select>
      </div>
    </Modal>
  );
}
