// File history, deleted notes and vault snapshots, in one dialog.
import { createMemo, createResource, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Camera, Clock, Copy, History, RotateCcw, Trash2 } from "lucide-solid";
import { Modal, askText } from "./primitives";
import { ipc, stem, dirname, Version, SnapshotChange } from "../core/ipc";
import { diffLines, diffStats, withContext } from "../core/diff";
import { app, notify } from "../core/app";
import { ask } from "../core/native";
import { openNote, refreshTree, reloadFromDisk, saveAll, state } from "../core/store";

import { t, tn } from "../core/i18n";
export type HistoryTab = "note" | "deleted" | "snapshots";

const REASONS: Record<string, string> = {
  edit: t("Edited"),
  first: t("First seen"),
  outside: t("Changed outside NoteZ"),
  deleted: t("Before deleting"),
  restored: t("Restored"),
  "before-restore": t("Before a restore"),
  "before-replace": t("Before replace in vault"),
  "before-tag-rename": t("Before renaming a tag"),
  "before-link-update": t("Before updating links"),
  "before-sync": t("Before sync changed it"),
};

/** "Today 14:05", "Yesterday 09:12", "3 Nov 2026 18:40". */
export function when(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(new Date().toDateString()).getTime();
  if (day === today) return t("Today {time}", { time });
  if (day === today - 86_400_000) return t("Yesterday {time}", { time });
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} ${time}`;
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Line diff of `before` → `after`, unchanged runs collapsed. */
export function DiffView(props: { before: string; after: string; empty?: string }) {
  const ops = createMemo(() => diffLines(props.before, props.after));
  const stats = createMemo(() => diffStats(ops()));
  return (
    <div class="diff-view">
      <div class="diff-stats">
        <span class="ins">+{stats().added}</span> <span class="del">−{stats().removed}</span>
      </div>
      <Show when={stats().added + stats().removed} fallback={<div class="pane-empty">{props.empty ?? t("No differences.")}</div>}>
        <div class="diff-lines" dir="auto">
          <For each={withContext(ops())}>
            {(o) =>
              o.kind === "skip" ? (
                <div class="diff-skip">⋯ {tn(o.count, "{n} unchanged line", "{n} unchanged lines")}</div>
              ) : (
                <div class={`diff-line ${o.kind}`}>
                  <span class="ln">{o.kind === "ins" ? "" : o.a}</span>
                  <span class="ln">{o.kind === "del" ? "" : o.b}</span>
                  <span class="mark">{o.kind === "ins" ? "+" : o.kind === "del" ? "−" : " "}</span>
                  <span class="txt" dir="auto">{o.text || " "}</span>
                </div>
              )
            }
          </For>
        </div>
      </Show>
    </div>
  );
}

function NoteHistory(props: { path: string; close: () => void }) {
  const [versions, { refetch }] = createResource(() => props.path, (p) => ipc.historyList(p));
  // A save while the dialog is open adds or updates the newest version.
  onCleanup(app.events.on("note:saved", (e) => e.path === props.path && void refetch()));
  const [sel, setSel] = createSignal(0);
  const [against, setAgainst] = createSignal<"current" | "previous">("current");
  const current = createMemo(() => state.buffers[props.path]?.content);
  const [texts] = createResource(
    () => ({ list: versions(), i: sel(), mode: against(), cur: current() }),
    async ({ list, i, mode, cur }) => {
      const v = list?.[i];
      if (!v) return null;
      const text = await ipc.historyText(v.h);
      const prev = list![i + 1];
      const base = mode === "current" ? cur ?? (await ipc.read(props.path).catch(() => "")) : prev ? await ipc.historyText(prev.h) : "";
      // Shown as: what changes if you go from the base to this version.
      return mode === "current" ? { before: base, after: text } : { before: base, after: text };
    },
  );
  const restore = async (v: Version) => {
    await saveAll();
    try {
      await ipc.historyRestore(props.path, v.h);
      if (state.buffers[props.path]) await reloadFromDisk(props.path);
      notify(t("Restored the version of {x}. The text it replaced is kept in history.", { x: when(v.t) }));
      await refetch();
      setSel(0);
    } catch (e) {
      notify(String(e), "error");
    }
  };
  return (
    <div class="history-split">
      <div class="history-list">
        <For each={versions() ?? []} fallback={<div class="pane-empty">{versions.loading ? t("Loading…") : t("No versions yet. A version is kept as you save.")}</div>}>
          {(v, i) => (
            <button class="history-item" classList={{ active: sel() === i() }} onClick={() => setSel(i())}>
              <span class="when">{when(v.t)}</span>
              <span class="why">{REASONS[v.reason] ?? v.reason} · {size(v.size)}</span>
            </button>
          )}
        </For>
      </div>
      <div class="history-main">
        <Show when={versions()?.[sel()]}>
          {(v) => (
            <>
              <div class="history-bar">
                <div class="segmented">
                  <button classList={{ active: against() === "current" }} onClick={() => setAgainst("current")}>{t("Compared with now")}</button>
                  <button classList={{ active: against() === "previous" }} onClick={() => setAgainst("previous")}>{t("Changes in this version")}</button>
                </div>
                <span class="grow" />
                <button class="btn" onClick={async () => (await navigator.clipboard.writeText(await ipc.historyText(v().h)), notify(t("Copied the version's text.")))}>
                  <Copy size={14} /> {t("Copy text")}
                </button>
                <button class="btn primary" disabled={sel() === 0 && against() === "current" && texts()?.before === texts()?.after} onClick={() => void restore(v())}>
                  <RotateCcw size={14} /> {t("Restore")}
                </button>
              </div>
              <Show when={texts()} fallback={<div class="pane-empty">{t("Loading…")}</div>}>
                {(tx) => (
                  <DiffView
                    before={tx().before}
                    after={tx().after}
                    empty={against() === "current" ? t("Same as the note now.") : t("No changes.")}
                  />
                )}
              </Show>
              <p class="hint">{against() === "current" ? t("− lines are in the note now, + lines are in this version: restoring makes these changes.") : t("What changed since the version before it.")}</p>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

function DeletedNotes() {
  const [list, { refetch }] = createResource(() => ipc.historyDeleted());
  const [sel, setSel] = createSignal(0);
  const [text] = createResource(() => list()?.[sel()]?.h, (h) => ipc.historyText(h).catch(() => ""));
  const recover = async (path: string, h: string) => {
    try {
      await ipc.historyRestore(path, h);
      await refreshTree();
      notify(t("Recovered {path}.", { path }), "info", { label: t("Open"), run: () => void openNote(path) });
      await refetch();
      setSel(0);
    } catch (e) {
      notify(String(e), "error");
    }
  };
  return (
    <div class="history-split">
      <div class="history-list">
        <For each={list() ?? []} fallback={<div class="pane-empty">{list.loading ? t("Loading…") : t("No deleted notes in history.")}</div>}>
          {(d, i) => (
            <button class="history-item" classList={{ active: sel() === i() }} onClick={() => setSel(i())}>
              <span class="when" dir="auto">{stem(d.path)}</span>
              <span class="why" dir="auto">{dirname(d.path) || "/"} · {when(d.t)}</span>
            </button>
          )}
        </For>
      </div>
      <div class="history-main">
        <Show when={list()?.[sel()]}>
          {(d) => (
            <>
              <div class="history-bar">
                <strong dir="auto">{d().path}</strong>
                <span class="grow" />
                <button class="btn primary" onClick={() => void recover(d().path, d().h)}>
                  <RotateCcw size={14} /> {t("Recover")}
                </button>
              </div>
              <pre class="history-text" dir="auto">{text() ?? ""}</pre>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

function Snapshots() {
  const [list, { refetch }] = createResource(() => ipc.snapshotList());
  const [sel, setSel] = createSignal(0);
  const [changes, { refetch: refetchChanges }] = createResource(() => list()?.[sel()]?.id, (id) => ipc.snapshotDiff(id));
  const [file, setFile] = createSignal<SnapshotChange | null>(null);
  const [texts] = createResource(
    () => (file() && list()?.[sel()] ? { id: list()![sel()].id, f: file()! } : null),
    async ({ id, f }) => ({
      // Snapshot → now: what happened since.
      before: f.status === "added" ? "" : (await ipc.snapshotText(id, f.path)) ?? "(not a text file)",
      after: f.status === "removed" ? "" : state.buffers[f.path]?.content ?? (await ipc.read(f.path).catch(() => "(not a text file)")),
    }),
  );
  const [busy, setBusy] = createSignal(false);
  const take = async () => {
    const label = await askText(t("Name this snapshot"), "", "e.g. Before reorganizing");
    if (label === null) return;
    setBusy(true);
    try {
      await saveAll();
      await ipc.snapshotCreate(label || "Snapshot");
      await refetch();
      setSel(0);
      notify(t("Snapshot taken."));
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const restore = async (paths: string[] | null) => {
    const s = list()?.[sel()];
    if (!s) return;
    const added = (changes() ?? []).filter((c) => c.status === "added");
    let removeAdded = false;
    if (!paths) {
      const ok = await ask(t("Put every changed file back as it was in the snapshot of {x}? A snapshot of the vault as it is now is taken first.", { x: when(s.t) }), {
        title: t("Restore snapshot"), kind: "warning", okLabel: t("Restore"), cancelLabel: t("Cancel"),
      });
      if (!ok) return;
      if (added.length)
        removeAdded = await ask(tn(added.length, "{n} file was added since the snapshot. Remove it too?", "{n} files were added since the snapshot. Remove them too?"), {
          title: t("Files added since"), kind: "warning", okLabel: t("Remove"), cancelLabel: t("Keep"),
        });
    }
    setBusy(true);
    try {
      await saveAll();
      const done = await ipc.snapshotRestore(s.id, paths, removeAdded);
      for (const p of done) if (state.buffers[p]) await reloadFromDisk(p).catch(() => {});
      await refreshTree();
      notify(done.length ? tn(done.length, "Restored {n} file.", "Restored {n} files.") : t("Nothing to restore."));
      setFile(null);
      // Restoring takes a "Before restoring" snapshot: stay on this one.
      const fresh = await refetch();
      setSel(Math.max(0, (fresh ?? []).findIndex((x) => x.id === s.id)));
      await refetchChanges();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const s = list()?.[sel()];
    if (!s || !(await ask(t("Delete the snapshot of {x}?", { x: when(s.t) }), { title: t("Delete snapshot"), kind: "warning", okLabel: t("Delete"), cancelLabel: t("Cancel") }))) return;
    await ipc.snapshotDelete(s.id).catch((e) => notify(String(e), "error"));
    setSel(0);
    setFile(null);
    await refetch();
  };
  const label: Record<string, string> = { added: "added since", removed: "deleted since", modified: "changed since" };
  return (
    <div class="history-split">
      <div class="history-list">
        <button class="btn history-take" disabled={busy()} onClick={() => void take()}>
          <Camera size={14} /> {t("Take a snapshot now")}
        </button>
        <For each={list() ?? []} fallback={<div class="pane-empty">{list.loading ? t("Loading…") : t("No snapshots yet.")}</div>}>
          {(s, i) => (
            <button class="history-item" classList={{ active: sel() === i() }} onClick={() => (setSel(i()), setFile(null))}>
              <span class="when">{when(s.t)}</span>
              <span class="why">{s.label || (s.auto ? t("Automatic") : t("Snapshot"))} · {tn(s.files, "{n} file", "{n} files")} · {size(s.size)}</span>
            </button>
          )}
        </For>
      </div>
      <div class="history-main">
        <Show when={list()?.[sel()]}>
          {(s) => (
            <>
              <div class="history-bar">
                <strong>{s().label || "Snapshot"}</strong>
                <span class="muted">{when(s().t)}</span>
                <span class="grow" />
                <button class="btn" disabled={busy()} onClick={() => void remove()} title={t("Delete this snapshot")}>
                  <Trash2 size={14} />
                </button>
                <button class="btn primary" disabled={busy() || !changes()?.length} onClick={() => void restore(null)}>
                  <RotateCcw size={14} /> {t("Restore all…")}
                </button>
              </div>
              <Show when={!file()} fallback={
                <>
                  <div class="history-bar">
                    <button class="btn" onClick={() => setFile(null)}>{t("← All changes")}</button>
                    <strong dir="auto">{file()!.path}</strong>
                    <span class="muted">{label[file()!.status]}</span>
                    <span class="grow" />
                    <button class="btn primary" disabled={busy()} onClick={() => void restore([file()!.path])}>
                      <RotateCcw size={14} /> {file()!.status === "added" ? t("Remove") : t("Restore this file")}
                    </button>
                  </div>
                  <Show when={texts()} fallback={<div class="pane-empty">{t("Loading…")}</div>}>
                    {(t) => <DiffView before={t().before} after={t().after} />}
                  </Show>
                  <p class="hint">{t("− lines were in the snapshot, + lines are in the vault now.")}</p>
                </>
              }>
                <div class="snapshot-changes">
                  <For each={changes() ?? []} fallback={<div class="pane-empty">{changes.loading ? t("Comparing…") : t("The vault is the same as in this snapshot.")}</div>}>
                    {(c) => (
                      <button class="snapshot-change" onClick={() => setFile(c)}>
                        <span class={`badge ${c.status}`}>{c.status === "added" ? "new" : c.status === "removed" ? "deleted" : "changed"}</span>
                        <span dir="auto">{c.path}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

export default function HistoryDialog(props: { tab?: HistoryTab; path?: string; onClose: () => void }) {
  const path = props.path ?? state.active ?? "";
  const [tab, setTab] = createSignal<HistoryTab>(props.tab ?? (path ? "note" : "snapshots"));
  const tabs: [HistoryTab, string, () => JSX.Element][] = [
    ["note", path ? `${stem(path)}` : t("This note"), () => <Clock size={14} />],
    ["deleted", t("Deleted notes"), () => <Trash2 size={14} />],
    ["snapshots", t("Vault snapshots"), () => <Camera size={14} />],
  ];
  return (
    <Modal title={t("History")} subtitle={t("Earlier versions of your notes, deleted notes and snapshots of the whole vault.")} width="min(1080px, 94vw)" class="history-dialog" onClose={props.onClose}>
      <div class="history-tabs">
        <For each={tabs.filter(([t]) => t !== "note" || path)}>
          {([t, label, icon]) => (
            <button classList={{ active: tab() === t }} onClick={() => setTab(t)}>
              {icon()} <span dir="auto">{label}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={tab() === "note"}><NoteHistory path={path} close={props.onClose} /></Show>
      <Show when={tab() === "deleted"}><DeletedNotes /></Show>
      <Show when={tab() === "snapshots"}><Snapshots /></Show>
    </Modal>
  );
}

export { History as HistoryIcon };
