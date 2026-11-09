// Bridge for the quick capture window (electron/capture.html).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("notezCapture", {
  submit: (text) => ipcRenderer.send("capture-submit", text),
  cancel: () => ipcRenderer.send("capture-cancel"),
  /** Where the text will go, shown under the box. */
  target: () => ipcRenderer.invoke("capture-target"),
});
