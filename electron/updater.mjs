// Updates from the GitHub releases of Reodus/NoteZ.
//
// - AppImage, .deb, .rpm and the Windows installer update themselves with
//   electron-updater: download (checked against the sha512 in the release's
//   latest*.yml), then install on restart. .deb/.rpm ask for the admin
//   password through the system's usual dialog (pkexec).
// - The unsigned macOS build can't replace itself (macOS only allows that for
//   signed apps), and the portable .exe has no installer. For those the new
//   .dmg / .exe is downloaded into Downloads (checked against the sha256
//   GitHub publishes for every release file) and opened / shown.
//
// The UI sees one state object (sent as "update-state") and calls
// update-check / update-download / update-install.
import { app, BrowserWindow, net, shell } from "electron";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

const OWNER = "Reodus";
const REPO = "NoteZ";
const RELEASES = `https://github.com/${OWNER}/${REPO}/releases`;

/** "auto": electron-updater installs it. "download": we fetch the file for the user. "none": dev build / unknown package. */
function mode() {
  // For testing the flows from a development build.
  if (["auto", "download", "none"].includes(process.env.NOTEZ_UPDATE_MODE)) return process.env.NOTEZ_UPDATE_MODE;
  if (!app.isPackaged) return "none";
  if (process.platform === "darwin") return "download";
  if (process.platform === "win32") return process.env.PORTABLE_EXECUTABLE_FILE ? "download" : "auto";
  if (process.platform === "linux") {
    if (process.env.APPIMAGE) return "auto";
    const kind = path.join(process.resourcesPath, "package-type");
    const t = existsSync(kind) ? readFileSync(kind, "utf8").trim() : "";
    return t === "deb" || t === "rpm" ? "auto" : "none";
  }
  return "none";
}

/** @type {{status: string, version?: string, current: string, percent?: number, error?: string, mode: string, notesUrl?: string, file?: string}} */
let state = { status: "idle", current: app.getVersion(), mode: "none" };
let updater = null; // electron-updater's autoUpdater, loaded on first use
let asset = null; // "download" mode: the release file to fetch

function set(patch) {
  state = { ...state, ...patch };
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("update-state", state);
}

/** 1.2.10 > 1.2.9; a pre-release (1.3.0-beta) is older than 1.3.0. */
export function newer(a, b) {
  const parse = (v) => {
    const [main, pre] = String(v).replace(/^v/, "").split("-", 2);
    return { n: main.split(".").map((x) => parseInt(x, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0);
  if (x.pre === y.pre) return false;
  if (x.pre === null) return true;
  if (y.pre === null) return false;
  return x.pre > y.pre;
}

async function loadUpdater() {
  if (updater) return updater;
  const mod = await import("electron-updater");
  updater = (mod.default ?? mod).autoUpdater;
  updater.setFeedURL({ provider: "github", owner: OWNER, repo: REPO });
  updater.forceDevUpdateConfig = !app.isPackaged && !!process.env.NOTEZ_UPDATE_MODE; // testing from a dev build
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true; // a downloaded update also installs when the app is closed normally
  updater.allowPrerelease = false;
  updater.logger = null;
  updater.on("update-available", (i) => set({ status: "available", version: i.version, notesUrl: `${RELEASES}/tag/v${i.version}` }));
  updater.on("update-not-available", () => set({ status: "latest" }));
  updater.on("download-progress", (p) => set({ status: "downloading", percent: Math.round(p.percent) }));
  updater.on("update-downloaded", (i) => set({ status: "ready", version: i.version, percent: 100 }));
  updater.on("error", (e) => set({ status: "error", error: friendly(e) }));
  return updater;
}

function friendly(e) {
  const m = String(e?.message ?? e).split("\n")[0];
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(m)) return "No connection to GitHub. Check your internet connection.";
  if (/rate limit/i.test(m)) return "GitHub is limiting requests right now. Try again in an hour.";
  if (/404/.test(m)) return "The release files were not found on GitHub.";
  return m.length > 300 ? m.slice(0, 300) + "…" : m;
}

/** "download" mode: which file of a release this install needs. */
export function pickAsset(assets) {
  const names = assets.map((a) => a.name);
  let re;
  if (process.platform === "darwin") {
    re = process.arch === "arm64" ? /-arm64\.dmg$/i : /^(?!.*arm64).*\.dmg$/i;
  } else if (process.platform === "win32") {
    // NoteZ-1.2.3-portable.exe (and the older "NoteZ.1.2.3.exe": an .exe that isn't the Setup one)
    re = names.some((n) => /portable\.exe$/i.test(n)) ? /portable\.exe$/i : /^(?!.*setup).*\.exe$/i;
  } else return null;
  return assets.find((a) => re.test(a.name)) ?? null;
}

async function checkRelease() {
  const res = await net.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "NoteZ-updater" },
  });
  if (!res.ok) throw new Error(res.status === 403 ? "rate limit" : `GitHub answered ${res.status}`);
  const rel = await res.json();
  const version = String(rel.tag_name ?? "").replace(/^v/, "");
  if (!version || !newer(version, app.getVersion())) return set({ status: "latest" });
  asset = pickAsset(rel.assets ?? []);
  set({ status: "available", version, notesUrl: rel.html_url ?? `${RELEASES}/latest` });
}

export async function check() {
  if (["checking", "downloading"].includes(state.status)) return state;
  const m = mode();
  set({ mode: m, error: undefined });
  if (m === "none") return set({ status: "unsupported" }), state;
  set({ status: "checking" });
  try {
    if (m === "auto") {
      // null: electron-updater decided it can't update this copy.
      if (!(await (await loadUpdater()).checkForUpdates())) set({ status: "unsupported" });
    }
    else await checkRelease();
  } catch (e) {
    set({ status: "error", error: friendly(e) });
  }
  return state;
}

async function downloadFile() {
  if (!asset) {
    // No file for this system in the release: let the user pick on the page.
    await shell.openExternal(state.notesUrl ?? `${RELEASES}/latest`);
    return set({ status: "available" });
  }
  const dir = app.getPath("downloads");
  const file = path.join(dir, asset.name);
  const part = `${file}.part`;
  const res = await net.fetch(asset.browser_download_url, { headers: { "User-Agent": "NoteZ-updater" } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get("content-length")) || asset.size || 0;
  const hash = createHash("sha256");
  const out = createWriteStream(part);
  let got = 0;
  let last = -1;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (pct !== last) set({ status: "downloading", percent: (last = pct) });
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  } catch (e) {
    out.destroy();
    rmSync(part, { force: true });
    throw e;
  }
  const want = String(asset.digest ?? "").replace(/^sha256:/, "");
  if (want && want !== hash.digest("hex")) {
    rmSync(part, { force: true });
    throw new Error("The downloaded file is damaged (checksum mismatch). Try again.");
  }
  renameSync(part, file);
  set({ status: "ready", percent: 100, file });
}

export async function download() {
  if (state.status !== "available") return state;
  set({ status: "downloading", percent: 0, error: undefined });
  try {
    if (state.mode === "auto") await (await loadUpdater()).downloadUpdate();
    else await downloadFile();
  } catch (e) {
    set({ status: "error", error: friendly(e) });
  }
  return state;
}

/** Install: restart into the new version, or open the downloaded file. */
export async function install(beforeQuit) {
  if (state.status !== "ready") return;
  if (state.mode === "auto") {
    beforeQuit?.();
    // isSilent (Windows): no installer wizard; forceRunAfter: start the new version.
    setImmediate(() => updater.quitAndInstall(true, true));
  } else if (state.file) {
    if (process.platform === "darwin") await shell.openPath(state.file); // mounts the .dmg: drag NoteZ to Applications
    else shell.showItemInFolder(state.file);
  }
}

export const getState = () => state;
export const releasesUrl = RELEASES;
