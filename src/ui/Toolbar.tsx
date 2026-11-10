import { createMemo, createSignal, For, JSX, onCleanup, onMount, Show } from "solid-js";
import { openDialog as pickFile } from "../core/native";
import {
  Bold, Italic, Underline, Strikethrough, Code, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  List, ListOrdered, ListChecks, Link, Image, Table, Sigma, Shapes, ChevronDown, ChevronsRight, Highlighter,
  Baseline, Palette, SeparatorHorizontal, Footprints, ListTree, PilcrowLeft, PilcrowRight, Type, MessageSquareQuote,
} from "lucide-solid";
import { app, notify } from "../core/app";
import { editorView, cursor, activeTheme, setDialog, state, prefs } from "../core/store";
import { attachmentDir } from "../editor/attachments";
import { alignTableColumn, onTableCellFocus, tableCellAlign } from "../editor/tables";
import { ipc, TextStyle } from "../core/ipc";
import { fontList, FONT_SIZES } from "../core/fonts";
import {
  toggleInline, inlineActive, InlineKind, setBlockStyle, setTitle, blockStyleAt, BlockStyle, blockAttr, setBlockAttr, applySpan, toggleList,
  insertLink, insertImage, insertTable, insertMath, insertPageBreak, insertFootnote, insertToc, isTypst, insertCallout,
  spanAttrsAt, listKindAt,
} from "../editor/format";
import { Direction } from "@codemirror/view";
import { platformKeys } from "../core/keys";
import { CALLOUTS } from "../editor/livepreview";
import { ColorGrid, ComboBox, Popover, SvgIcon } from "./primitives";
import { NoteMenuButton } from "./NoteMenu";

import { t } from "../core/i18n";
const STYLE_NAMES: Record<BlockStyle, string> = {
  p: t("Normal"),
  h1: t("Heading 1"),
  h2: t("Heading 2"),
  h3: t("Heading 3"),
  h4: t("Heading 4"),
  h5: t("Heading 5"),
  h6: t("Heading 6"),
  quote: t("Quote"),
};

/** Inline CSS approximating a theme style (for the styles gallery). */
export function previewCss(st: TextStyle | undefined, bodyPt = 11): JSX.CSSProperties {
  if (!st) return {};
  const pt = Number(/^([\d.]+)pt$/.exec(st.size ?? "")?.[1] ?? bodyPt);
  const css: JSX.CSSProperties = {
    "font-size": `${Math.max(12, Math.min(26, (pt / bodyPt) * 14))}px`,
  };
  if (st.color) css.color = st.color;
  const families = [st.font, ...Object.values(st.fonts ?? {}), st["font-fa"]].filter(Boolean) as string[];
  if (families.length) css["font-family"] = families.map((f) => `"${f.replace(/"/g, "")}"`).join(",") + ",var(--font-editor)";
  if (st.smallcaps) css["font-variant"] = "small-caps";
  if (st.tracking) css["letter-spacing"] = st.tracking;
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
      <div class="table-size">{hover()[0] ? `${hover()[0]} × ${hover()[1]}` : t("Insert table")}</div>
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
    const a = c !== null ? c || null : ctx().align;
    return a === "start" ? null : a;
  };
  // The side a paragraph starts on (left for LTR text, right for RTL).
  const startSide = () => (ctx().rtl ? "right" : "left");
  const sideActive = (side: "left" | "right") => alignNow() === side || (!alignNow() && startSide() === side);
  const alignSide = (side: "left" | "right") => () => align(side === startSide() || alignNow() === side ? null : side)();

  // Recompute on cursor moves / edits.
  const ctx = createMemo(() => {
    cursor();
    const v = view();
    const content = state.active ? state.buffers[state.active]?.content : "";
    void content;
    const none = new Set<InlineKind>();
    if (!v)
      return {
        style: "p" as BlockStyle, align: null as string | null, dir: null as string | null, rtl: false, marks: none,
        list: null as ReturnType<typeof listKindAt>, span: {} as ReturnType<typeof spanAttrsAt>,
      };
    const pos = v.state.selection.main.head;
    const marks = new Set((["bold", "italic", "underline", "strike", "code"] as InlineKind[]).filter((k) => inlineActive(v.state, k)));
    return {
      style: blockStyleAt(v.state, pos),
      align: blockAttr(v.state, pos, "align"),
      dir: blockAttr(v.state, pos, "dir"),
      // The paragraph's actual direction (set, or detected from its text).
      rtl: v.textDirectionAt(pos) === Direction.RTL,
      marks,
      list: listKindAt(v.state, pos),
      span: spanAttrsAt(v.state, pos),
    };
  });

  const theme = activeTheme;
  /** The theme style of the paragraph at the cursor (body, h1…, quote). */
  const styleHere = () => theme()?.styles[ctx().style === "p" ? "body" : ctx().style];
  const bodyPt = () => Number(/^([\d.]+)pt$/.exec(theme()?.styles.body?.size ?? "")?.[1] ?? 11);
  const [lastColor, setLastColor] = createSignal("#c0392b");
  const [lastHighlight, setLastHighlight] = createSignal("#fff3a3");

  const pluginButtons = () => app.toolbar.items();

  const insertImageFile = async () => {
    const v = view();
    if (!v) return;
    const file = await pickFile({
      title: t("Insert image"),
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp"] }],
    });
    if (typeof file !== "string") return;
    try {
      insertImage(v, await ipc.importAttachment(file, attachmentDir(state.active)));
    } catch (e) {
      notify(String(e), "error");
    }
  };

  // Groups in order; the ones that don't fit go behind the "more" button.
  const groupDefs: { id: string; when?: () => boolean; render: () => JSX.Element }[] = [
    {
      id: "style",
      render: () => (
        <>
          <Popover
            class="tb-select style-select"
            title={t("Paragraph style")}
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
                  title={isTypst() ? t("Turn this line into #title[…]") : t("Make this line the note's title (stored as `title:` in Properties)")}
                  onClick={() => {
                    close();
                    run((v) => setTitle(v))();
                  }}
                >
                  <span class="style-sample" style={previewCss(theme()?.styles.title ?? { size: "20pt", weight: "bold" }, bodyPt())} dir="auto">
                    {t("Title")}
                  </span>
                  <span class="style-key">{platformKeys("Ctrl+Shift+T")}</span>
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
                      <span class="style-key">{platformKeys(s === "p" ? "Ctrl+0" : s === "quote" ? "" : `Ctrl+${s[1]}`)}</span>
                    </button>
                  )}
                </For>
                <div class="menu-sep" />
                <button class="menu-item" onClick={() => (close(), setDialog({ kind: "style", key: ctx().style === "p" ? "body" : ctx().style, scope: isTypst() ? "theme" : "note" }))}>
                  <span class="menu-icon"><Palette size={15} /></span>
                  <span class="menu-label">{t("Modify “{name}” style…", { name: t(STYLE_NAMES[ctx().style]) })}</span>
                </button>
              </div>
            )}
          </Popover>
        </>
      ),
    },
    {
      id: "font",
      render: () => (
        <>
          {/* The font and size of the text at the cursor; the theme's body font/size (greyed) when it has none of its own. */}
          <ComboBox
            class="font-combo"
            value={ctx().span.font ?? ""}
            placeholder={styleHere()?.font || theme()?.styles.body?.font || t("Font")}
            options={fontList()}
            renderOption={(f) => <span style={{ "font-family": `"${f}", var(--font-ui)` }}>{f}</span>}
            onChange={(f) => run((v) => applySpan(v, { font: f }))()}
          />
          <ComboBox
            class="size-combo"
            value={ctx().span.size?.replace(/pt$/, "") ?? ""}
            placeholder={styleHere()?.size?.replace(/pt$/, "") || String(bodyPt())}
            options={FONT_SIZES}
            onChange={(s) => {
              const size = /^\d+(\.\d+)?$/.test(s) ? `${s}pt` : s;
              run((v) => applySpan(v, { size }))();
            }}
          />
        </>
      ),
    },
    {
      id: "inline",
      render: () => (
        <>
          <Btn title={t("Bold (Ctrl+B)")} active={ctx().marks.has("bold")} onClick={run((v) => toggleInline(v, "bold"))}><Bold size={16} /></Btn>
          <Btn title={t("Italic (Ctrl+I)")} active={ctx().marks.has("italic")} onClick={run((v) => toggleInline(v, "italic"))}><Italic size={16} /></Btn>
          <Btn title={t("Underline (Ctrl+U)")} active={ctx().marks.has("underline")} onClick={run((v) => toggleInline(v, "underline"))}><Underline size={16} /></Btn>
          <Btn title={t("Strikethrough (Ctrl+Shift+X)")} active={ctx().marks.has("strike")} onClick={run((v) => toggleInline(v, "strike"))}><Strikethrough size={16} /></Btn>
          <Btn title={t("Inline code (Ctrl+E)")} active={ctx().marks.has("code")} onClick={run((v) => toggleInline(v, "code"))}><Code size={16} /></Btn>
          <div class="split-btn">
            <Btn title={t("Text color")} onClick={run((v) => applySpan(v, { color: lastColor() }))}>
              <span class="color-icon"><Baseline size={16} /><i style={{ background: lastColor() }} /></span>
            </Btn>
            <Popover class="tb-btn caret" title={t("Choose text color")} trigger={() => <ChevronDown size={12} />}>
              {(close) => (
                <ColorGrid
                  value={lastColor()}
                  noneLabel={t("Remove color")}
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
            <Btn title={t("Highlight")} onClick={run((v) => applySpan(v, { highlight: lastHighlight() }))}>
              <span class="color-icon"><Highlighter size={16} /><i style={{ background: lastHighlight() }} /></span>
            </Btn>
            <Popover class="tb-btn caret" title={t("Choose highlight")} trigger={() => <ChevronDown size={12} />}>
              {(close) => (
                <ColorGrid
                  value={lastHighlight()}
                  noneLabel={t("No highlight")}
                  onPick={(c) => {
                    close();
                    if (c) setLastHighlight(c);
                    run((v) => applySpan(v, { highlight: c }))();
                  }}
                />
              )}
            </Popover>
          </div>
        </>
      ),
    },
    {
      id: "align",
      render: () => (
        <>
          {/* No alignment = the paragraph's start side, so that button shows as on;
              clicking the start side (or the active button) goes back to no alignment. */}
          <Btn title={t("Align left")} active={sideActive("left")} onClick={alignSide("left")}><AlignLeft size={16} /></Btn>
          <Btn title={t("Center")} active={alignNow() === "center"} onClick={align(alignNow() === "center" ? null : "center")}><AlignCenter size={16} /></Btn>
          <Btn title={t("Align right")} active={sideActive("right")} onClick={alignSide("right")}><AlignRight size={16} /></Btn>
          <Btn title={cellAlign() !== null ? t("Justify (not available in tables)") : t("Justify")} disabled={cellAlign() !== null} active={alignNow() === "justify"} onClick={align(alignNow() === "justify" ? null : "justify")}><AlignJustify size={16} /></Btn>
          <Show when={!isTypst()}>
            <Btn title={t("Right-to-left paragraph")} active={ctx().dir === "rtl"} onClick={run((v) => setBlockAttr(v, "dir", ctx().dir === "rtl" ? null : "rtl"))}><PilcrowLeft size={16} /></Btn>
            <Btn title={t("Left-to-right paragraph")} active={ctx().dir === "ltr"} onClick={run((v) => setBlockAttr(v, "dir", ctx().dir === "ltr" ? null : "ltr"))}><PilcrowRight size={16} /></Btn>
          </Show>
        </>
      ),
    },
    {
      id: "lists",
      render: () => (
        <>
          <Btn title={t("Bulleted list")} active={ctx().list === "bullet"} onClick={run((v) => toggleList(v, "bullet"))}><List size={16} /></Btn>
          <Btn title={t("Numbered list")} active={ctx().list === "number"} onClick={run((v) => toggleList(v, "number"))}><ListOrdered size={16} /></Btn>
          <Btn title={t("Checklist")} active={ctx().list === "task"} onClick={run((v) => toggleList(v, "task"))}><ListChecks size={16} /></Btn>
          <Popover class="tb-btn" title={t("Callout")} trigger={() => (<><MessageSquareQuote size={16} /><ChevronDown size={11} class="muted" /></>)}>
            {(close) => {
              const [fold, setFold] = createSignal<"" | "+" | "-">("");
              return (
                <div class="menu callout-menu">
                  <For each={Object.entries(CALLOUTS)}>
                    {([type, c]) => (
                      <button class={`menu-item callout-item co-${type}`} onClick={() => (close(), run((v) => insertCallout(v, type, fold()))())}>
                        <span class="menu-icon">{c.icon}</span>
                        <span class="menu-label">{t(c.label)}</span>
                      </button>
                    )}
                  </For>
                  <Show when={!isTypst()}>
                    <div class="menu-sep" />
                    <label class="menu-item callout-fold" onMouseDown={(e) => e.stopPropagation()}>
                      <span class="menu-label">{t("Foldable")}</span>
                      <select class="input" value={fold()} onChange={(e) => setFold(e.currentTarget.value as any)}>
                        <option value="">{t("No")}</option>
                        <option value="+">{t("Yes, open")}</option>
                        <option value="-">{t("Yes, collapsed")}</option>
                      </select>
                    </label>
                  </Show>
                </div>
              );
            }}
          </Popover>
        </>
      ),
    },
    {
      id: "insert",
      render: () => (
        <>
          <Btn title={t("Link (Ctrl+K)")} onClick={run(insertLink)}><Link size={16} /></Btn>
          <Btn title={t("Image")} onClick={insertImageFile}><Image size={16} /></Btn>
          <Popover class="tb-btn" title={t("Table")} trigger={() => <Table size={16} />}>
            {(close) => <TableGrid onPick={(r, c) => (close(), run((v) => insertTable(v, r, c))())} />}
          </Popover>
          <Popover class="tb-btn" title={t("Insert…")} trigger={() => (<><Sigma size={16} /><ChevronDown size={11} class="muted" /></>)}>
            {(close) => (
              <div class="menu">
                <button class="menu-item" onClick={() => (close(), run((v) => insertMath(v, false))())}><span class="menu-icon"><Sigma size={15} /></span><span class="menu-label">{t("Inline math")}</span></button>
                <button class="menu-item" onClick={() => (close(), run((v) => insertMath(v, true))())}><span class="menu-icon"><Sigma size={15} /></span><span class="menu-label">{t("Display equation")}</span></button>
                <button class="menu-item" onClick={() => (close(), run(insertFootnote)())}><span class="menu-icon"><Footprints size={15} /></span><span class="menu-label">{t("Footnote")}</span></button>
                <button class="menu-item" onClick={() => (close(), run(insertPageBreak)())}><span class="menu-icon"><SeparatorHorizontal size={15} /></span><span class="menu-label">{t("Page break")}</span></button>
                <button class="menu-item" onClick={() => (close(), run(insertToc)())}><span class="menu-icon"><ListTree size={15} /></span><span class="menu-label">{t("Table of contents")}</span></button>
              </div>
            )}
          </Popover>
          <Show when={app.commands.has("insert.diagram")}>
            <button class="tb-btn accent-soft" title={t("Insert chart or diagram")} onMouseDown={(e) => e.preventDefault()} onClick={() => setDialog({ kind: "diagrams" })}>
              <Shapes size={16} />
              <span class="tb-label">{t("Diagram")}</span>
            </button>
          </Show>
        </>
      ),
    },
    {
      id: "plugins",
      when: () => pluginButtons().length > 0,
      render: () => (
        <>
            <For each={pluginButtons()}>
              {(b) => (
                <Btn title={b.title} onClick={b.run}>
                  <SvgIcon svg={b.icon} size={16} />
                </Btn>
              )}
            </For>
        </>
      ),
    },
  ];
  const groups = createMemo(() => groupDefs.filter((g) => !g.when || g.when()));

  // Overflow: hidden groups stay in the bar (invisible, out of flow) so their
  // width can still be measured as the window grows again.
  const [visible, setVisible] = createSignal(Infinity);
  let bar!: HTMLDivElement;
  let row!: HTMLDivElement;
  let frame = 0;
  const MORE = 40;
  const measure = () => {
    frame = 0;
    const items = [...row.children] as HTMLElement[];
    const widths = items.map((el) => el.getBoundingClientRect().width);
    const avail = row.clientWidth;
    const total = widths.reduce((a, b) => a + b, 0);
    if (total <= avail + 0.5) return setVisible(Infinity);
    let used = 0;
    let n = 0;
    for (const w of widths) {
      if (used + w > avail - MORE) break;
      used += w;
      n++;
    }
    setVisible(n);
  };
  const schedule = () => void (frame ||= requestAnimationFrame(measure));
  const ro = new ResizeObserver(schedule);
  onMount(() => {
    ro.observe(bar);
    schedule();
  });
  onCleanup(() => {
    ro.disconnect();
    cancelAnimationFrame(frame);
  });
  const hidden = () => groups().slice(Math.min(visible(), groups().length));

  return (
    <div class="toolbar" ref={bar} classList={{ disabled: !view() }}>
      <div class="tb-row" ref={row}>
        <For each={groups()}>
          {(g, i) => (
            <div class="tb-group" classList={{ "tb-hidden": i() >= visible() }} ref={(el) => ro.observe(el)}>
              {g.render()}
            </div>
          )}
        </For>
      </div>
      <Show when={hidden().length}>
        <Popover class="tb-btn tb-more" title={t("More tools")} align="end" trigger={() => <ChevronsRight size={17} />}>
          {() => (
            <div class="tb-overflow">
              <For each={hidden()}>{(g) => <div class="tb-group">{g.render()}</div>}</For>
            </div>
          )}
        </Popover>
      </Show>
      <Show when={!prefs.showTabBar}>
        <NoteMenuButton class="tb-btn" />
      </Show>
    </div>
  );
}
