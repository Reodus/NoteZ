// Sidebar panes besides the file tree: search & replace, tags, bookmarks.
import { createEffect, createSignal, For, JSX, on, Show } from "solid-js";
import {
  Search, FileText, Replace, CaseSensitive, WholeWord, Regex, ChevronRight, Hash, Bookmark as BookmarkIcon,
  Folder, Trash2, Pencil, Heading, HelpCircle, X, Check,
} from "lucide-solid";
import { dirname, ipc, SearchHit, stem, FileChanges } from "../core/ipc";
import { notify } from "../core/app";
import { prefs, openNote, sidebarTab, setSidebarTab, sidebarPaneRequest, saveAll, state, setDialog, reloadFromDisk } from "../core/store";
import { tagTree, TagNode } from "../core/meta";
import {
  bookmarks, Bookmark, bookmarkLabel, removeBookmark, addGroup, renameBookmark, moveBookmark, toggleBookmark,
} from "../core/bookmarks";
import { ask } from "../core/native";
import { askText, openMenu } from "./primitives";

import { t, tn, num } from "../core/i18n";
// ------------------------------------------------------------------ search

const [query, setQuery] = createSignal("");
/** Show the search pane with `q` in the box. */
export function searchFor(q: string) {
  setQuery(q);
  setSidebarTab("search");
}

/** `text` with each of `marks` highlighted (first occurrence, case-insensitive). */
function highlight(text: string, marks: string[]): JSX.Element {
  const ranges: [number, number][] = [];
  const low = text.toLowerCase();
  for (const m of marks) {
    if (!m) continue;
    const i = low.indexOf(m.toLowerCase());
    if (i >= 0) ranges.push([i, i + m.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const out: JSX.Element[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a < at) continue;
    out.push(text.slice(at, a), <mark>{text.slice(a, b)}</mark>);
    at = b;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

const SYNTAX: [string, string][] = [
  ["word other", "lines with both words"],
  ['"exact phrase"', "the words together"],
  ["-word", "leave out notes with it"],
  ["/regex/  /regex/i", "regular expression"],
  ["tag:project  #project", "notes with the tag (or nested)"],
  ["path:Work  file:2024", "folder or file name contains"],
  ["prop:status=done", "frontmatter property"],
  ["type:task  todo  done", "task lines"],
  ["type:heading  code  quote  link", "lines of that kind"],
];

function SearchHelp() {
  return (
    <div class="search-help">
      <For each={SYNTAX}>{([k, v]) => <div><code>{k}</code><span>{v}</span></div>}</For>
      <button class="link" onClick={() => setDialog({ kind: "help", doc: "SEARCH" })}>{t("All search options…")}</button>
    </div>
  );
}

const [replaceOn, setReplaceOn] = createSignal(false);
/** Show the search pane in replace mode. */
export function openReplace() {
  setReplaceOn(true);
  setSidebarTab("search");
}

export function SearchPane() {
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [help, setHelp] = createSignal(false);
  let timer: number | undefined;
  let input!: HTMLInputElement;

  createEffect(on(query, (q) => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      setError("");
      if (!q.trim()) return setHits([]);
      setBusy(true);
      try {
        setHits(await ipc.search(q, [...prefs.excludedFolders]));
      } catch (e) {
        setHits([]);
        setError(String(e));
      } finally {
        setBusy(false);
      }
    }, 180);
  }));

  createEffect(() => (sidebarPaneRequest(), sidebarTab() === "search" && setTimeout(() => input?.focus())));

  const grouped = () => {
    const m = new Map<string, SearchHit[]>();
    for (const h of hits()) m.set(h.path, [...(m.get(h.path) ?? []), h]);
    return [...m.entries()];
  };
  const [collapsed, setCollapsed] = createSignal(new Set<string>());
  const toggle = (p: string) => {
    const s = new Set(collapsed());
    s.has(p) ? s.delete(p) : s.add(p);
    setCollapsed(s);
  };

  return (
    <div class="search-pane">
      <div class="search-box">
        <Search size={15} />
        <input
          ref={input}
          dir="auto"
          placeholder={t("Search notes…")}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
        />
        <Show when={query()}>
          <button class="icon-btn small" title={t("Clear")} onClick={() => setQuery("")}><X size={13} /></button>
        </Show>
        <button class="icon-btn small" classList={{ active: help() }} title={t("Search syntax")} onClick={() => setHelp(!help())}>
          <HelpCircle size={14} />
        </button>
        <button class="icon-btn small" classList={{ active: replaceOn() }} title={t("Replace in vault (Ctrl+Shift+H)")} onClick={() => setReplaceOn(!replaceOn())}>
          <Replace size={14} />
        </button>
      </div>
      <Show when={help()}><SearchHelp /></Show>
      <Show when={replaceOn()}>
        <ReplacePanel />
      </Show>
      <Show when={!replaceOn()}>
        <div class="search-meta">
          <Show when={error()} fallback={<Show when={query().trim()}>{busy() ? t("Searching…") : t("{results} results in {notes} notes", { results: num(hits().length) + (hits().length >= 500 ? "+" : ""), notes: grouped().length })}</Show>}>
            <span class="error-text">{error()}</span>
          </Show>
          <Show when={query().trim() && hits().length}>
            <button class="link" title={t("Bookmark this search")} onClick={() => toggleBookmark({ type: "search", query: query() })}>{t("Bookmark")}</button>
          </Show>
        </div>
        <div class="search-results">
          <For each={grouped()}>
            {([path, list]) => (
              <div class="search-group">
                <div class="search-file" onClick={() => openNote(path)}>
                  <ChevronRight size={13} class="chev" classList={{ open: !collapsed().has(path) }}
                    onClick={(e) => (e.stopPropagation(), toggle(path))} />
                  <FileText size={14} /> <span dir="auto">{stem(path)}</span>
                  <span class="search-dir">{dirname(path)}</span>
                  <span class="count">{list.filter((h) => h.line > 0).length || ""}</span>
                </div>
                <Show when={!collapsed().has(path)}>
                  <For each={list.filter((h) => h.line > 0).slice(0, 12)}>
                    {(h) => (
                      <div class="search-hit" dir="auto" title={h.snippet} onClick={() => openNote(path, { line: h.line })}>
                        <span class="ln">{h.line}</span>
                        {highlight(h.snippet, h.marks ?? [])}
                      </div>
                    )}
                  </For>
                  <Show when={list.filter((h) => h.line > 0).length > 12}>
                    <div class="search-more" onClick={() => openNote(path)}>{t("{n} more…", { n: list.filter((h) => h.line > 0).length - 12 })}</div>
                  </Show>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

// ----------------------------------------------------------------- replace

function ReplacePanel() {
  const [find, setFind] = createSignal(query().startsWith("/") ? "" : query());
  const [repl, setRepl] = createSignal("");
  const [scope, setScope] = createSignal("");
  const [regex, setRegex] = createSignal(false);
  const [matchCase, setCase] = createSignal(false);
  const [word, setWord] = createSignal(false);
  const [files, setFiles] = createSignal<FileChanges[]>([]);
  const [skip, setSkip] = createSignal(new Set<string>());
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let timer: number | undefined;

  const opts = () => ({ find: find(), replace: repl(), regex: regex(), case: matchCase(), word: word(), scope: scope() });

  const refresh = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      setError("");
      if (!find()) return setFiles([]);
      try {
        // Unsaved edits first, so the preview matches what is replaced.
        await saveAll();
        setFiles(await ipc.replacePreview(opts(), [...prefs.excludedFolders]));
      } catch (e) {
        setFiles([]);
        setError(String(e));
      }
    }, 200);
  };
  createEffect(on([find, repl, scope, regex, matchCase, word], refresh));

  const total = () => files().filter((f) => !skip().has(f.path)).reduce((n, f) => n + f.count, 0);
  const chosen = () => files().filter((f) => !skip().has(f.path)).map((f) => f.path);

  const apply = async () => {
    const paths = chosen();
    if (!paths.length) return;
    const n = total();
    const ok = await ask(t("Replace {matches} in {notes}?", { matches: tn(n, "{n} match", "{n} matches"), notes: tn(paths.length, "{n} note", "{n} notes") }), {
      title: t("Replace in vault"), okLabel: t("Replace"), cancelLabel: t("Cancel"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await saveAll();
      const done = await ipc.replaceApply(opts(), paths);
      // Open notes take the new text (the buffers were saved above).
      for (const p of done.filter((p) => state.buffers[p])) {
        await reloadFromDisk(p);
      }
      notify(t("Replaced {matches} in {notes}", { matches: tn(n, "{n} match", "{n} matches"), notes: tn(done.length, "{n} note", "{n} notes") }), "success");
      setSkip(new Set<string>());
      refresh();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  /** The line with each match struck out and its replacement marked. */
  const diff = (l: FileChanges["lines"][number]) => {
    const out: JSX.Element[] = [];
    const first = l.edits[0]?.at ?? 0;
    let at = Math.max(0, first - 30);
    if (at > 0) out.push("…");
    for (const e of l.edits) {
      if (e.at < at) continue;
      out.push(l.before.slice(at, e.at), <del>{e.old}</del>, <ins>{e.new}</ins>);
      at = e.at + e.old.length;
    }
    out.push(l.before.slice(at, at + 80));
    return <>{out}</>;
  };

  const Toggle = (p: { on: boolean; set: (v: boolean) => void; title: string; children: JSX.Element }) => (
    <button class="icon-btn small" classList={{ active: p.on }} title={p.title} onClick={() => p.set(!p.on)}>{p.children}</button>
  );

  return (
    <div class="replace-panel">
      <div class="search-box">
        <input dir="auto" placeholder={t("Find")} value={find()} onInput={(e) => setFind(e.currentTarget.value)} />
        <Toggle on={matchCase()} set={setCase} title={t("Match case")}><CaseSensitive size={15} /></Toggle>
        <Toggle on={word()} set={setWord} title={t("Whole words")}><WholeWord size={15} /></Toggle>
        <Toggle on={regex()} set={setRegex} title={t("Regular expression ($1 in the replacement)")}><Regex size={15} /></Toggle>
      </div>
      <div class="search-box">
        <input dir="auto" placeholder={t("Replace with")} value={repl()} onInput={(e) => setRepl(e.currentTarget.value)} />
      </div>
      <div class="search-box">
        <input placeholder={t("Only in… (path:Work tag:draft)")} value={scope()} onInput={(e) => setScope(e.currentTarget.value)} />
      </div>
      <div class="search-meta">
        <Show when={error()} fallback={<Show when={find()}>{t("{matches} in {notes}", { matches: tn(total(), "{n} match", "{n} matches"), notes: tn(chosen().length, "{n} note", "{n} notes") })}</Show>}>
          <span class="error-text">{error()}</span>
        </Show>
        <button class="btn small primary" disabled={!total() || busy()} onClick={apply}>
          <Replace size={13} /> {t("Replace all")}
        </button>
      </div>
      <div class="search-results">
        <For each={files()}>
          {(f) => (
            <div class="search-group" classList={{ skipped: skip().has(f.path) }}>
              <div class="search-file">
                <input
                  type="checkbox"
                  checked={!skip().has(f.path)}
                  title={t("Include this note")}
                  onChange={(e) => {
                    const s = new Set(skip());
                    e.currentTarget.checked ? s.delete(f.path) : s.add(f.path);
                    setSkip(s);
                  }}
                />
                <span dir="auto" onClick={() => openNote(f.path)}>{stem(f.path)}</span>
                <span class="search-dir">{dirname(f.path)}</span>
                <span class="count">{f.count}</span>
              </div>
              <For each={f.lines.slice(0, 20)}>
                {(l) => (
                  <div class="search-hit replace-hit" dir="auto" onClick={() => openNote(f.path, { line: l.line })}>
                    <span class="ln">{l.line}</span>
                    {diff(l)}
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- tags

function TagRow(props: { node: TagNode; depth: number }) {
  const [open, setOpen] = createSignal(false);
  const n = () => props.node;
  return (
    <>
      <div
        class="tree-item tag-item"
        style={{ "padding-inline-start": `${10 + props.depth * 14}px` }}
        onClick={() => searchFor(`tag:${n().tag}`)}
        onContextMenu={(e) =>
          openMenu(e, [
            { label: t("Search notes with this tag"), icon: <Search size={15} />, run: () => searchFor(`tag:${n().tag}`) },
            { label: t("Bookmark this tag's search"), icon: <BookmarkIcon size={15} />, run: () => toggleBookmark({ type: "search", query: `tag:${n().tag}` }) },
            { label: t("Rename tag…"), icon: <Pencil size={15} />, run: () => renameTag(n().tag) },
          ])
        }
        title={`#${n().tag}`}
      >
        <Show when={n().children.length} fallback={<span class="chev-space" />}>
          <ChevronRight size={13} class="ti chev" classList={{ open: open() }} onClick={(e) => (e.stopPropagation(), setOpen(!open()))} />
        </Show>
        <Hash size={14} class="ti tag" />
        <span class="tree-label" dir="auto">{n().name}</span>
        <span class="count">{n().count}</span>
      </div>
      <Show when={open()}>
        <For each={n().children}>{(c) => <TagRow node={c} depth={props.depth + 1} />}</For>
      </Show>
    </>
  );
}

/** Rename a tag (and its nested tags) everywhere, through find & replace. */
async function renameTag(tag: string) {
  const to = (await askText(t("Rename #{tag} to", { tag }), tag, "new/tag"))?.trim().replace(/^#/, "");
  if (!to || to === tag) return;
  if (!/^[\p{L}\p{N}_\-/]+$/u.test(to)) return notify(t("Tags may contain letters, digits, _, - and /"), "error");
  await saveAll();
  try {
    const changed = await ipc.renameTag(tag, to);
    for (const p of changed) if (state.buffers[p]) await reloadFromDisk(p);
    notify(t("Renamed #{tag} to #{to} in {notes}", { tag, to, notes: tn(changed.length, "{n} note", "{n} notes") }), "success");
  } catch (e) {
    notify(String(e), "error");
  }
}

export function TagsPane() {
  return (
    <div class="tree tags-pane">
      <For each={tagTree()} fallback={<div class="empty-hint"><p>{t("No tags yet.")}</p><p class="muted">{t("Write")} <code>#tag</code> {t("in a note or add")} <code>tags:</code> {t("to its properties.")}</p></div>}>
        {(n) => <TagRow node={n} depth={0} />}
      </For>
    </div>
  );
}

// --------------------------------------------------------------- bookmarks

let dragged: Bookmark | null = null;

function openBookmark(b: Bookmark) {
  if (b.type === "search") return searchFor(b.query ?? "");
  if (b.type === "folder") {
    setSidebarTab("files");
    return import("./Sidebar").then((m) => m.revealInTree(`${b.path}/x`));
  }
  if (b.type === "file" && b.path) {
    void openNote(b.path).then(() => {
      if (!b.subpath) return;
      // "#Heading" or "#^block-id": find the line in the open note.
      const text = state.buffers[b.path!]?.content ?? "";
      const sub = b.subpath.replace(/^#/, "");
      const lines = text.split("\n");
      const i = sub.startsWith("^")
        ? lines.findIndex((l) => l.trimEnd().endsWith(` ${sub}`) || l.trim() === sub)
        : lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s+/, "").trim() === sub);
      if (i >= 0) import("../core/store").then((s) => s.goToLine(i + 1));
    });
  }
}

function BookmarkRow(props: { b: Bookmark; depth: number }) {
  const [open, setOpen] = createSignal(true);
  const [over, setOver] = createSignal(false);
  const b = () => props.b;
  const icon = () => {
    switch (b().type) {
      case "group": return <BookmarkIcon size={14} class="ti" />;
      case "folder": return <Folder size={14} class="ti folder" />;
      case "search": return <Search size={14} class="ti" />;
      default: return b().subpath ? <Heading size={14} class="ti" /> : <FileText size={14} class="ti" />;
    }
  };
  const menu = (e: MouseEvent) =>
    openMenu(e, [
      ...(b().type === "group" ? [] : [{ label: t("Open"), icon: <Check size={15} />, run: () => openBookmark(b()) }]),
      { label: t("Rename…"), icon: <Pencil size={15} />, run: async () => {
        const name = await askText(t("Bookmark name"), bookmarkLabel(b()));
        if (name !== null) renameBookmark(b(), name.trim());
      } },
      { label: b().type === "group" ? t("Delete group") : t("Remove bookmark"), icon: <Trash2 size={15} />, danger: true, run: () => removeBookmark(b()) },
    ]);
  return (
    <>
      <div
        class="tree-item bookmark-item"
        classList={{ "drag-over": over() }}
        style={{ "padding-inline-start": `${10 + props.depth * 14}px` }}
        draggable={true}
        onDragStart={() => (dragged = b())}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          const path = e.dataTransfer?.getData("text/notez-path");
          if (path && !dragged) return toggleBookmark({ type: path.match(/\.\w+$/) ? "file" : "folder", path }, b().type === "group" ? b().title : undefined);
          if (dragged) moveBookmark(dragged, b(), b().type === "group");
          dragged = null;
        }}
        onClick={() => (b().type === "group" ? setOpen(!open()) : openBookmark(b()))}
        onContextMenu={menu}
        title={b().path ?? b().query ?? b().title ?? ""}
      >
        <Show when={b().type === "group"} fallback={<span class="chev-space" />}>
          <ChevronRight size={13} class="ti chev" classList={{ open: open() }} />
        </Show>
        {icon()}
        <span class="tree-label" dir="auto">{bookmarkLabel(b())}</span>
        <Show when={b().type === "group"}><span class="count">{b().items?.length || ""}</span></Show>
      </div>
      <Show when={b().type === "group" && open()}>
        <For each={b().items ?? []}>{(c) => <BookmarkRow b={c} depth={props.depth + 1} />}</For>
      </Show>
    </>
  );
}

export function BookmarksPane() {
  return (
    <div
      class="tree bookmarks-pane"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const path = e.dataTransfer?.getData("text/notez-path");
        if (path && !dragged) toggleBookmark({ type: /\.\w+$/.test(path) ? "file" : "folder", path });
        else if (dragged) moveBookmark(dragged, null);
        dragged = null;
      }}
    >
      <For
        each={bookmarks()}
        fallback={
          <div class="empty-hint">
            <p>{t("No bookmarks yet.")}</p>
            <p class="muted">{t("Bookmark a note from its ⋯ menu or the file tree, a heading from its right-click menu, or drag notes here.")}</p>
          </div>
        }
      >
        {(b) => <BookmarkRow b={b} depth={0} />}
      </For>
    </div>
  );
}

export async function newBookmarkGroup() {
  const name = (await askText(t("New bookmark group"), "", t("Group name")))?.trim();
  if (name) addGroup(name);
}

