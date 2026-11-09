// A database view: the result of a `.base` file, a ```base block or a
// ```query block, as a table, cards, list or board. Cells of note
// properties are edited in place (written to the note's frontmatter); the
// view's layout, columns, sort, grouping and filters are written back to the
// base's YAML.
import { createEffect, createMemo, createResource, createSignal, For, Index, JSX, on, onCleanup, Show } from "solid-js";
import { render } from "solid-js/web";
import {
  Table2, LayoutGrid, List, Columns3, ArrowUpDown, Group, Filter, Columns2, Plus, AlertTriangle, ArrowUp, ArrowDown, Check, Trash2, Pencil, Copy, FileText,
} from "lucide-solid";
import { app, notify } from "../core/app";
import { BaseCell, BaseResult, ipc, stem } from "../core/ipc";
import { cellSource, cellText, editBase, parseInput, setNoteProperty, setViewOption, addView, removeView } from "../core/bases";
import { fileSrc } from "../core/native";
import { openNote, prefs, root, state, tree } from "../core/store";
import { askText, openMenuAt, MenuItem } from "./primitives";
import { parseDocument } from "yaml";

import { t, tn } from "../core/i18n";
export interface BaseViewProps {
  kind: "base" | "query";
  src: string;
  /** The note (or .base file) showing it: `this` in expressions. */
  thisPath: string | null;
  /** Writes a changed source back; without it the view is read-only (an embed). */
  onSrc?: (next: string) => void;
  /** View to show first (name or index), e.g. from `![[x.base#View]]`. */
  view?: string;
  /** Inside a note: a bounded height. */
  embedded?: boolean;
}

const LAYOUTS: [string, string, () => JSX.Element][] = [
  ["table", "Table", () => <Table2 size={14} />],
  ["cards", "Cards", () => <LayoutGrid size={14} />],
  ["list", "List", () => <List size={14} />],
  ["board", "Board", () => <Columns3 size={14} />],
];

const FILE_COLUMNS = ["file.name", "file.basename", "file.folder", "file.path", "file.ext", "file.size", "file.ctime", "file.mtime", "file.tags", "file.links", "file.backlinks"];
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)(\?.*)?$/i;

/** Remembered view per base (so re-renders keep the chosen tab). */
const chosen = new Map<string, number>();

function rect(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: r.left, y: r.bottom + 4 };
}

function imageUrl(c: BaseCell): string | null {
  if (!c) return null;
  if (Array.isArray(c)) return imageUrl(c[0] ?? null);
  if (typeof c === "object") return c.link && IMAGE.test(c.link) ? fileSrc(`${root()}/${c.link}`) : null;
  if (typeof c === "string") {
    if (/^https?:\/\//.test(c)) return c;
    if (IMAGE.test(c)) return fileSrc(`${root()}/${c.replace(/^\/+/, "")}`);
  }
  return null;
}

export default function BaseView(props: BaseViewProps) {
  const key = () => `${props.thisPath ?? ""}\u0000${props.kind}`;
  const [vi, setVi] = createSignal<number | null>(chosen.get(key()) ?? null);
  const [tick, setTick] = createSignal(0);
  let timer = 0;
  const bump = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => setTick((n) => n + 1), 250);
  };
  const offs = [app.events.on("note:saved", bump), app.events.on("vault:changed", bump), app.events.on("note:reloaded", bump)];
  onCleanup(() => (offs.forEach((o) => o()), clearTimeout(timer)));

  const [res] = createResource(
    () => ({ src: props.src, vi: vi(), t: tick(), ex: [...prefs.excludedFolders] }),
    async ({ src, vi, ex }): Promise<BaseResult | { error: string }> => {
      try {
        if (props.kind === "query") return await ipc.queryBlock(src, props.thisPath, ex);
        return await ipc.baseQuery(src, vi !== null ? String(vi) : (props.view ?? null), props.thisPath, ex);
      } catch (e) {
        return { error: String(e) };
      }
    },
  );
  // Keep the last good result while a new one loads (no flicker).
  const [last, setLast] = createSignal<BaseResult | { error: string } | null>(null);
  createEffect(() => {
    const r = res();
    if (r) setLast(r);
  });
  const r = createMemo(() => {
    const x = last();
    return x && !("error" in x) ? x : null;
  });
  const error = () => {
    const x = last();
    return x && "error" in x ? x.error : null;
  };
  const cur = () => r()?.view ?? 0;
  const editable = () => !!props.onSrc && props.kind === "base";

  const write = (next: string) => props.onSrc?.(next);
  const safe = (f: () => string) => {
    try {
      write(f());
    } catch (e) {
      notify(t("The base's YAML can't be edited: {error}", { error: e }), "error");
    }
  };
  const pick = (i: number) => {
    chosen.set(key(), i);
    setVi(i);
  };

  // ---------------------------------------------------------- toolbar menus

  const columnIds = () => r()?.columns.map((c) => c.id) ?? [];
  const formulas = (): string[] => {
    try {
      const f = parseDocument(props.src).toJS()?.formulas;
      return f && typeof f === "object" ? Object.keys(f).map((k) => `formula.${k}`) : [];
    } catch {
      return [];
    }
  };
  const colName = (id: string) => r()?.columns.find((c) => c.id === id)?.name ?? id.replace(/^(note|formula)\./, "");
  /** "rating" → "note.rating" (file./formula./note./this. ids stay). */
  const normId = (id: string) => (/^(file|formula|note|this)\./.test(id) ? id : `note.${id}`);
  const sortOf = (): { property: string; direction: string }[] =>
    ((r()?.options?.sort as any[]) ?? []).filter((x) => x && typeof x.property === "string").map((x) => ({ property: normId(x.property.trim()), direction: String(x.direction ?? "ASC").toUpperCase() }));

  const layoutMenu = (e: MouseEvent) =>
    openMenuAt(rect(e).x, rect(e).y, LAYOUTS.map(([t, label, icon]) => ({
      label, icon: icon(), hint: r()?.type === t ? "✓" : undefined,
      run: () => safe(() => setViewOption(props.src, cur(), "type", t)),
    })));

  const columnsMenu = async (e: MouseEvent) => {
    const at = rect(e);
    const props_ = await ipc.propertyNames([...prefs.excludedFolders]).catch(() => [] as string[]);
    const ids = columnIds();
    const toggle = (id: string) =>
      safe(() => setViewOption(props.src, cur(), "order", ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
    const item = (id: string): MenuItem => ({ label: colName(id), hint: ids.includes(id) ? "✓" : undefined, run: () => toggle(id) });
    openMenuAt(at.x, at.y, [
      ...props_.slice(0, 30).map((p) => item(`note.${p}`)),
      "-",
      { label: t("File"), items: FILE_COLUMNS.map(item), run: () => {} },
      ...(formulas().length ? [{ label: t("Formulas"), items: formulas().map(item), run: () => {} } as MenuItem] : []),
      "-",
      { label: t("Add a formula…"), icon: <Plus size={14} />, run: () => void addFormula() },
    ]);
  };

  const addFormula = async () => {
    const name = await askText(t("Formula name"), "", "e.g. per_page");
    if (!name) return;
    const expr = await askText(t("Formula “{name}”", { name }), "", "e.g. price / pages");
    if (!expr) return;
    const id = name.trim().replace(/\s+/g, "_");
    safe(() => {
      const withF = editBase(props.src, (doc) => doc.setIn(["formulas", id], expr));
      return setViewOption(withF, cur(), "order", [...columnIds(), `formula.${id}`]);
    });
  };

  const setSort = (id: string | null, dir?: "ASC" | "DESC") =>
    safe(() => setViewOption(props.src, cur(), "sort", id ? [{ property: id, direction: dir ?? "ASC" }] : null));

  const sortMenu = (e: MouseEvent) => {
    const s = sortOf()[0];
    openMenuAt(rect(e).x, rect(e).y, [
      ...columnIds().flatMap((id): MenuItem[] => [
        { label: `${colName(id)} ↑`, hint: s?.property === id && s.direction !== "DESC" ? "✓" : undefined, run: () => setSort(id, "ASC") },
        { label: `${colName(id)} ↓`, hint: s?.property === id && s.direction === "DESC" ? "✓" : undefined, run: () => setSort(id, "DESC") },
      ]),
      "-",
      { label: t("No sorting"), run: () => setSort(null) },
    ]);
  };

  const groupMenu = (e: MouseEvent) =>
    openMenuAt(rect(e).x, rect(e).y, [
      { label: t("No grouping"), hint: r()?.group_by ? undefined : "✓", run: () => safe(() => setViewOption(props.src, cur(), "groupBy", null)) },
      "-",
      ...columnIds().filter((id) => id !== "file.name").map((id): MenuItem => ({
        label: colName(id),
        hint: r()?.group_by === id ? "✓" : undefined,
        run: () => safe(() => setViewOption(props.src, cur(), "groupBy", { property: id, direction: "ASC" })),
      })),
    ]);

  const filterEdit = async () => {
    const curF = r()?.options?.filters;
    const list: string[] = typeof curF === "string" ? [curF] : Array.isArray(curF?.and) ? curF.and.filter((x: unknown) => typeof x === "string") : [];
    const text = await askText(t("Filter this view (an expression; combine with && and ||)"), list.map((x) => (list.length > 1 && /\|\|/.test(x) ? `(${x})` : x)).join(" && "), 'e.g. status != "done" && rating > 3');
    if (text === null) return;
    safe(() => setViewOption(props.src, cur(), "filters", text.trim() ? text.trim() : null));
  };

  const viewMenu = (e: MouseEvent, i: number) => {
    e.preventDefault();
    const name = r()?.views[i]?.name ?? "";
    openMenuAt(e.clientX, e.clientY, [
      { label: t("Rename…"), icon: <Pencil size={14} />, run: async () => {
        const n = await askText(t("Rename view"), name);
        if (n) safe(() => setViewOption(props.src, i, "name", n));
      } },
      { label: t("Duplicate"), icon: <Copy size={14} />, run: () => safe(() => addView(props.src, r()?.views[i]?.type ?? "table", `${name} copy`, i)) },
      { label: t("Delete view"), icon: <Trash2 size={14} />, danger: true, run: () => {
        if ((r()?.views.length ?? 0) <= 1) return notify(t("A base needs at least one view."), "error");
        pick(0);
        safe(() => removeView(props.src, i));
      } },
    ]);
  };

  const newView = (e: MouseEvent) =>
    openMenuAt(rect(e).x, rect(e).y, LAYOUTS.map(([t, label, icon]) => ({
      label, icon: icon(),
      run: () => {
        const n = (r()?.views.length ?? 0);
        safe(() => addView(props.src, t, label, r() ? cur() : undefined));
        pick(n);
      },
    })));

  // --------------------------------------------------------------- editing

  const [editing, setEditing] = createSignal<{ row: string; col: string } | null>(null);
  const commit = async (path: string, col: string, text: string, like: BaseCell) => {
    setEditing(null);
    const value = parseInput(text, like);
    if (cellSource(like) === text.trim()) return;
    try {
      await setNoteProperty(path, col.replace(/^note\./, ""), value);
    } catch (e) {
      notify(String(e), "error");
    }
  };

  function Cell(p: { path: string; col: { id: string; editable: boolean }; value: BaseCell; first?: boolean }) {
    const isEditing = () => editing()?.row === p.path && editing()?.col === p.col.id;
    const canEdit = () => p.col.editable && /\.md$/i.test(p.path);
    return (
      <Show when={!isEditing()} fallback={
        <input
          class="base-input"
          value={cellSource(p.value)}
          ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit(p.path, p.col.id, e.currentTarget.value, p.value);
            if (e.key === "Escape") setEditing(null);
            e.stopPropagation();
          }}
          onBlur={(e) => isEditing() && void commit(p.path, p.col.id, e.currentTarget.value, p.value)}
          dir="auto"
        />
      }>
        <span
          class="base-cell"
          classList={{ editable: canEdit(), num: typeof p.value === "number" }}
          title={canEdit() ? t("Double-click to edit") : undefined}
          onDblClick={() => canEdit() && typeof p.value !== "boolean" && setEditing({ row: p.path, col: p.col.id })}
        >
          <Value v={p.value} path={p.path} first={p.first} onToggle={canEdit() ? (b) => void setNoteProperty(p.path, p.col.id.replace(/^note\./, ""), b) : undefined} />
        </span>
      </Show>
    );
  }

  function Value(p: { v: BaseCell; path: string; first?: boolean; onToggle?: (b: boolean) => void }): JSX.Element {
    const v = p.v;
    if (p.first) {
      return <a class="base-link" onClick={() => void openNote(p.path)} dir="auto">{cellText(v) || stem(p.path)}</a>;
    }
    if (v === null || v === undefined || v === "") return <span class="base-empty" />;
    if (typeof v === "boolean") return <input type="checkbox" checked={v} disabled={!p.onToggle} onChange={(e) => p.onToggle?.(e.currentTarget.checked)} />;
    if (Array.isArray(v)) {
      return <span class="base-chips"><For each={v}>{(x) => <span class="base-chip"><Value v={x} path={p.path} /></span>}</For></span>;
    }
    if (typeof v === "object") {
      if (v.error) return <span class="base-error" title={v.error}><AlertTriangle size={12} /> error</span>;
      if (v.link !== undefined) {
        const target = v.link;
        return target
          ? <a class="base-link" onClick={(e) => (e.stopPropagation(), void openNote(target))} dir="auto">{v.text}</a>
          : <span class="base-link missing" dir="auto">{v.text}</span>;
      }
      return <span dir="auto">{cellText(v)}</span>;
    }
    const s = String(typeof v === "number" ? cellText(v) : v);
    if (typeof v === "string" && /^https?:\/\//.test(v)) return <a class="base-link" href={v} target="_blank" rel="noreferrer">{v}</a>;
  return <span dir="auto">{s}</span>;
  }

  // ---------------------------------------------------------------- layouts

  const groupsOf = () => {
    const x = r();
    if (!x) return [];
    if (!x.group_by) return [{ name: null as string | null, rows: x.rows }];
    return x.groups.map((g) => ({ name: g, rows: x.rows.filter((row) => (row.group ?? "") === g) }));
  };

  const headerClick = (id: string) => {
    if (!editable()) return;
    const s = sortOf()[0];
    if (s?.property !== id) setSort(id, "ASC");
    else if (s.direction !== "DESC") setSort(id, "DESC");
    else setSort(null);
  };

  const TableLayout = () => (
    <div class="base-scroll">
      <table class="base-table">
        <thead>
          <tr>
            <For each={r()!.columns}>
              {(c) => (
                <th classList={{ sortable: editable() }} onClick={() => headerClick(c.id)} dir="auto">
                  {c.name}
                  <Show when={sortOf()[0]?.property === c.id}>
                    {sortOf()[0].direction === "DESC" ? <ArrowDown size={12} /> : <ArrowUp size={12} />}
                  </Show>
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={groupsOf()}>
            {(g) => (
              <>
                <Show when={g.name !== null}>
                  <tr class="base-group"><td colSpan={r()!.columns.length}>{g.name || "—"} <span class="base-count">{g.rows.length}</span></td></tr>
                </Show>
                <For each={g.rows}>
                  {(row) => (
                    <tr>
                      <Index each={r()!.columns}>
                        {(c, i) => <td><Cell path={row.path} col={c()} value={row.cells[i]} first={i === 0 && /^file\.(name|basename)$/.test(c().id)} /></td>}
                      </Index>
                    </tr>
                  )}
                </For>
              </>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );

  const Card = (p: { row: BaseResult["rows"][number]; drag?: boolean }) => {
    const img = () => imageUrl(p.row.image ?? null);
    return (
      <div
        class="base-card"
        draggable={p.drag}
        onDragStart={(e) => e.dataTransfer?.setData("text/x-notez-row", p.row.path)}
      >
        <Show when={img()}><img class="base-cover" src={img()!} alt="" loading="lazy" /></Show>
        <div class="base-card-body">
          <a class="base-card-title base-link" onClick={() => void openNote(p.row.path)} dir="auto">
            {cellText(p.row.cells[0]) || stem(p.row.path)}
          </a>
          <Index each={r()!.columns.slice(1)}>
            {(c, i) => (
              <Show when={cellText(p.row.cells[i + 1])}>
                <div class="base-field">
                  <span class="base-field-name" dir="auto">{c().name}</span>
                  <Cell path={p.row.path} col={c()} value={p.row.cells[i + 1]} />
                </div>
              </Show>
            )}
          </Index>
        </div>
      </div>
    );
  };

  const CardsLayout = () => (
    <For each={groupsOf()}>
      {(g) => (
        <>
          <Show when={g.name !== null}><h4 class="base-group-title">{g.name || "—"} <span class="base-count">{g.rows.length}</span></h4></Show>
          <div class="base-cards"><For each={g.rows}>{(row) => <Card row={row} />}</For></div>
        </>
      )}
    </For>
  );

  const ListLayout = () => (
    <For each={groupsOf()}>
      {(g) => (
        <>
          <Show when={g.name !== null}><h4 class="base-group-title">{g.name || "—"} <span class="base-count">{g.rows.length}</span></h4></Show>
          <ul class="base-list">
            <For each={g.rows}>
              {(row) => (
                <li>
                  <a class="base-link" onClick={() => void openNote(row.path)} dir="auto">{cellText(row.cells[0]) || stem(row.path)}</a>
                  <Index each={r()!.columns.slice(1)}>
                    {(c, i) => <Show when={cellText(row.cells[i + 1])}><span class="base-list-field"><Cell path={row.path} col={c()} value={row.cells[i + 1]} /></span></Show>}
                  </Index>
                </li>
              )}
            </For>
          </ul>
        </>
      )}
    </For>
  );

  const [over, setOver] = createSignal<string | null>(null);
  const BoardLayout = () => {
    const prop = () => r()!.group_by;
    const movable = () => !!prop()?.startsWith("note.");
    const drop = async (e: DragEvent, g: string) => {
      e.preventDefault();
      setOver(null);
      const path = e.dataTransfer?.getData("text/x-notez-row");
      if (!path || !movable()) return;
      const row = r()!.rows.find((x) => x.path === path);
      if (!row || row.group === g) return;
      // The group's raw value (from a card already in it), else its name.
      const sample = r()!.rows.find((x) => x.group === g)?.group_value;
      const value = g === "" ? null : sample !== undefined && typeof sample !== "object" ? sample : parseInput(g, null);
      await setNoteProperty(path, prop()!.replace(/^note\./, ""), value);
    };
    return (
      <Show when={prop()} fallback={<div class="base-hint">{t("A board needs a group: choose")} <b>{t("Group")}</b> {t("above (e.g. status).")}</div>}>
        <div class="base-board">
          <For each={groupsOf()}>
            {(g) => (
              <div
                class="base-column"
                classList={{ over: over() === g.name }}
                onDragOver={(e) => movable() && (e.preventDefault(), setOver(g.name))}
                onDragLeave={() => setOver(null)}
                onDrop={(e) => void drop(e, g.name ?? "")}
              >
                <div class="base-column-head" dir="auto">{g.name || t("No value")} <span class="base-count">{g.rows.length}</span></div>
                <For each={g.rows}>{(row) => <Card row={row} drag={movable()} />}</For>
              </div>
            )}
          </For>
        </div>
      </Show>
    );
  };

  const toggleTask = async (path: string, line: number) => {
    const buf = state.buffers[path];
    const text = buf?.content ?? (await ipc.read(path));
    const lines = text.split("\n");
    const l = lines[line - 1];
    if (l === undefined) return;
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/.exec(l);
    if (!m) return;
    lines[line - 1] = m[1] + (m[2] === " " ? "x" : " ") + m[3] + l.slice(m[0].length);
    const next = lines.join("\n");
    if (buf) {
      const { applyText } = await import("../core/blocks");
      applyText(path, next);
      const { saveAll } = await import("../core/store");
      await saveAll();
    } else await ipc.write(path, next);
    app.events.emit("vault:changed", undefined);
  };

  const LinesLayout = () => (
    <div class="base-lines">
      <For each={r()!.rows}>
        {(row) => (
          <div class="base-lines-note">
            <a class="base-link base-lines-title" onClick={() => void openNote(row.path)} dir="auto">{cellText(row.cells[0]) || stem(row.path)}</a>
            <Show when={row.lines?.length} fallback={<div class="base-hint">{t("the note matches")}</div>}>
              <For each={row.lines}>
                {([line, text]) => {
                  const task = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/.exec(text);
                  return (
                    <div class="base-line" dir="auto">
                      <Show when={task}>
                        <input type="checkbox" checked={task![1] !== " "} onChange={() => void toggleTask(row.path, line)} />
                      </Show>
                      <span class="base-line-text" onClick={() => void openNote(row.path, { line })}>
                        {task ? text.replace(/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s*/, "") : text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")}
                      </span>
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>
        )}
      </For>
    </div>
  );

  const body = () => {
    const t = r()?.type ?? "table";
    if (t === "count") return <div class="base-big">{r()!.total}</div>;
    if (t === "lines" || t === "tasks") return <LinesLayout />;
    if (t === "cards") return <CardsLayout />;
    if (t === "list") return <ListLayout />;
    if (t === "board") return <BoardLayout />;
  return <TableLayout />;
  };

  return (
    <div class="base-view" classList={{ embedded: props.embedded }}>
      <Show when={props.kind === "base" && r()}>
        <div class="base-bar">
          <div class="base-tabs">
            <For each={r()!.views}>
              {(v, i) => (
                <button classList={{ active: i() === cur() }} onClick={() => pick(i())} onContextMenu={(e) => editable() && viewMenu(e, i())} dir="auto">
                  {LAYOUTS.find(([t]) => t === v.type)?.[2]() ?? <Table2 size={14} />} {v.name}
                </button>
              )}
            </For>
            <Show when={editable()}>
              <button class="base-add" title={t("Add a view")} onClick={newView}><Plus size={14} /></button>
            </Show>
          </div>
          <Show when={editable()}>
            <div class="base-tools">
              <button title={t("Layout")} onClick={layoutMenu}>{LAYOUTS.find(([t]) => t === r()!.type)?.[2]() ?? <Table2 size={14} />}</button>
              <button title={t("Columns")} onClick={(e) => void columnsMenu(e)}><Columns2 size={14} /></button>
              <button title={t("Sort")} classList={{ on: sortOf().length > 0 }} onClick={sortMenu}><ArrowUpDown size={14} /></button>
              <button title={t("Group")} classList={{ on: !!r()!.group_by }} onClick={groupMenu}><Group size={14} /></button>
              <button title={t("Filter this view")} classList={{ on: !!r()!.options?.filters }} onClick={() => void filterEdit()}><Filter size={14} /></button>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={error()}>
        <div class="base-errors"><AlertTriangle size={14} /> {error()}</div>
      </Show>
      <Show when={r()}>
        <Show when={r()!.rows.length} fallback={<div class="base-hint">{t("No results.")}</div>}>
          <div class="base-body">{body()}</div>
        </Show>
        <div class="base-foot">
          <span>{r()!.rows.length < r()!.total ? t("{shown} of {n} results", { shown: r()!.rows.length, n: r()!.total }) : tn(r()!.total, "{n} result", "{n} results")}</span>
          <Show when={r()!.errors.length}>
            <span class="base-warn" title={r()!.errors.join("\n")}><AlertTriangle size={12} /> {r()!.errors[0]}{r()!.errors.length > 1 ? ` (+${r()!.errors.length - 1})` : ""}</span>
          </Show>
        </div>
      </Show>
      <Show when={!last()}>
        <div class="base-hint">{t("Loading…")}</div>
      </Show>
    </div>
  );
}

/** Mount a base view into `el` (for editor widgets); returns the disposer. */
export function mountBase(el: HTMLElement, p: BaseViewProps): () => void {
  return render(() => <BaseView {...p} />, el);
}

/** `.base` file tab: the view, plus its YAML source. */
export function BaseFile(props: { path: string }) {
  const [src, setSrc] = createSignal<string | null>(null);
  const [showSrc, setShowSrc] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const load = async () => {
    try {
      const t = await ipc.read(props.path);
      setSrc(t);
      setDraft(t);
    } catch (e) {
      notify(String(e), "error");
    }
  };
  createEffect(on(() => props.path, () => void load()));
  // Changed on disk (another app, sync).
  const off = app.events.on("vault:changed", () => void ipc.read(props.path).then((t) => t !== src() && (setSrc(t), setDraft(t))).catch(() => {}));
  onCleanup(off);
  const save = async (next: string) => {
    setSrc(next);
    setDraft(next);
    await ipc.write(props.path, next).catch((e) => notify(String(e), "error"));
  };
  return (
    <div class="base-file">
      <div class="base-file-head">
        <span class="base-file-title" dir="auto"><FileText size={15} /> {stem(props.path)}</span>
        <span class="grow" />
        <button class="btn small" classList={{ active: showSrc() }} onClick={() => setShowSrc(!showSrc())}>{showSrc() ? t("Hide source") : t("Edit source")}</button>
      </div>
      <Show when={showSrc()}>
        <div class="base-source">
          <textarea value={draft()} spellcheck={false} onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                e.preventDefault();
                void save(draft());
              }
            }} />
          <div class="row gap">
            <button class="btn primary small" disabled={draft() === src()} onClick={() => void save(draft())}><Check size={13} /> {t("Apply (Ctrl+S)")}</button>
            <button class="btn small" disabled={draft() === src()} onClick={() => setDraft(src() ?? "")}>{t("Revert")}</button>
            <span class="field-hint">{t("See Help → Databases for the syntax.")}</span>
          </div>
        </div>
      </Show>
      <Show when={src() !== null}>
        <BaseView kind="base" src={src()!} thisPath={props.path} onSrc={(n) => void save(n)} />
      </Show>
    </div>
  );
}

/** The vault path of `name` (a path, or a file name found anywhere). */
function findFile(name: string): string | null {
  const want = name.trim().replace(/^\/+/, "");
  const all: string[] = [];
  const walk = (es: ReturnType<typeof tree>) => es.forEach((e) => (e.is_dir ? walk(e.children) : all.push(e.path)));
  walk(tree());
  return all.find((p) => p === want) ?? all.find((p) => p.toLowerCase() === want.toLowerCase()) ?? all.find((p) => p.split("/").pop()!.toLowerCase() === want.split("/").pop()!.toLowerCase()) ?? null;
}

/** `![[x.base]]` / `![[x.base#View]]` inside a note: the view, read-only, with a title that opens the base. */
export function mountBaseEmbed(el: HTMLElement, target: string, host: string | null = state.active): () => void {
  const [name, view] = target.split("|")[0].split("#");
  return render(() => {
    const path = () => findFile(name);
    const [src, { refetch }] = createResource(path, (p) => ipc.read(p));
    const off = app.events.on("vault:changed", () => void refetch());
    onCleanup(off);
    return (
      <div class="base-embed">
        <div class="base-embed-head">
          <a class="base-link" onClick={() => path() && void openNote(path()!)}><Table2 size={13} /> {stem(name)}{view ? ` › ${view}` : ""}</a>
        </div>
        <Show when={path()} fallback={<div class="base-hint">{t("{name} was not found.", { name })}</div>}>
          <Show when={src() !== undefined}>
            <BaseView kind="base" src={src()!} thisPath={host ?? path()} view={view?.trim() || undefined} embedded />
          </Show>
        </Show>
      </div>
    );
  }, el);
}
