// Vault and tab operations. Re-exports keep existing UI and plugin consumers working.
import { batch } from "solid-js";
import { produce } from "solid-js/store";
import { app, notify } from "./app";
import { renameBookmarkPaths } from "./bookmarks";
import { flushComments, renameComments } from "./comments";
import { t, tn } from "./i18n";
import { dirname, fileKind, ipc, join, type Entry } from "./ipc";
import { ask, onVaultFs, openPath, trashPath } from "./native";
import { acceptDiskDeletion, acceptDiskText, clearDiskConflicts, isSavingNote, missingNote, reloadFromDisk, save, saveAll, waitForNoteSaves } from "./noteBuffers";
import { prefs, rememberVault, setPrefs } from "./preferences";
import { flushSaveParticipants } from "./saveParticipants";
import { type Buffer, editorView, isCurrentNoteOpen, isDirty, nextNoteOpen, notesList, removeTab, root, setFileRev, setNotesList, setRoot, setState, setTree, setVaultChanging, state, tree, vaultChanging } from "./vaultState";
import { revealEditorPosition } from "../editor/navigation";
import { readingTypst, setWorkspaceLayout, viewLayout } from "./workspace";

export { acceptDiskDeletion, pauseNoteSaves, reloadFromDisk, save, saveAll, updateContent, waitForNoteSaves } from "./noteBuffers";
export * from "./preferences";
export * from "./vaultState";
export * from "./workspace";

/**
 * Reload the file tree. Saving a note also reaches here (through the vault
 * watcher), but leaves the tree as it was: keep the old one then, so the
 * list isn't rebuilt (rows re-rendered, hover and scroll lost) on every save.
 * "vault:changed" still fires: plugins may care about content changes.
 */
export async function refreshTree() {
  const vault = root();
  if (!vault || vaultChanging()) return;
  try {
    const [t, n] = await Promise.all([ipc.tree(), ipc.notes()]);
    if (root() !== vault || vaultChanging()) return;
    const sameTree = JSON.stringify(t) === JSON.stringify(tree());
    const sameNotes = JSON.stringify(n) === JSON.stringify(notesList());
    if (!sameTree) setTree(t);
    if (!sameNotes) setNotesList(n);
    app.events.emit("vault:changed", undefined);
  } catch (e) {
    notify(String(e), "error");
  }
}

export async function openVault(path: string) {
  if (vaultChanging()) return;
  setVaultChanging(true);
  nextNoteOpen();
  try {
    await saveAll();
    let entries: Entry[];
    try {
      entries = await ipc.openVault(path);
    } catch (e) {
      notify(t("Cannot open vault: {error}", { error: e }), "error");
      setPrefs("recentVaults", (r) => r.filter((p) => p !== path));
      if (prefs.lastVault === path) setPrefs("lastVault", null);
      return;
    }
    const notes: string[] = [];
    const visit = (children: Entry[]) => {
      for (const entry of children) {
        if (entry.is_dir) visit(entry.children);
        else if (/\.(md|typ)$/.test(entry.path)) notes.push(entry.path);
      }
    };
    visit(entries);
    batch(() => {
      setTree(entries);
      setNotesList(notes.sort());
      setState({ tabs: [], active: null, buffers: {} });
      setRoot(path);
      rememberVault(path);
    });
    clearDiskConflicts();
  } finally {
    setVaultChanging(false);
  }
  app.events.emit("vault:opened", { root: path });
}

export async function closeVault() {
  if (vaultChanging()) return;
  setVaultChanging(true);
  nextNoteOpen();
  try {
    await saveAll();
    batch(() => {
      setRoot(null);
      setState({ tabs: [], active: null, buffers: {} });
      setPrefs("lastVault", null);
    });
    clearDiskConflicts();
  } finally {
    setVaultChanging(false);
  }
}

/**
 * Open a path handed over by the OS (macOS Finder / Dock). A folder becomes
 * the vault; a file opens in the current vault when it lives there, otherwise
 * its folder is opened as the vault first.
 */
export async function openOsPath(p: string) {
  const path = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (!base.includes(".")) return openVault(path);
  const r = root();
  if (!r || !path.startsWith(r + "/")) await openVault(dirname(path) || "/");
  const now = root();
  if (now && path.startsWith(now + "/")) await openNote(path.slice(now.length + 1));
}

let keepFocusFor: string | null = null;

export function keepFocusOnOpen(path: string) {
  if (keepFocusFor !== path) return false;
  keepFocusFor = null;
  return true;
}

/** Open a vault file: notes in the editor, images and PDFs in a viewer tab, anything else in its default app. */
export async function openNote(path: string, opts: { line?: number; keepFocus?: boolean } = {}) {
  if (!root() || vaultChanging()) return;
  const request = nextNoteOpen(), vault = root();
  const kind = fileKind(path);
  if (kind === "other") {
    if (root()) await openPath(`${root()}/${path}`).catch((e) => notify(String(e), "error"));
    return;
  }
  if (kind === "note" && !state.buffers[path]) {
    try {
      const content = await ipc.read(path);
      if (!isCurrentNoteOpen(request) || vault !== root()) return;
      setState("buffers", path, { content, saved: content });
    } catch (e) {
      notify(String(e), "error");
      return;
    }
  }
  keepFocusFor = opts.keepFocus && state.active !== path && kind === "note" ? path : null;
  setState(
    produce((s) => {
      if (!s.tabs.includes(path)) {
        const at = s.active ? s.tabs.indexOf(s.active) + 1 : s.tabs.length;
        s.tabs.splice(at, 0, path);
      }
      s.active = path;
    }),
  );
  app.events.emit("note:opened", { path });
  if (opts.line) queueMicrotask(() => setTimeout(() => {
    if (isCurrentNoteOpen(request) && root() === vault && state.active === path) goToLine(opts.line!);
  }, 30));
}

export function goToPreviewDiagnostic(line: number) {
  if (viewLayout() === "preview" || readingTypst()) {
    if (prefs.editorMode === "read") setPrefs("editorMode", "source");
    if (viewLayout() === "preview") setWorkspaceLayout("editor");
    const path = state.active;
    requestAnimationFrame(() => { if (state.active === path) goToLine(line); });
  } else goToLine(line);
}

export function goToLine(line: number, column = 0) {
  const view = editorView();
  if (!view) return;
  const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
  revealEditorPosition(view, Math.max(l.from, Math.min(l.to, l.from + column)), "nearest");
}

export async function closeTab(path: string) {
  await waitForNoteSaves();
  await flushSaveParticipants();
  await flushComments();
  do { await save(path); } while (isDirty(path));
  removeTab(path);
}

const TEMPLATE_MD = (title: string, theme: string) =>
  `---\ntitle: ${JSON.stringify(title)}\ntheme: ${JSON.stringify(theme)}\n${prefs.defaultLanguage ? `lang: ${JSON.stringify(prefs.defaultLanguage)}\n` : ""}---\n\n`;

export async function createNote(dir = "", name?: string, ext: "md" | "typ" = "md", content?: (title: string) => string) {
  let base = name ?? "Untitled";
  let path = join(dir, `${base}.${ext}`);
  for (let n = 1; notesList().includes(path); n++) path = join(dir, `${base} ${n}.${ext}`);
  try {
    await ipc.createNote(path);
    const title = path.slice(path.lastIndexOf("/") + 1).replace(/\.(md|typ)$/, "");
    const initial = content
      ? content(title)
      : ext === "md" ? TEMPLATE_MD(title, prefs.newNoteTheme) : `// theme: ${prefs.newNoteTheme}\n= ${title}\n\n`;
    await ipc.write(path, initial);
    await refreshTree();
    await openNote(path);
    const view = editorView();
    if (view) view.dispatch({ selection: { anchor: view.state.doc.length } });
    return path;
  } catch (e) {
    notify(String(e), "error");
  }
}

export async function createFolder(dir: string, name: string) {
  try {
    await ipc.createFolder(join(dir, name));
    await refreshTree();
  } catch (e) {
    notify(String(e), "error");
  }
}

/** Re-key open tabs/buffers after a rename of a file or folder. */
function moveOpen(from: string, to: string) {
  const remap = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
  setState(
    produce((s) => {
      s.tabs = s.tabs.map(remap);
      if (s.active) s.active = remap(s.active);
      const nb: Record<string, Buffer> = {};
      for (const [k, v] of Object.entries(s.buffers)) nb[remap(k)] = v;
      s.buffers = nb;
    }),
  );
}

/** Rename or move `path` to `to`, updating links per the preference. */
async function relocate(path: string, to: string) {
  try {
    await saveAll();
    let update = prefs.updateLinks === "always";
    if (prefs.updateLinks === "ask") {
      const n = await ipc.linkRefs(path).catch(() => 0);
      update = n > 0 && (await ask(t("Update links in {notes} that point to \"{path}\"?", { notes: tn(n, "{n} note", "{n} notes"), path }), {
        title: t("Update links"), okLabel: t("Update links"), cancelLabel: t("Don't update"),
      }));
    }
    const changed = await ipc.rename(path, to, update);
    renameComments(path, to);
    moveOpen(path, to);
    renameBookmarkPaths(path, to);
    // Rewritten notes that are open: take the new text (no unsaved edits — saveAll above).
    for (const p of changed.filter((c) => state.buffers[c])) {
      await reloadFromDisk(p);
    }
    await refreshTree();
    if (changed.length) notify(t("Updated links in {notes}", { notes: tn(changed.length, "{n} note", "{n} notes") }), "success");
  } catch (e) {
    notify(String(e), "error");
  }
}

export async function renameEntry(path: string, newName: string) {
  const to = join(dirname(path), newName);
  if (to !== path) await relocate(path, to);
}

export async function moveEntry(path: string, toDir: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const to = join(toDir, name);
  if (to === path || toDir === path || toDir.startsWith(path + "/")) return;
  await relocate(path, to);
}

/** Folder for a new note, per the "new note location" setting. */
export function newNoteDir(): string {
  if (prefs.newNoteLocation === "folder") return prefs.newNoteFolder.trim().replace(/^\/+|\/+$/g, "");
  if (prefs.newNoteLocation === "current" && state.active) return dirname(state.active);
  return "";
}

export async function deleteEntry(path: string) {
  if (prefs.confirmDelete) {
    const ok = await ask(
      prefs.deleteToTrash ? t("Move \"{path}\" to the trash?", { path }) : t("Delete \"{path}\"? This cannot be undone.", { path }),
      { title: t("Delete"), kind: "warning", okLabel: prefs.deleteToTrash ? t("Move to trash") : t("Delete"), cancelLabel: t("Cancel") },
    );
    if (!ok) return;
  }
  try {
    await saveAll();
    const closing = state.tabs.filter((t) => t === path || t.startsWith(path + "/"));
    let trashed = false;
    // History keeps the notes (Recover deleted notes), also from the trash.
    await ipc.historyKeep(path, "deleted").catch(() => {});
    if (prefs.deleteToTrash) {
      try {
        await trashPath(`${root()}/${path}`);
        trashed = true;
        await ipc.indexUpdate([path]);
      } catch (e) {
        const ok = await ask(t("Could not move \"{path}\" to the trash ({error}). Delete it permanently?", { path, error: e }), {
          title: t("Delete"), kind: "warning", okLabel: t("Delete permanently"), cancelLabel: t("Cancel"),
        });
        if (!ok) return;
      }
    }
    if (!trashed) await ipc.remove(path);
    for (const tab of closing) await closeTab(tab);
    await refreshTree();
  } catch (e) {
    notify(String(e), "error");
  }
}

// ------------------------------------------------- changes made on disk

let fsTreeTimer: number | undefined;

/** Files changed outside the app: refresh the tree and open notes. */
async function vaultChanged(paths: string[]) {
  const vault = root();
  if (!vault || vaultChanging()) return;
  if (paths.some((p) => !p.startsWith("."))) {
    clearTimeout(fsTreeTimer);
    fsTreeTimer = window.setTimeout(refreshTree, 100);
  }
  const hit = (t: string) => paths.some((p) => t === p || t.startsWith(p + "/"));
  if (state.tabs.some((t) => fileKind(t) !== "note" && hit(t))) setFileRev((n) => n + 1);
  for (const tab of state.tabs.filter(hit)) {
    const b = state.buffers[tab];
    if (!b) continue;
    let disk: string;
    try {
      disk = await ipc.read(tab);
    } catch (e) {
      if (root() !== vault || state.buffers[tab] !== b || vaultChanging()) continue;
      if (missingNote(e)) acceptDiskDeletion(tab);
      continue;
    }
    if (root() === vault && state.buffers[tab] === b && !vaultChanging() && !isSavingNote(tab)) acceptDiskText(tab, disk);
  }
}

onVaultFs((paths) => void vaultChanged(paths));
