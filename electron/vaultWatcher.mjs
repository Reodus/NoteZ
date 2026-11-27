import { watch } from "node:fs";
import path from "node:path";

const visiblePath = (rel) =>
  !rel.split("/").some((segment) => segment.startsWith(".")) ||
  /^\.notez\/(styles|plugins|themes|snippets|comments)\//.test(rel);

/** Batch filesystem events for one vault, including NoteZ's visible sidecar files. */
export function watchVault(dir, onChanges) {
  const lifetime = new AbortController();
  const changed = new Set();
  let timer;
  try {
    const watcher = watch(dir, { recursive: true, signal: lifetime.signal }, (_event, name) => {
      if (!name || lifetime.signal.aborted) return;
      const rel = name.toString().split(path.sep).join("/");
      if (!visiblePath(rel)) return;
      changed.add(rel);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const paths = [...changed];
        changed.clear();
        void onChanges(paths, lifetime.signal);
      }, 150);
    });
    watcher.on("error", (error) => console.error("vault watcher:", error));
  } catch (error) {
    console.error("cannot watch vault:", error);
  }
  return () => {
    clearTimeout(timer);
    lifetime.abort();
  };
}
