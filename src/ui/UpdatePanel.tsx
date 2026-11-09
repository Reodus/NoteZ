// Settings → Updates: the current version, what's available, and one button
// for the next step (check → update → restart / open the file).
import { Match, Show, Switch } from "solid-js";
import { openUrl } from "../core/native";
import { checkForUpdates, downloadUpdate, installUpdate, update } from "../core/updates";

import { t, num } from "../core/i18n";
export function UpdatePanel() {
  const s = update;
  return (
    <div class="update-panel">
      <div class="update-row">
        <div class="update-text">
          <div class="update-version">NoteZ {num(s()?.current ?? __APP_VERSION__)}</div>
          <div class="update-status">
            <Switch fallback={<span>{t("Not checked yet.")}</span>}>
              <Match when={s()?.status === "checking"}>{t("Checking GitHub for a new version…")}</Match>
              <Match when={s()?.status === "latest"}>{t("You have the latest version.")}</Match>
              <Match when={s()?.status === "available"}>
                {t("Version {version} is available.", { version: num(s()!.version!) })}{" "}
                <a href="#" onClick={(e) => (e.preventDefault(), void openUrl(s()!.notesUrl!))}>{t("What's new")}</a>
              </Match>
              <Match when={s()?.status === "downloading"}>
                {t("Downloading {version}… {percent}%", { version: num(s()!.version!), percent: s()!.percent ?? 0 })}
                <progress max="100" value={s()!.percent ?? 0} />
              </Match>
              <Match when={s()?.status === "ready" && s()!.mode === "auto"}>{t("Version {version} is downloaded. Restart NoteZ to finish.", { version: num(s()!.version!) })}</Match>
              <Match when={s()?.status === "ready"}>{t("Version {version} is saved in {file}.", { version: num(s()!.version!), file: s()!.file })}</Match>
              <Match when={s()?.status === "error"}>
                <span class="update-error">{s()!.error}</span>
              </Match>
              <Match when={s()?.status === "unsupported"}>
                This copy can't update itself (a development build or an unpacked folder).{" "}
                <a href="#" onClick={(e) => (e.preventDefault(), void openUrl("https://github.com/Reodus/NoteZ/releases/latest"))}>{t("Releases on GitHub")}</a>
              </Match>
            </Switch>
          </div>
        </div>
        <Switch fallback={<button class="btn" onClick={() => void checkForUpdates()}>{t("Check now")}</button>}>
          <Match when={s()?.status === "checking" || s()?.status === "downloading"}>
            <button class="btn" disabled>{t("Please wait…")}</button>
          </Match>
          <Match when={s()?.status === "available"}>
            <button class="btn primary" onClick={() => void downloadUpdate()}>{s()!.mode === "auto" ? t("Update") : t("Download")}</button>
          </Match>
          <Match when={s()?.status === "ready"}>
            <button class="btn primary" onClick={() => void installUpdate()}>{s()!.mode === "auto" ? t("Restart now") : t("Open")}</button>
          </Match>
        </Switch>
      </div>
      <Show when={s()?.mode === "download" && s()?.status !== "ready"}>
        <p class="field-hint block">
          On this system NoteZ downloads the new version into your Downloads folder.
          {" "}{navigator.platform.startsWith("Mac") ? t("Open it and drag NoteZ to Applications.") : t("Replace the old file with it.")}
        </p>
      </Show>
      <Show when={s()?.mode === "auto" && /linux/i.test(navigator.platform) && s()?.status === "ready"}>
        <p class="field-hint block">{t("Installing asks for your password, like any system package.")}</p>
      </Show>
    </div>
  );
}
