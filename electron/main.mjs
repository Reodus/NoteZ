// Electron shell: one window running the Solid UI, plus the Rust core
// (vault, Typst rendering, PDF export) as a helper process spoken to over
// newline-delimited JSON (see core/src/main.rs).
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, net, protocol, safeStorage, screen, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as updates from "./updater.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const devUrl = process.env.NOTEZ_DEV_URL; // set by `npm run dev`

// Files on disk (note images) are served as notez-asset://local/<abs path>;
// the built UI is served from app://notez/ (a real origin, so module scripts
// and localStorage behave as in a browser).
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "notez-asset", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// ------------------------------------------------------------ Rust core

const exe = process.platform === "win32" ? ".exe" : "";
const coreBin = app.isPackaged
  ? path.join(process.resourcesPath, `notez-core${exe}`)
  : path.join(root, `core/bin/notez-core${exe}`); // npm run core
const packagesDir = app.isPackaged ? path.join(process.resourcesPath, "typst-packages") : path.join(root, "core/typst-packages");
// Bundled Noto fonts (scripts/fonts.mjs): used by the PDF engine and the editor.
const fontsDir = app.isPackaged ? path.join(process.resourcesPath, "fonts") : path.join(root, "core/fonts/noto");

let core = null;
let nextId = 1;
const pending = new Map();
let openVault = null; // replayed when the core restarts

function startCore() {
  // windowsHide: no console window on Windows. stderr is piped (a GUI-subsystem
  // core has no console to inherit) and forwarded to the shell's own log.
  const child = spawn(coreBin, [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, NOTEZ_PACKAGES: packagesDir, NOTEZ_FONTS: fontsDir },
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      "err" in msg ? p.reject(msg.err) : p.resolve(msg.ok);
    }
  });
  child.on("exit", (code) => {
    if (core !== child) return;
    core = null;
    for (const [id, p] of pending) if (p.child === child) (pending.delete(id), p.reject("NoteZ core stopped"));
    if (!quitting) {
      console.error(`notez-core exited (${code}), restarting`);
      startCore();
      if (openVault) call("open_vault", { path: openVault }).catch(() => {});
    }
  });
  core = child;
}

function call(cmd, args) {
  if (!core) startCore();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, child: core });
    core.stdin.write(JSON.stringify({ id, cmd, args: args ?? {} }) + "\n");
  });
}

/** `notez [vault] [note]`: paths given on the command line. */
function startupArgs() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-") && a !== ".");
  return args.map((a) => (path.isAbsolute(a) || !existsSync(a) ? a : path.resolve(a)));
}

// macOS hands files opened from Finder (or dropped on the Dock icon) to
// "open-file" instead of argv. Before the UI is up they join the startup
// are queued until the UI asks for them; afterwards they go to the window.
const openedFiles = [];
let uiReady = false;
app.on("open-file", (e, file) => {
  e.preventDefault();
  const win = BrowserWindow.getAllWindows()[0];
  if (win && uiReady) win.webContents.send("open-path", file);
  else openedFiles.push(file);
});

// ------------------------------------------------------------- IPC

// Errors cross the IPC boundary as plain values (string or diagnostics list),
// the same shapes the core returns.
const wrap = (fn) => async (_e, ...a) => {
  try {
    return { ok: await fn(...a) };
  } catch (err) {
    return { err: err instanceof Error ? err.message : err };
  }
};

ipcMain.handle("core", wrap(async (cmd, args) => {
  const r = await call(cmd, args);
  if (cmd === "open_vault") {
    openVault = args.path;
    watchVault(args.path);
  }
  return r;
}));
ipcMain.handle("startup-args", wrap(async () => startupArgs()));
// The bundled Noto fonts, so the editor shows every script like the PDF does.
ipcMain.handle("bundled-fonts", wrap(async () => {
  let files = [];
  try {
    files = readdirSync(fontsDir).filter((f) => /\.(ttf|otf)$/i.test(f));
  } catch {}
  return { dir: fontsDir, files };
}));
// UI themes and CSS snippets: <vault>/.notez/{themes,snippets}/*.css and the
// same folders in the app's config directory (src/core/uithemes.ts).
const configCssDir = (kind) => path.join(app.getPath("userData"), kind);
function readCss(dir, kind, source) {
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".css"))
      .map((f) => ({ name: f, kind: kind === "themes" ? "theme" : "snippet", source, path: path.join(dir, f), css: readFileSync(path.join(dir, f), "utf8") }));
  } catch {
    return [];
  }
}
ipcMain.handle("user-css", wrap(async (vault) => {
  const out = [];
  for (const kind of ["themes", "snippets"]) {
    out.push(...readCss(configCssDir(kind), kind, "global"));
    if (vault) out.push(...readCss(path.join(vault, ".notez", kind), kind, "vault"));
  }
  return out;
}));
ipcMain.handle("css-folder", wrap(async (kind, vault) => {
  const dir = vault ? path.join(vault, ".notez", kind) : configCssDir(kind);
  mkdirSync(dir, { recursive: true });
  return dir;
}));
// Global theme folders are outside the vault watcher: watch them separately.
function watchConfigCss() {
  for (const kind of ["themes", "snippets"]) {
    const dir = configCssDir(kind);
    try {
      mkdirSync(dir, { recursive: true });
      watch(dir, () => {
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send("vault-fs", [`.notez/${kind}/`]);
      });
    } catch (e) {
      console.error("cannot watch", dir, e);
    }
  }
}
ipcMain.handle("take-opened-files", wrap(async () => {
  uiReady = true;
  setTimeout(deliverCaptures, 0); // text captured while the window was starting
  return openedFiles.splice(0);
}));
ipcMain.handle("open-url", wrap(async (url) => {
  if (!/^(https?:|mailto:)/i.test(url)) throw "unsupported link";
  await shell.openExternal(url);
}));
ipcMain.handle("open-path", wrap(async (p) => {
  const err = await shell.openPath(p);
  if (err) throw err;
}));
ipcMain.handle("dialog-open", wrap(async (o = {}) => {
  const win = BrowserWindow.getFocusedWindow();
  const r = await dialog.showOpenDialog(win, {
    title: o.title,
    defaultPath: o.defaultPath,
    filters: o.filters,
    properties: [o.directory ? "openDirectory" : "openFile", ...(o.directory ? ["createDirectory"] : []), ...(o.multiple ? ["multiSelections"] : [])],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return o.multiple ? r.filePaths : r.filePaths[0];
}));
ipcMain.handle("dialog-save", wrap(async (o = {}) => {
  const r = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), { title: o.title, defaultPath: o.defaultPath, filters: o.filters });
  return r.canceled ? null : r.filePath;
}));
ipcMain.handle("trash", wrap(async (p) => {
  if (!openVault || !path.resolve(p).startsWith(path.resolve(openVault) + path.sep)) throw "outside the vault";
  await shell.trashItem(p);
}));
// Spell checking in the languages chosen in Settings (empty = the system
// language, plus English). macOS uses the system spell checker, which picks
// languages itself.
ipcMain.handle("spellcheck", wrap(async (on, langs) => {
  for (const w of BrowserWindow.getAllWindows()) {
    const s = w.webContents.session;
    s.setSpellCheckerEnabled(!!on);
    if (!on || process.platform === "darwin") continue;
    const available = s.availableSpellCheckerLanguages;
    const pick = (l) => available.find((a) => a.toLowerCase() === l.toLowerCase()) ?? available.find((a) => a.split("-")[0] === l.split("-")[0]);
    const wanted = Array.isArray(langs) && langs.length ? langs : [app.getLocale(), "en-US"];
    const chosen = [...new Set(wanted.map(pick).filter(Boolean))];
    if (chosen.length) s.setSpellCheckerLanguages(chosen);
  }
}));
ipcMain.handle("spellcheck-languages", wrap(async () => {
  const w = BrowserWindow.getAllWindows()[0];
  return process.platform === "darwin" ? [] : (w?.webContents.session.availableSpellCheckerLanguages ?? []);
}));
// Reveal a file in the system file manager (selected), like Obsidian.
ipcMain.handle("show-in-folder", wrap(async (p) => shell.showItemInFolder(p)));
ipcMain.handle("replace-misspelling", wrap(async (word) => BrowserWindow.getFocusedWindow()?.webContents.replaceMisspelling(word)));
ipcMain.handle("add-to-dictionary", wrap(async (word) => BrowserWindow.getFocusedWindow()?.webContents.session.addWordToSpellCheckerDictionary(word)));
ipcMain.handle("dialog-ask", wrap(async (message, o = {}) => {
  const r = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
    type: o.kind === "warning" ? "warning" : o.kind === "error" ? "error" : "question",
    title: o.title ?? "NoteZ",
    message,
    buttons: [o.okLabel ?? "Yes", o.cancelLabel ?? "No"],
    defaultId: 1,
    cancelId: 1,
  });
  return r.response === 0;
}));

// ------------------------------------------------------- vault watcher

// Changes made outside the app (another editor, git, sync) are batched,
// fed to the core's note index, then sent to the UI as "vault-fs".
let watcher = null;
let changed = new Set();
let flushTimer = null;

/** Hidden paths are ignored, except NoteZ's own styles and plugins. */
const watched = (rel) => !rel.split("/").some((s) => s.startsWith(".")) || /^\.notez\/(styles|plugins|themes|snippets)\//.test(rel);

function watchVault(dir) {
  watcher?.close();
  watcher = null;
  try {
    watcher = watch(dir, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const rel = name.toString().split(path.sep).join("/");
      if (!watched(rel)) return;
      changed.add(rel);
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flushChanges, 150);
    });
    watcher.on("error", (e) => console.error("vault watcher:", e));
  } catch (e) {
    console.error("cannot watch vault:", e);
  }
}

async function flushChanges() {
  const paths = [...changed];
  changed = new Set();
  const notes = paths.filter((p) => !p.startsWith("."));
  if (notes.length) await call("index_update", { paths: notes }).catch(() => {});
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("vault-fs", paths);
}

// ----------------------------------------------------------- window

let quitting = false;

// ------------------------------------------------------- quick capture

// A global shortcut opens a small window anywhere on the desktop; its text is
// handed to the main window, which adds it to the capture note.
let captureAccel = "";
let captureTarget = "";
let captureWin = null;
const pendingCaptures = [];

function openCapture() {
  if (captureWin && !captureWin.isDestroyed()) return captureWin.focus();
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = 560;
  const height = 150;
  captureWin = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height / 4),
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: "Quick capture",
    webPreferences: { preload: path.join(here, "capture-preload.cjs"), contextIsolation: true, sandbox: true, spellcheck: true },
  });
  captureWin.once("ready-to-show", () => (captureWin.show(), captureWin.focus()));
  captureWin.on("closed", () => (captureWin = null));
  captureWin.loadFile(path.join(here, "capture.html"));
}

function deliverCaptures() {
  const win = mainWindow();
  if (!win || !uiReady) return;
  while (pendingCaptures.length) win.webContents.send("capture", pendingCaptures.shift());
}

const mainWindow = () => BrowserWindow.getAllWindows().find((w) => w !== captureWin && !w.isDestroyed());

ipcMain.on("capture-submit", (_e, text) => {
  captureWin?.close();
  pendingCaptures.push(String(text));
  if (!mainWindow()) createWindow();
  deliverCaptures();
});
ipcMain.on("capture-cancel", () => captureWin?.close());
ipcMain.handle("capture-target", () => captureTarget);

// ------------------------------------------------------------- updates

ipcMain.handle("update-state", wrap(async () => updates.getState()));
ipcMain.handle("update-check", wrap(async () => updates.check()));
ipcMain.handle("update-download", wrap(async () => updates.download()));
ipcMain.handle("update-install", wrap(async () => updates.install(() => (quitting = true))));
// Secrets (sync passwords and passphrase), encrypted with the system keychain
// (Keychain, DPAPI, libsecret/KWallet) in <userData>/secrets.json.
const secretsFile = () => path.join(app.getPath("userData"), "secrets.json");
const readSecrets = () => {
  try {
    return JSON.parse(readFileSync(secretsFile(), "utf8"));
  } catch {
    return {};
  }
};
/** "keychain", "plain" (Linux without a keyring: weakly protected), or "none". */
const secretStore = () => {
  if (!safeStorage.isEncryptionAvailable()) return "none";
  const backend = process.platform === "linux" && safeStorage.getSelectedStorageBackend ? safeStorage.getSelectedStorageBackend() : "keychain";
  return backend === "basic_text" ? "plain" : "keychain";
};
ipcMain.handle("secret-store", wrap(async () => secretStore()));
ipcMain.handle("secret-get", wrap(async (key) => {
  const v = readSecrets()[key];
  if (!v || secretStore() === "none") return null;
  try {
    return safeStorage.decryptString(Buffer.from(v, "base64"));
  } catch {
    return null;
  }
}));
ipcMain.handle("secret-set", wrap(async (key, value) => {
  const all = readSecrets();
  if (value == null || value === "") delete all[key];
  else {
    if (secretStore() === "none") throw "no system keychain to keep the secret in";
    all[key] = safeStorage.encryptString(String(value)).toString("base64");
  }
  mkdirSync(path.dirname(secretsFile()), { recursive: true });
  const tmp = secretsFile() + ".tmp";
  writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
  renameSync(tmp, secretsFile());
}));
ipcMain.handle("capture-shortcut", wrap(async (accel, target) => {
  captureTarget = target ?? "";
  if (accel === captureAccel) return true;
  if (captureAccel) globalShortcut.unregister(captureAccel);
  captureAccel = "";
  if (!accel) return true;
  // false: another app owns the shortcut, or the syntax is invalid.
  let ok = false;
  try {
    ok = globalShortcut.register(accel, openCapture);
  } catch {
    ok = false;
  }
  if (ok) captureAccel = accel;
  return ok;
}));

function createWindow() {
  const win = new BrowserWindow({
    title: "NoteZ",
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: "#00000000",
    icon: path.join(root, "build/icon.png"),
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true, spellcheck: true, plugins: true },
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => (uiReady = false));
  win.webContents.session.setSpellCheckerEnabled(false); // the UI turns it on (Settings → Editor)
  // Right-clicks the page didn't handle itself (the editor leaves them
  // through on purpose): tell the UI, with spelling suggestions, so it can
  // show one menu (src/editor/contextmenu.ts).
  win.webContents.on("context-menu", (_e, p) => {
    win.webContents.send("context-menu", {
      word: p.misspelledWord || "",
      suggestions: p.misspelledWord ? p.dictionarySuggestions : [],
      x: p.x,
      y: p.y,
    });
  });
  // Links never navigate the app window; they open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(devUrl ?? "app://")) e.preventDefault();
  });
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.on("before-input-event", (_e, input) => {
      if (input.type === "keyDown" && input.key === "F12") win.webContents.toggleDevTools();
    });
  } else win.loadURL("app://notez/index.html");
}

app.whenReady().then(() => {
  // macOS needs an application menu for the standard shortcuts (copy, paste,
  // undo, quit, hide) to work; elsewhere the app draws its own UI.
  Menu.setApplicationMenu(process.platform === "darwin"
    ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
    : null);
  const dist = path.join(root, "dist");
  protocol.handle("app", (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "") || "index.html";
    const file = path.normalize(path.join(dist, rel));
    if (!file.startsWith(dist + path.sep)) return new Response("forbidden", { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  protocol.handle("notez-asset", async (req) => {
    let file = decodeURIComponent(new URL(req.url).pathname);
    if (process.platform === "win32") file = file.replace(/^\/([A-Za-z]:)/, "$1"); // /C:/x → C:/x
    // The UI (app:// or the dev server) reads these with fetch() too, e.g. a file's size.
    let res;
    try {
      res = await net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response("not found", { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  });
  startCore();
  createWindow();
  watchConfigCss();
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("before-quit", () => {
  quitting = true;
  core?.kill();
});
// macOS apps stay open without windows and reopen one from the Dock.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow();
});
