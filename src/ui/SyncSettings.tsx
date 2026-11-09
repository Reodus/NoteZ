// Settings → History & sync.
import { createResource, createSignal, Show } from "solid-js";
import { CloudUpload, FlaskConical, History, Trash2 } from "lucide-solid";
import { Field, Segmented } from "./primitives";
import { prefs, setPrefs, root, setDialog } from "../core/store";
import { ipc } from "../core/ipc";
import { notify } from "../core/app";
import { ask, secretStore } from "../core/native";
import {
  hasStoredSecret, runSync, saveSyncSettings, syncPassphrase, syncRemote, syncSettings, syncState, SyncSettings as S, takeSnapshot,
} from "../core/safety";
import { when } from "./HistoryDialog";

import { t, tn } from "../core/i18n";
function Check(props: { checked: boolean; onChange: (v: boolean) => void; children: any; hint?: string }) {
  return (
    <label class="check">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      <span>
        {props.children}
        <Show when={props.hint}><span class="field-hint block">{props.hint}</span></Show>
      </span>
    </label>
  );
}

const num = (v: string, min: number) => Math.max(min, Math.round(Number(v) || min));

export function HistorySettings() {
  return (
    <>
      <Check checked={prefs.historyEnabled} onChange={(v) => setPrefs("historyEnabled", v)}
        hint={t("Kept in .notez/history inside the vault. Before deletes, renames, find & replace and restores a version is always kept.")}>
        {t("Keep earlier versions of notes")}
      </Check>
      <Field label={t("Merge edits made within (minutes)")} hint={t("Saves closer together than this become one version.")}>
        <input class="input narrow" type="number" min="1" value={prefs.historyInterval} onChange={(e) => setPrefs("historyInterval", num(e.currentTarget.value, 1))} />
      </Field>
      <Field label={t("Keep versions for (days)")}>
        <input class="input narrow" type="number" min="1" value={prefs.historyKeepDays} onChange={(e) => setPrefs("historyKeepDays", num(e.currentTarget.value, 1))} />
      </Field>
      <Field label={t("At most versions per note")}>
        <input class="input narrow" type="number" min="1" value={prefs.historyMaxVersions} onChange={(e) => setPrefs("historyMaxVersions", num(e.currentTarget.value, 1))} />
      </Field>
      <Check checked={prefs.snapshotDaily} onChange={(v) => setPrefs("snapshotDaily", v)} hint={t("A snapshot is only taken when something changed.")}>
        {t("Take a vault snapshot every day")}
      </Check>
      <Field label={t("Keep automatic snapshots (count)")} hint={t("Snapshots you take by hand are kept until you delete them.")}>
        <input class="input narrow" type="number" min="1" value={prefs.snapshotKeep} onChange={(e) => setPrefs("snapshotKeep", num(e.currentTarget.value, 1))} />
      </Field>
      <div class="row gap wrap">
        <button class="btn" disabled={!root()} onClick={() => setDialog({ kind: "history", tab: "snapshots" })}><History size={14} /> {t("Open history…")}</button>
        <button class="btn" disabled={!root()} onClick={() => void takeSnapshot()}>{t("Take a snapshot now")}</button>
        <button class="btn" disabled={!root()} onClick={async () => {
          const r = await ipc.historyCleanup().catch((e) => (notify(String(e), "error"), null));
          if (r !== null) notify(t("Expired versions and unused objects removed."));
        }}>{t("Clean up now")}</button>
      </div>
    </>
  );
}

export function SyncSettingsView() {
  const [store] = createResource(() => secretStore());
  const [draft, setDraft] = createSignal<S>({ ...syncSettings() });
  const [password, setPassword] = createSignal<string | undefined>(undefined);
  const [passphrase, setPassphrase] = createSignal<string | undefined>(undefined);
  const [stored] = createResource(() => root(), async () => ({ password: await hasStoredSecret("password"), passphrase: await hasStoredSecret("passphrase") }));
  const [busy, setBusy] = createSignal(false);
  const set = <K extends keyof S>(k: K, v: S[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const save = async () => {
    await saveSyncSettings(draft(), { password: password(), passphrase: passphrase() });
    setPassword(undefined);
    setPassphrase(undefined);
  };
  const pass = async () => passphrase() ?? (await syncPassphrase());
  const test = async () => {
    setBusy(true);
    try {
      const p = await pass();
      if (!p) throw t("Enter a passphrase first.");
      await ipc.syncTest(await syncRemote(draft(), password()), p);
      notify(t("Connected. The passphrase matches this remote (or the remote is new)."));
    } catch (e) {
      notify(t("Test failed: {error}", { error: e }), "error", undefined, 12000);
    } finally {
      setBusy(false);
    }
  };
  const cleanup = async () => {
    if (!(await ask(t("Delete objects on the remote that no device needs any more?"), { title: t("Clean up remote"), okLabel: t("Clean up"), cancelLabel: t("Cancel") }))) return;
    setBusy(true);
    try {
      const n = await ipc.syncCleanup(await syncRemote(), await pass());
      notify(tn(n, "Removed {n} unused object from the remote.", "Removed {n} unused objects from the remote."));
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const k = () => draft().kind;
  const dirty = () => JSON.stringify(draft()) !== JSON.stringify(syncSettings()) || password() !== undefined || passphrase() !== undefined;
  return (
    <Show when={root()} fallback={<p class="field-hint">{t("Open a vault to set up sync.")}</p>}>
      <p class="field-hint">
        {t("Sync keeps this vault in step with other devices through a folder (e.g. a USB drive or a cloud-synced folder), a WebDAV server or S3-compatible storage. Everything is encrypted on this device with your passphrase before it leaves; the remote only sees random names and ciphertext. Settings are stored in")} <code>.notez/sync/settings.json</code>{t(", the password and passphrase in the system keychain.")}
      </p>
      <Show when={store() && store() !== "keychain"}>
        <p class="warn-box">
          {store() === "plain"
            ? t("No system keychain was found: remembered secrets are stored unencrypted in the app's settings folder.")
            : t("Secrets can't be stored on this system: you'll type the passphrase each session.")}
        </p>
      </Show>
      <Field label={t("Sync to")}>
        <Segmented value={k() || "off"} onChange={(v) => set("kind", v === "off" ? "" : (v as S["kind"]))}
          options={[{ value: "off", label: t("Off") }, { value: "folder", label: t("Folder") }, { value: "webdav", label: t("WebDAV") }, { value: "s3", label: t("S3") }]} />
      </Field>
      <Show when={k()}>
        <Field label={k() === "folder" ? t("Folder") : k() === "webdav" ? t("WebDAV URL") : t("Endpoint URL")}
          hint={k() === "folder" ? t("An absolute path outside the vault.") : k() === "webdav" ? t("e.g. https://cloud.example.com/remote.php/dav/files/me/NoteZ") : t("e.g. https://s3.eu-central-1.amazonaws.com or your MinIO / R2 / B2 endpoint.")}>
          <input class="input" value={draft().url} onChange={(e) => set("url", e.currentTarget.value.trim())} />
        </Field>
        <Show when={k() === "s3"}>
          <Field label={t("Bucket")}><input class="input" value={draft().bucket} onChange={(e) => set("bucket", e.currentTarget.value.trim())} /></Field>
          <Field label={t("Region")} hint={t("us-east-1 when your provider doesn't use regions.")}><input class="input" value={draft().region} placeholder="us-east-1" onChange={(e) => set("region", e.currentTarget.value.trim())} /></Field>
          <Field label={t("Prefix")} hint={t("A folder inside the bucket (optional).")}><input class="input" value={draft().prefix} onChange={(e) => set("prefix", e.currentTarget.value.trim())} /></Field>
        </Show>
        <Show when={k() !== "folder"}>
          <Field label={k() === "s3" ? t("Access key ID") : t("User name")}>
            <input class="input" value={draft().user} autocomplete="off" onChange={(e) => set("user", e.currentTarget.value.trim())} />
          </Field>
          <Field label={k() === "s3" ? t("Secret access key") : t("Password")} hint={stored()?.password && password() === undefined ? t("Saved. Type to replace it.") : undefined}>
            <input class="input" type="password" autocomplete="off" value={password() ?? ""} placeholder={stored()?.password ? "••••••••" : ""} onInput={(e) => setPassword(e.currentTarget.value)} />
          </Field>
        </Show>
        <Field label={t("Encryption passphrase")} hint={t("Use the same passphrase on every device. If you lose it, the synced copy can't be read (your local notes are not affected).")}>
          <input class="input" type="password" autocomplete="new-password" value={passphrase() ?? ""} placeholder={stored()?.passphrase ? "•••••••• (saved)" : ""} onInput={(e) => setPassphrase(e.currentTarget.value)} />
        </Field>
        <Check checked={draft().remember} onChange={(v) => set("remember", v)}>{t("Remember the passphrase on this device")}</Check>
        <Field label={t("Sync automatically every (minutes, 0 = only by hand)")}>
          <input class="input narrow" type="number" min="0" value={draft().interval} onChange={(e) => set("interval", Math.max(0, Math.round(Number(e.currentTarget.value) || 0)))} />
        </Field>
        <Check checked={draft().onOpen} onChange={(v) => set("onOpen", v)}>{t("Sync when the vault opens")}</Check>
      </Show>
      <div class="row gap wrap">
        <button class="btn primary" disabled={!dirty()} onClick={() => void save()}>{t("Save")}</button>
        <Show when={k()}>
          <button class="btn" disabled={busy() || !draft().url} onClick={() => void test()}><FlaskConical size={14} /> {t("Test connection")}</button>
          <button class="btn" disabled={busy() || dirty() || syncState().status === "syncing"} onClick={() => void runSync(true)}><CloudUpload size={14} /> {t("Sync now")}</button>
          <button class="btn" disabled={busy() || dirty()} onClick={() => void cleanup()}><Trash2 size={14} /> {t("Clean up remote")}</button>
        </Show>
      </div>
      <Show when={k()}>
        <p class="field-hint">
          {syncState().status === "syncing" ? t("Syncing…") : syncState().last ? t("Last synced {when}.", { when: when(syncState().last) }) : t("Not synced yet.")}
          <Show when={syncState().error}> <span class="error-text">{syncState().error}</span></Show>
        </p>
      </Show>
    </Show>
  );
}
