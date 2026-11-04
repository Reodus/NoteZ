import { createMemo, createSignal, For, JSX, onCleanup, Show } from "solid-js";
import { openDialog as pickFile } from "../core/native";
import {
  Bold, Italic, Underline, Strikethrough, Code, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  List, ListOrdered, ListChecks, Link, Image, Table, Sigma, Shapes, FileDown, ChevronDown, Highlighter,
  Baseline, Palette, FileCog, SeparatorHorizontal, Footprints, ListTree, PilcrowLeft, PilcrowRight, Type, MessageSquareQuote,
} from "lucide-solid";
import { app, notify } from "../core/app";
import { editorView, cursor, activeTheme, setDialog, state } from "../core/store";
import { attachmentDir } from "../editor/attachments";
import { alignTableColumn, onTableCellFocus, tableCellAlign } from "../editor/tables";
import { ipc, TextStyle } from "../core/ipc";
import { fontList, FONT_SIZES } from "../core/fonts";
import { exportPdf } from "../core/render";
import { readFrontmatter } from "../core/frontmatter";
import {
  toggleInline, setBlockStyle, setTitle, blockStyleAt, BlockStyle, blockAttr, setBlockAttr, applySpan, toggleList,
  insertLink, insertImage, insertTable, insertMath, insertPageBreak, insertFootnote, insertToc, isTypst, insertCallout,
} from "../editor/format";
import { CALLOUTS } from "../editor/livepreview";
import { ColorGrid, ComboBox, Popover, SvgIcon } from "./primitives";

const STYLE_NAMES: Record<BlockStyle, string> = {
  p: "Normal",
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  h4: "Heading 4",
  h5: "Heading 5",
  h6: "Heading 6",
  quote: "Quote",
};

/** Inline CSS approximating a theme style (for the styles gallery). */
export function previewCss(st: TextStyle | undefined, bodyPt = 11): JSX.CSSProperties {
  if (!st) return {};
  const pt = Number(/^([\d.]+)pt$/.exec(st.size ?? "")?.[1] ?? bodyPt);
  const css: JSX.CSSProperties = {
    "font-size": `${Math.max(12, Math.min(26, (pt / bodyPt) * 14))}px`,
  };
  if (st.color) css.color = st.color;
  if (st.font || st["font-fa"]) css["font-family"] = [st.font, st["font-fa"]].filter(Boolean).map((f) => `"${f}"`).join(",") + ",var(--font-editor)";
  if (st.weight) css["font-weight"] = ({ bold: 700, semibold: 600, medium: 500, light: 300 } as any)[st.weight] ?? st.weight;
  if (st.italic) css["font-style"] = "italic";
  return css;
}

function Btn(props: { title: string; onClick: () => void; active?: boolean; children: JSX.Element; disabled?: boolean }) {
  return (
    <button
      class="tb-btn"
      classList={{ active: props.active }}
      title={props.title}
      disabled={props.disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function TableGrid(props: { onPick: (r: number, c: number) => void }) {
  const [hover, setHover] = createSignal([0, 0]);
  return (
    <div class="table-picker">
      <div class="table-grid" onMouseLeave={() => setHover([0, 0])}>
        <For each={Array.from({ length: 8 * 8 }, (_, i) => i)}>
          {(i) => {
            const r = Math.floor(i / 8) + 1;
            const c = (i % 8) + 1;
            return (
              <button
                classList={{ on: r <= hover()[0] && c <= hover()[1] }}
                onMouseEnter={() => setHover([r, c])}
                onClick={() => props.onPick(r, c)}
              />
            );
          }}
        </For>
      </div>
      <div class="table-size">{hover()[0] ? `${hover()[0]} × ${hover()[1]}` : "Insert table"}</div>
    </div>
  );
}

export default function Toolbar() {
  const view = editorView;
  const run = (fn: (v: NonNullable<ReturnType<typeof view>>) => void) => () => {
    const v = view();
    if (v) fn(v);
  };

  // A focused table cell takes over the alignment buttons (column alignment).
  const [cellTick, setCellTick] = createSignal(0);
  onCleanup(onTableCellFocus(() => setCellTick((n) => n + 1)));
  const cellAlign = createMemo(() => (cellTick(), cursor(), tableCellAlign()));
  const align = (a: "left" | "center" | "right" | "justify" | null) => () => {
    if (cellAlign() !== null) {
      if (a !== "justify") alignTableColumn(a ?? "");
      return;
    }
    const v = view();
    if (v) setBlockAttr(v, "align", a);
  };
  const alignNow = () => {
    const c = cellAlign();
    return c !== null ? c || null : ctx().align;
  };

  // Recompute on cursor moves / edits.
  const ctx = createMemo(() => {
    cursor();
    const v = view();
    const content = state.active ? state.buffers[state.active]?.content : "";
    void content;
    if (!v) return { style: "p" as BlockStyle, align: null as string | null, dir: null as string | null };
    const pos = v.state.selection.main.head;
    return { style: blockStyleAt(v.state, pos), align: blockAttr(v.state, pos, "align"), dir: blockAttr(v.state, pos, "dir") };
  });

  const theme = activeTheme;
  const bodyPt = () => Number(/^([\d.]+)pt$/.exec(theme()?.styles.body?.size ?? "")?.[1] ?? 11);
  const docTheme = () => {
    if (!state.active) return "default";
    const text = state.buffers[state.active]?.content ?? "";
    if (isTypst()) return /^\/\/ theme:\s*(\S+)/.exec(text)?.[1] ?? "default";
    return readFrontmatter(text).theme ?? "default";
  };

  const [fontVal, setFontVal] = createSignal("");
  const [sizeVal, setSizeVal] = createSignal("");
  const [lastColor, setLastColor] = createSignal("#c0392b");
  const [lastHighlight, setLastHighlight] = createSignal("#fff3a3");

  const pluginButtons = () => app.toolbar.items();

  const insertImageFile = async () => {
    const v = view();
    if (!v) return;
    const file = await pickFile({
      title: "Insert image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp"] }],
    });
    if (typeof file !== "string") return;
    try {
      insertImage(v, await ipc.importAttachment(file, attachmentDir(state.active)));
    } catch (e) {
      notify(String(e), "error");
    }
  };

  return (
    <div class="toolbar" classList={{ disabled: !view() }}>
      {/* Paragraph styles — a Word-like styles gallery */}
      <div class="tb-group">
        <Popover
          class="tb-select style-select"
          title="Paragraph style"
          trigger={() => (
            <>
              <Type size={15} />
              <span>{STYLE_NAMES[ctx().style]}</span>
              <ChevronDown size={13} class="muted" />
            </>
          )}
        >
          {(close) => (
            <div class="style-gallery">
              <button
                class="style-option"
                title={isTypst() ? "Turn this line into #title[…]" : "Make this line the note's title (stored as `title:` in Properties)"}
                onClick={() => {
                  close();
                  run((v) => setTitle(v))();
                }}
              >
                <span class="style-sample" style={previewCss(theme()?.styles.title ?? { size: "20pt", weight: "bold" }, bodyPt())} dir="auto">
                  Title
                </span>
                <span class="style-key">Ctrl+Shift+T</span>
              </button>
              <For each={Object.keys(STYLE_NAMES) as BlockStyle[]}>
                {(s) => (
                  <button
                    class="style-option"
                    classList={{ active: ctx().style === s }}
                    onClick={() => {
                      close();
                      run((v) => setBlockStyle(v, s))();
                    }}
                  >
                    <span class="style-sample" style={previewCss(theme()?.styles[s === "p" ? "body" : s], bodyPt())} dir="auto">
                      {STYLE_NAMES[s]}
                    </span>
                    <span class="style-key">{s === "p" ? "Ctrl+0" : s === "quote" ? "" : `Ctrl+${s[1]}`}</span>
                  </button>
                )}
              </For>
              <div class="menu-sep" />
              <button class="menu-item" onClick={() => (close(), setDialog({ kind: "style", key: ctx().style === "p" ? "body" : ctx().style, scope: isTypst() ? "theme" : "note" }))}>
                <span class="menu-icon"><Palette size={15} /></span>
                <span class="menu-label">Modify “{STYLE_NAMES[ctx().style]}” style…</span>
              </button>
            </div>
          )}
        </Popover>
      </div>

      {/* Font family + size */}
      <div class="tb-group">
        <ComboBox
          class="font-combo"
          value={fontVal()}
          placeholder="Font"
          options={fontList()}
          renderOption={(f) => <span style={{ "font-family": `"${f}", var(--font-ui)` }}>{f}</span>}
          onChange={(f) => {
            setFontVal(f);
            run((v) => applySpan(v, { font: f }))();
          }}
        />
        <ComboBox
          class="size-combo"
          value={sizeVal()}
          placeholder="Size"
          options={FONT_SIZES}
          onChange={(s) => {
            const size = /^\d+(\.\d+)?$/.test(s) ? `${s}pt` : s;
            setSizeVal(size);
            run((v) => applySpan(v, { size }))();
          }}
        />
      </div>

      <div class="tb-group">
        <Btn title="Bold (Ctrl+B)" onClick={run((v) => toggleInline(v, "bold"))}><Bold size={16} /></Btn>
        <Btn title="Italic (Ctrl+I)" onClick={run((v) => toggleInline(v, "italic"))}><Italic size={16} /></Btn>
        <Btn title="Underline (Ctrl+U)" onClick={run((v) => toggleInline(v, "underline"))}><Underline size={16} /></Btn>
        <Btn title="Strikethrough (Ctrl+Shift+X)" onClick={run((v) => toggleInline(v, "strike"))}><Strikethrough size={16} /></Btn>
        <Btn title="Inline code (Ctrl+E)" onClick={run((v) => toggleInline(v, "code"))}><Code size={16} /></Btn>
        <div class="split-btn">
          <Btn title="Text color" onClick={run((v) => applySpan(v, { color: lastColor() }))}>
            <span class="color-icon"><Baseline size={16} /><i style={{ background: lastColor() }} /></span>
          </Btn>
          <Popover class="tb-btn caret" title="Choose text color" trigger={() => <ChevronDown size={12} />}>
            {(close) => (
              <ColorGrid
                value={lastColor()}
                noneLabel="Remove color"
                onPick={(c) => {
                  close();
                  if (c) setLastColor(c);
                  run((v) => applySpan(v, { color: c }))();
                }}
              />
            )}
          </Popover>
        </div>
        <div class="split-btn">
          <Btn title="Highlight" onClick={run((v) => applySpan(v, { highlight: lastHighlight() }))}>
            <span class="color-icon"><Highlighter size={16} /><i style={{ background: lastHighlight() }} /></span>
          </Btn>
          <Popover class="tb-btn caret" title="Choose highlight" trigger={() => <ChevronDown size={12} />}>
            {(close) => (
              <ColorGrid
                value={lastHighlight()}
                noneLabel="No highlight"
                onPick={(c) => {
                  close();
                  if (c) setLastHighlight(c);
                  run((v) => applySpan(v, { highlight: c }))();
                }}
              />
            )}
          </Popover>
        </div>
      </div>

      <div class="tb-group">
        <Btn title="Align start (default)" active={!alignNow() || alignNow() === "start"} onClick={align(null)}>
          {ctx().dir === "ltr" ? <AlignLeft size={16} /> : <AlignRight size={16} />}
        </Btn>
        <Btn title="Align left" active={alignNow() === "left"} onClick={align("left")}><AlignLeft size={16} /></Btn>
        <Btn title="Center" active={alignNow() === "center"} onClick={align("center")}><AlignCenter size={16} /></Btn>
        <Btn title="Align right" active={alignNow() === "right"} onClick={align("right")}><AlignRight size={16} /></Btn>
        <Btn title={cellAlign() !== null ? "Justify (not available in tables)" : "Justify"} disabled={cellAlign() !== null} active={alignNow() === "justify"} onClick={align("justify")}><AlignJustify size={16} /></Btn>
        <Show when={!isTypst()}>
          <Btn title="Right-to-left paragraph" active={ctx().dir === "rtl"} onClick={run((v) => setBlockAttr(v, "dir", ctx().dir === "rtl" ? null : "rtl"))}><PilcrowLeft size={16} /></Btn>
          <Btn title="Left-to-right paragraph" active={ctx().dir === "ltr"} onClick={run((v) => setBlockAttr(v, "dir", ctx().dir === "ltr" ? null : "ltr"))}><PilcrowRight size={16} /></Btn>
        </Show>
      </div>

      <div class="tb-group">
        <Btn title="Bulleted list" onClick={run((v) => toggleList(v, "bullet"))}><List size={16} /></Btn>
        <Btn title="Numbered list" onClick={run((v) => toggleList(v, "number"))}><ListOrdered size={16} /></Btn>
        <Btn title="Checklist" onClick={run((v) => toggleList(v, "task"))}><ListChecks size={16} /></Btn>
        <Popover class="tb-btn" title="Callout" trigger={() => (<><MessageSquareQuote size={16} /><ChevronDown size={11} class="muted" /></>)}>
          {(close) => {
            const [fold, setFold] = createSignal<"" | "+" | "-">("");
            return (
              <div class="menu callout-menu">
                <For each={Object.entries(CALLOUTS)}>
                  {([type, c]) => (
                    <button class={`menu-item callout-item co-${type}`} onClick={() => (close(), run((v) => insertCallout(v, type, fold()))())}>
                      <span class="menu-icon">{c.icon}</span>
                      <span class="menu-label">{c.label}</span>
                    </button>
                  )}
                </For>
                <Show when={!isTypst()}>
                  <div class="menu-sep" />
                  <label class="menu-item callout-fold" onMouseDown={(e) => e.stopPropagation()}>
                    <span class="menu-label">Foldable</span>
                    <select class="input" value={fold()} onChange={(e) => setFold(e.currentTarget.value as any)}>
                      <option value="">No</option>
                      <option value="+">Yes, open</option>
                      <option value="-">Yes, collapsed</option>
                    </select>
                  </label>
                </Show>
              </div>
            );
          }}
        </Popover>
      </div>

      <div class="tb-group">
        <Btn title="Link (Ctrl+K)" onClick={run(insertLink)}><Link size={16} /></Btn>
        <Btn title="Image" onClick={insertImageFile}><Image size={16} /></Btn>
        <Popover class="tb-btn" title="Table" trigger={() => <Table size={16} />}>
          {(close) => <TableGrid onPick={(r, c) => (close(), run((v) => insertTable(v, r, c))())} />}
        </Popover>
        <Popover class="tb-btn" title="Insert…" trigger={() => (<><Sigma size={16} /><ChevronDown size={11} class="muted" /></>)}>
          {(close) => (
            <div class="menu">
              <button class="menu-item" onClick={() => (close(), run((v) => insertMath(v, false))())}><span class="menu-icon"><Sigma size={15} /></span><span class="menu-label">Inline math</span></button>
              <button class="menu-item" onClick={() => (close(), run((v) => insertMath(v, true))())}><span class="menu-icon"><Sigma size={15} /></span><span class="menu-label">Display equation</span></button>
              <button class="menu-item" onClick={() => (close(), run(insertFootnote)())}><span class="menu-icon"><Footprints size={15} /></span><span class="menu-label">Footnote</span></button>
              <button class="menu-item" onClick={() => (close(), run(insertPageBreak)())}><span class="menu-icon"><SeparatorHorizontal size={15} /></span><span class="menu-label">Page break</span></button>
              <button class="menu-item" onClick={() => (close(), run(insertToc)())}><span class="menu-icon"><ListTree size={15} /></span><span class="menu-label">Table of contents</span></button>
            </div>
          )}
        </Popover>
        <Show when={app.commands.has("insert.diagram")}>
          <button class="tb-btn accent-soft" title="Insert chart or diagram" onMouseDown={(e) => e.preventDefault()} onClick={() => setDialog({ kind: "diagrams" })}>
            <Shapes size={16} />
            <span class="tb-label">Diagram</span>
          </button>
        </Show>
      </div>

      <Show when={pluginButtons().length}>
        <div class="tb-group">
          <For each={pluginButtons()}>
            {(b) => (
              <Btn title={b.title} onClick={b.run}>
                <SvgIcon svg={b.icon} size={16} />
              </Btn>
            )}
          </For>
        </div>
      </Show>

      <div class="tb-spacer" />

      <div class="tb-group right">
        <button class="tb-btn theme-pill" title="Document theme" onMouseDown={(e) => e.preventDefault()} onClick={() => setDialog({ kind: "themes" })}>
          <Palette size={15} />
          <span class="tb-label">{docTheme()}</span>
        </button>
        <Btn title="Page setup — paper, margins, header & footer" onClick={() => setDialog({ kind: "page" })}><FileCog size={16} /></Btn>
        <Show when={app.commands.has("pdf.export")}>
          <button class="btn primary export-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => exportPdf()} title="Export PDF (Ctrl+Shift+S)">
            <FileDown size={16} /> Export PDF
          </button>
        </Show>
      </div>
    </div>
  );
}
