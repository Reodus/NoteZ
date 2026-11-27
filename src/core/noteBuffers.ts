// Note buffer writes and the barriers used before closing notes or switching vaults.
import { app, notify } from "./app";
import { flushComments } from "./comments";
import { t } from "./i18n";
import { flushWrites, ipc } from "./ipc";
import { prefs } from "./preferences";
import { flushSaveParticipants } from "./saveParticipants";
import { isDirty, setState, state } from "./vaultState";

const saveTimers = new Map<string, number>();

export function cancelAutosave(path: string) {
  clearTimeout(saveTimers.get(path));
  saveTimers.delete(path);
}

export function replaceSavedBuffer(path: string, content: string) {
  cancelAutosave(path);
  setState("buffers", path, { content, saved: content });
  app.events.emit("note:reloaded", { path, content });
}

export function updateContent(path: string, content: string) {
  if (!state.buffers[path]) return;
  setState("buffers", path, "content", content);
  app.events.emit("note:changed", { path, content });
  cancelAutosave(path);
  saveTimers.set(path, window.setTimeout(() => void save(path).catch(() => {}), prefs.autosaveMs));
}

export async function save(path: string) {
  cancelAutosave(path);
  const b = state.buffers[path];
  if (!b || b.content === b.saved) return;
  const content = b.content;
  try {
    await ipc.write(path, content);
    if (state.buffers[path]) setState("buffers", path, "saved", content);
    app.events.emit("note:saved", { path });
  } catch (e) {
    notify(t("Save failed: {error}", { error: e }), "error");
    throw e;
  }
}

export async function saveAll() {
  do {
    const results = await Promise.allSettled([flushSaveParticipants(), flushComments(), ...Object.keys(state.buffers).map(save)]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    await flushWrites();
  } while (Object.keys(state.buffers).some(isDirty));
}

/** Take an open note's text from disk (after the app rewrote it, e.g. replace). */
export async function reloadFromDisk(path: string) {
  if (!state.buffers[path]) return;
  const content = await ipc.read(path);
  replaceSavedBuffer(path, content);
}
