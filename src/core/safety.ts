// File history settings, the daily vault snapshot, and sync (settings,
// secrets, schedule, status). The work itself is done by the core
// (core/src/history.rs, core/src/sync.rs).
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { app, notify } from "./app";
import { ipc, SyncRemote, SyncReport } from "./ipc";
import { prefs, root, state, reloadFromDisk, refreshTree, saveAll, setDialog } from "./store";
import { secretGet, secretSet } from "./native";

import { t, tn } from "./i18n";
// ------------------------------------------------------------- history

const historyConfig = () => ({
  enabled: prefs.historyEnabled,
  interval: Math.max(1, prefs.historyInterval),
  keep_days: Math.max(1, prefs.historyKeepDays),
  max_versions: Math.max(1, prefs.historyMaxVersions),
  keep_snapshots: Math.max(1, prefs.snapshotKeep),
});

createRoot(() => {
  // Settings go to the core whenever they change.
  createEffect(on(historyConfig, (c) => void ipc.historyConfig(c).catch(() => {})));
});

/** A snapshot once a day, when the last automatic one is older than that. */
async function dailySnapshot() {
  if (!prefs.snapshotDaily) return;
  try {
    const last = (await ipc.snapshotList()).find((s) => s.auto);
    if (last && Date.now() - last.t < 20 * 3600_000) return;
    await ipc.snapshotCreate("Daily", true);
  } catch (e) {
    console.warn("snapshot", e);
  }
}

app.events.on("vault:opened", async () => {
  await ipc.historyConfig(historyConfig()).catch(() => {});
  // Expired versions and snapshots go (with the user's settings, not defaults).
  void ipc.historyCleanup().catch(() => {});
  setTimeout(() => void dailySnapshot(), 15_000);
  void loadSyncSettings().then(() => {
    if (syncSettings().onOpen && syncConfigured()) void runSync(false);
  });
});
// A vault left open for days still gets its daily snapshot.
setInterval(() => root() && void dailySnapshot(), 3600_000);

// ---------------------------------------------------------------- sync

export interface SyncSettings {
  kind: SyncRemote["kind"];
  url: string;
  user: string;
  bucket: string;
  region: string;
  prefix: string;
  /** Minutes between automatic syncs (0 = only by hand). */
  interval: number;
  /** Sync when the vault opens. */
  onOpen: boolean;
  /** Keep the passphrase in the system keychain. */
  remember: boolean;
}

const EMPTY: SyncSettings = { kind: "", url: "", user: "", bucket: "", region: "", prefix: "", interval: 15, onOpen: true, remember: true };
const SETTINGS = ".notez/sync/settings.json";

const [settings, setSettingsRaw] = createSignal<SyncSettings>({ ...EMPTY });
export const syncSettings = settings;
/** Passphrase typed this session (when not remembered). */
let sessionPass = "";
const secretKey = (what: string) => `sync:${root()}:${what}`;

async function loadSyncSettings() {
  try {
    setSettingsRaw({ ...EMPTY, ...JSON.parse(await ipc.read(SETTINGS)) });
  } catch {
    setSettingsRaw({ ...EMPTY });
  }
  sessionPass = "";
  setSyncState({ status: "idle", last: (await ipc.syncStatus().catch(() => ({ last: 0 }))).last });
  schedule();
}

export async function saveSyncSettings(s: SyncSettings, secrets: { password?: string; passphrase?: string }) {
  await ipc.write(SETTINGS, JSON.stringify(s, null, 2) + "\n");
  setSettingsRaw(s);
  if (secrets.password !== undefined) await secretSet(secretKey("password"), secrets.password || null);
  if (secrets.passphrase !== undefined) {
    sessionPass = secrets.passphrase;
    await secretSet(secretKey("passphrase"), s.remember ? secrets.passphrase || null : null).catch((e) => notify(t("Passphrase not saved: {error}", { error: e }), "error"));
  } else if (!s.remember) await secretSet(secretKey("passphrase"), null).catch(() => {});
  schedule();
}

export const syncConfigured = () => !!settings().kind && !!settings().url;

/** The remote with its password from the keychain. */
export async function syncRemote(s = settings(), password?: string): Promise<SyncRemote> {
  return {
    kind: s.kind, url: s.url, user: s.user, bucket: s.bucket, region: s.region, prefix: s.prefix,
    password: password ?? (await secretGet(secretKey("password")).catch(() => null)) ?? "",
  };
}

export async function syncPassphrase(): Promise<string> {
  return sessionPass || (await secretGet(secretKey("passphrase")).catch(() => null)) || "";
}
export const hasStoredSecret = async (what: "password" | "passphrase") => !!(await secretGet(secretKey(what)).catch(() => null));

export type SyncStatus = "idle" | "syncing" | "error" | "needs-passphrase";
const [syncState, setSyncState] = createSignal<{ status: SyncStatus; last: number; error?: string; report?: SyncReport }>({ status: "idle", last: 0 });
export { syncState };

/** Sync now. `loud`: report the result (a manual sync). */
export async function runSync(loud = true): Promise<SyncReport | null> {
  if (!root() || !syncConfigured() || syncState().status === "syncing") return null;
  const pass = await syncPassphrase();
  if (!pass) {
    setSyncState((s) => ({ ...s, status: "needs-passphrase", error: t("Enter the sync passphrase in Settings → Sync.") }));
    if (loud) notify(t("Sync needs its passphrase: Settings → Sync."), "error");
    return null;
  }
  setSyncState((s) => ({ ...s, status: "syncing", error: undefined }));
  try {
    await saveAll();
    const r = await ipc.syncRun(await syncRemote(), pass);
    setSyncState({ status: "idle", last: r.t, report: r });
    if (r.changed.length) {
      for (const p of r.changed) if (state.buffers[p]) await reloadFromDisk(p).catch(() => {});
      await refreshTree();
      app.events.emit("vault:changed", undefined);
    }
    if (r.conflicts.length) notify(tn(r.conflicts.length, "Sync: {n} conflict — both versions were kept (“… (conflict …)”).", "Sync: {n} conflicts — both versions were kept (“… (conflict …)”)."), "error", undefined, 15000);
    else if (loud) {
      const n = r.uploaded.length + r.downloaded.length + r.deleted_here.length + r.deleted_there.length;
      const del = r.deleted_here.length + r.deleted_there.length;
      notify(n ? (del ? t("Synced: {sent} sent, {received} received, {deleted} deleted.", { sent: r.uploaded.length, received: r.downloaded.length, deleted: del }) : t("Synced: {sent} sent, {received} received.", { sent: r.uploaded.length, received: r.downloaded.length })) : t("Synced: everything is up to date."));
    }
    return r;
  } catch (e) {
    const msg = String(e);
    setSyncState((s) => ({ ...s, status: /passphrase/i.test(msg) ? "needs-passphrase" : "error", error: msg }));
    if (loud) notify(t("Sync failed: {error}", { error: msg }), "error", undefined, 12000);
    return null;
  }
}

let timer: number | undefined;
function schedule() {
  clearInterval(timer);
  const m = settings().interval;
  if (m > 0 && syncConfigured()) timer = window.setInterval(() => void runSync(false), m * 60_000);
}

/** A labelled snapshot taken by hand (asks for the label). */
export async function takeSnapshot(label?: string) {
  if (!root()) return;
  const { askText } = await import("../ui/primitives");
  const name = label ?? (await askText(t("Name this snapshot"), "", "e.g. Before reorganizing"));
  if (name === null) return;
  try {
    await saveAll();
    const s = await ipc.snapshotCreate(name || "Snapshot");
    notify(s ? t("Snapshot taken ({files} files).", { files: s.files }) : t("Nothing changed since the last snapshot."), "info", { label: t("Show"), run: () => setDialog({ kind: "history", tab: "snapshots" }) });
  } catch (e) {
    notify(t("Snapshot failed: {error}", { error: e }), "error");
  }
}
