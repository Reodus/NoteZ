// The only bridge between the UI and Node/Electron (see src/core/native.ts).
const { contextBridge, ipcRenderer, webUtils, webFrame } = require("electron");

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if ("err" in r) throw r.err;
  return r.ok;
};

contextBridge.exposeInMainWorld("notezNative", {
  core: (cmd, args) => call("core", cmd, args),
  startupArgs: () => call("startup-args"),
  takeOpenedFiles: () => call("take-opened-files"),
  setCaptureShortcut: (accel, target) => call("capture-shortcut", accel, target),
  onCapture: (cb) => {
    const h = (_e, text) => cb(text);
    ipcRenderer.on("capture", h);
    return () => ipcRenderer.removeListener("capture", h);
  },
  bundledFonts: () => call("bundled-fonts"),
  userCss: (vault) => call("user-css", vault),
  cssFolder: (kind, vault) => call("css-folder", kind, vault),
  onOpenPath: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("open-path", h);
    return () => ipcRenderer.removeListener("open-path", h);
  },
  openUrl: (url) => call("open-url", url),
  openPath: (p) => call("open-path", p),
  showInFolder: (p) => call("show-in-folder", p),
  dialogOpen: (o) => call("dialog-open", o),
  dialogSave: (o) => call("dialog-save", o),
  ask: (message, o) => call("dialog-ask", message, o),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  trash: (p) => call("trash", p),
  secretStore: () => call("secret-store"),
  secretGet: (key) => call("secret-get", key),
  secretSet: (key, value) => call("secret-set", key, value),
  setZoom: (f) => webFrame.setZoomFactor(f),
  setSpellcheck: (on, langs) => call("spellcheck", on, langs),
  spellcheckLanguages: () => call("spellcheck-languages"),
  replaceMisspelling: (w) => call("replace-misspelling", w),
  addToDictionary: (w) => call("add-to-dictionary", w),
  onContextMenu: (cb) => {
    const h = (_e, info) => cb(info);
    ipcRenderer.on("context-menu", h);
    return () => ipcRenderer.removeListener("context-menu", h);
  },
  updateState: () => call("update-state"),
  updateCheck: () => call("update-check"),
  updateDownload: () => call("update-download"),
  updateInstall: () => call("update-install"),
  onUpdateState: (cb) => {
    const h = (_e, st) => cb(st);
    ipcRenderer.on("update-state", h);
    return () => ipcRenderer.removeListener("update-state", h);
  },
  onVaultFs: (cb) => {
    const h = (_e, paths) => cb(paths);
    ipcRenderer.on("vault-fs", h);
    return () => ipcRenderer.removeListener("vault-fs", h);
  },
});
