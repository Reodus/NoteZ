// Electron shell: one window running the Solid UI, plus the Rust core
// (vault, Typst rendering, PDF export) as a helper process spoken to over
// newline-delimited JSON (see core/src/main.rs).
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const devUrl = process.env.NOTEZ_DEV_URL; // set by `npm run dev`

// Files on disk (note images) are served as notez-asset://local/<abs path>;
// the built UI is served from app://notez/ (a real origin, so module scripts
// and localStorage behave as in a browser).
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "notez-asset", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// ------------------------------------------------------------ Rust core

const coreBin = app.isPackaged
  ? path.join(process.resourcesPath, "notez-core")
  : path.join(root, "core/bin/notez-core"); // npm run core
const packagesDir = app.isPackaged ? path.join(process.resourcesPath, "typst-packages") : path.join(root, "core/typst-packages");

let core = null;
let nextId = 1;
const pending = new Map();
let openVault = null; // replayed when the core restarts

function startCore() {
  const child = spawn(coreBin, [], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, NOTEZ_PACKAGES: packagesDir } });
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
// Spell checking (English + Persian when the dictionaries are available).
ipcMain.handle("spellcheck", wrap(async (on) => {
  for (const w of BrowserWindow.getAllWindows()) {
    const s = w.webContents.session;
    s.setSpellCheckerEnabled(!!on);
    if (on) s.setSpellCheckerLanguages(["en-US", "fa"].filter((l) => s.availableSpellCheckerLanguages.includes(l)));
  }
}));
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
const watched = (rel) => !rel.split("/").some((s) => s.startsWith(".")) || /^\.notez\/(styles|plugins)\//.test(rel);

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
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true, spellcheck: true },
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.session.setSpellCheckerEnabled(false); // the UI turns it on (Settings → Editor)
  // Right-click on a misspelled word: suggestions.
  win.webContents.on("context-menu", (_e, p) => {
    if (!p.misspelledWord) return;
    const items = p.dictionarySuggestions.slice(0, 6).map((s) => ({ label: s, click: () => win.webContents.replaceMisspelling(s) }));
    if (!items.length) items.push({ label: "No suggestions", enabled: false });
    items.push({ type: "separator" }, { label: "Add to dictionary", click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
    Menu.buildFromTemplate(items).popup({ window: win });
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
  Menu.setApplicationMenu(null);
  const dist = path.join(root, "dist");
  protocol.handle("app", (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "") || "index.html";
    const file = path.normalize(path.join(dist, rel));
    if (!file.startsWith(dist + path.sep)) return new Response("forbidden", { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  protocol.handle("notez-asset", (req) => {
    const file = decodeURIComponent(new URL(req.url).pathname);
    return net.fetch(pathToFileURL(file).toString());
  });
  startCore();
  createWindow();
});

app.on("before-quit", () => {
  quitting = true;
  core?.kill();
});
app.on("window-all-closed", () => app.quit());
