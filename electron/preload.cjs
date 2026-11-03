// The only bridge between the UI and Node/Electron (see src/core/native.ts).
const { contextBridge, ipcRenderer } = require("electron");

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if ("err" in r) throw r.err;
  return r.ok;
};

contextBridge.exposeInMainWorld("notezNative", {
  core: (cmd, args) => call("core", cmd, args),
  startupArgs: () => call("startup-args"),
  openUrl: (url) => call("open-url", url),
  openPath: (p) => call("open-path", p),
  dialogOpen: (o) => call("dialog-open", o),
  dialogSave: (o) => call("dialog-save", o),
  ask: (message, o) => call("dialog-ask", message, o),
});
