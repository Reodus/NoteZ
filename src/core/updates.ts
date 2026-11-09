// New versions from GitHub releases (electron/updater.mjs does the work).
// Checked a few seconds after startup and every 6 hours while running, when
// Settings → Updates → "Check for updates automatically" is on.
import { createSignal } from "solid-js";
import { notify } from "./app";
import { openPath, openUrl, updates, UpdateState } from "./native";
import { prefs, saveAll } from "./store";

import { t } from "./i18n";
const [update, setUpdate] = createSignal<UpdateState | null>(null);
export { update };

let started = false;
/** Whether the current check was started by the user (show "up to date" / errors). */
let manual = false;

export function initUpdates() {
  if (started) return;
  started = true;
  void updates.state().then((s) => s && setUpdate(s));
  updates.onState((s) => {
    const prev = update()?.status;
    setUpdate(s);
    if (s.status === prev) return;
    if (s.status === "available") {
      notify(t("NoteZ {version} is available (you have {current}).", { version: s.version, current: s.current }), "info", { label: t("Update"), run: () => void downloadUpdate() }, 15000);
    } else if (s.status === "ready") {
      if (s.mode === "auto") notify(t("NoteZ {version} is ready. Restart to finish updating.", { version: s.version }), "success", { label: t("Restart"), run: () => void installUpdate() }, 30000);
      else notify(s.file ? t("Downloaded NoteZ {version} to {file}.", { version: s.version, file: s.file }) : t("Downloaded NoteZ {version}.", { version: s.version }), "success", { label: t("Open"), run: () => void installUpdate() }, 30000);
    } else if (s.status === "latest" && manual) {
      notify(t("NoteZ {current} is the latest version.", { current: s.current }), "success");
    } else if (s.status === "error" && (manual || prev === "downloading")) {
      notify(t("Update failed: {error}", { error: s.error }), "error");
    } else if (s.status === "unsupported" && manual) {
      notify(t("This copy of NoteZ can't update itself (a development build or an unpacked folder). Download the new version from GitHub."), "info", {
        label: t("Open releases"),
        run: () => void openUrl("https://github.com/Reodus/NoteZ/releases/latest"),
      });
    }
    if (!["checking", "downloading"].includes(s.status)) manual = false;
  });
  const auto = () => {
    if (prefs.checkUpdates) void updates.check();
  };
  window.setTimeout(auto, 5000);
  window.setInterval(auto, 6 * 60 * 60 * 1000);
}

export async function checkForUpdates() {
  manual = true;
  const s = await updates.check();
  if (s) setUpdate(s);
}

export async function downloadUpdate() {
  manual = true;
  await updates.download();
}

export async function installUpdate() {
  const s = update();
  if (s?.mode === "auto") await saveAll(); // the app restarts
  else if (!s?.file) return;
  await updates.install().catch((e) => {
    notify(t("Could not install: {error}", { error: e }), "error");
    if (s?.file) void openPath(s.file);
  });
}
