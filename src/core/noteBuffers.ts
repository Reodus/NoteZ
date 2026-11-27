// Note buffer writes and the barriers used before closing notes or switching vaults.
import { app, notify } from "./app";
import { flushComments } from "./comments";
import { t } from "./i18n";
import { flushWrites, ipc } from "./ipc";
import { prefs } from "./preferences";
import { flushSaveParticipants } from "./saveParticipants";
import { isDirty, removeTab, root, setState, state } from "./vaultState";
import { pick } from "./workspace";

const saveTimers = new Map<string, number>();
const noteSaves = new Map<string, Promise<void>>();
const diskConflicts = new Map<string, () => void>();
let noteSavesPaused: Promise<void> | null = null;

export function clearDiskConflicts() { diskConflicts.clear(); }
export function isSavingNote(path: string) { return noteSaves.has(path); }

export function updateContent(path: string, content: string) {
  if (!state.buffers[path]) return;
  setState("buffers", path, "content", content);
  app.events.emit("note:changed", { path, content });
  scheduleSave(path);
}

function cancelSave(path: string) {
  clearTimeout(saveTimers.get(path));
  saveTimers.delete(path);
}

function scheduleSave(path: string) {
  cancelSave(path);
  if (!noteSavesPaused && !diskConflicts.has(path)) {
    saveTimers.set(path, window.setTimeout(() => void save(path).catch(() => {}), prefs.autosaveMs));
  }
}

/** Keep editing in memory while sync has exclusive access to the note files. */
export async function pauseNoteSaves() {
  do { await saveAll(); } while (noteSavesPaused);
  let resume!: () => void;
  noteSavesPaused = new Promise<void>(resolve => { resume = resolve; });
  for (const path of saveTimers.keys()) cancelSave(path);
  return () => {
    noteSavesPaused = null;
    resume();
    for (const path of Object.keys(state.buffers).filter(isDirty)) scheduleSave(path);
  };
}

export async function save(path: string, force = false) {
  cancelSave(path);
  const vault = root();
  // Re-evaluate dirty state after earlier writes, including an undo back to
  // the last saved text while an older edit is still being written.
  while (noteSaves.has(path)) await noteSaves.get(path)!.catch(() => {});
  if (!vault || root() !== vault || noteSavesPaused) return;
  const b = state.buffers[path];
  if (!b) return;
  const resolve = diskConflicts.get(path);
  if (resolve) {
    resolve();
    throw new Error(t('"{name}" changed on disk while you were editing.', { name: path }));
  }
  if (!force && b.content === b.saved) return;
  const content = b.content;
  const job = ipc.write(path, content, vault).then(() => {
    if (root() === vault && state.buffers[path] === b) setState("buffers", path, "saved", content);
    app.events.emit("note:saved", { path });
  });
  noteSaves.set(path, job);
  try {
    await job;
  } catch (e) {
    notify(t("Save failed: {error}", { error: e }), "error");
    throw e;
  } finally {
    if (noteSaves.get(path) === job) noteSaves.delete(path);
  }
}

export async function waitForNoteSaves() {
  while (noteSavesPaused) await noteSavesPaused;
}

export async function saveAll() {
  do {
    await waitForNoteSaves();
    const results = await Promise.allSettled([flushSaveParticipants(), flushComments(), ...Object.keys(state.buffers).map(path => save(path))]);
    const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failure) throw failure.reason;
    await flushWrites();
  } while (Object.keys(state.buffers).some(isDirty));
}

/** Take an open note's text from disk (after the app rewrote it, e.g. replace). */
export async function reloadFromDisk(path: string) {
  const vault = root();
  const b = state.buffers[path];
  if (!b) return;
  const content = await ipc.read(path);
  if (root() !== vault || state.buffers[path] !== b) return;
  acceptDiskText(path, content);
}

export function acceptDiskDeletion(path: string) {
  acceptDiskText(path, null);
}

export function acceptDiskText(path: string, disk: string | null) {
  const b = state.buffers[path];
  if (!b) return;
  if (disk === b.saved || disk === b.content) {
    const resolved = diskConflicts.delete(path);
    if (disk !== b.saved) setState("buffers", path, "saved", disk);
    if (resolved && isDirty(path)) scheduleSave(path);
    return;
  }
  const vault = root();
  const reload = (content: string | null) => {
    cancelSave(path);
    diskConflicts.delete(path);
    if (content === null) removeTab(path);
    else {
      setState("buffers", path, { content, saved: content });
      app.events.emit("note:reloaded", { path, content });
    }
  };
  if (!isDirty(path)) {
    reload(disk);
    return;
  }
  cancelSave(path);
  if (diskConflicts.has(path)) return;
  const current = () => root() === vault && state.buffers[path] === b && diskConflicts.has(path);
  const report = () => notify(t('"{name}" changed on disk while you were editing.', { name: path }), "error", {
    label: t("Resolve conflict"),
    run: () => {
      if (!current()) return;
      pick(t("Resolve conflict"), [
        { label: t("Keep my edits"), run: () => {
          if (!current()) return;
          diskConflicts.delete(path);
          void waitForNoteSaves().then(() => {
            if (root() === vault && state.buffers[path] === b) return save(path, true);
          }).catch(() => {});
        } },
        { label: t("Reload from disk"), run: () => {
          if (!current()) return;
          void ipc.read(path).then((latest) => {
            if (current()) reload(latest);
          }).catch(e => {
            if (!current()) return;
            if (missingNote(e)) reload(null);
            else notify(String(e), "error");
          });
        } },
      ]);
    },
  }, 0);
  diskConflicts.set(path, report);
  report();
}

export function missingNote(error: unknown) {
  return /not found|no such file|cannot find|os error [23]\b/i.test(String(error));
}
