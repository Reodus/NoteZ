// Paste or drop files into a note: images (from disk or the clipboard, e.g.
// a screenshot) are copied into the vault's attachment folder and linked.
import { EditorView } from "@codemirror/view";
import { pathForFile } from "../core/native";
import { ipc } from "../core/ipc";
import { notify } from "../core/app";
import { prefs, state } from "../core/store";
import { formatDate } from "../plugins/templates";

const IMAGE = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;

/** Vault folder for new attachments of `note` (prefs.attachmentFolder; "./x" = next to the note). */
export function attachmentDir(note: string | null): string {
  const pref = (prefs.attachmentFolder ?? "attachments").trim().replace(/\/+$/, "");
  if (!pref.startsWith(".")) return pref.replace(/^\/+/, "");
  const dir = note && note.includes("/") ? note.slice(0, note.lastIndexOf("/")) : "";
  const sub = pref.replace(/^\.\/?/, "");
  return [dir, sub].filter(Boolean).join("/");
}

function linkFor(path: string, typst: boolean): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (typst) return IMAGE.test(path) ? `#image("/${path}")` : `#link("/${path}")[${name}]`;
  const url = encodeURI(path);
  return IMAGE.test(path) ? `![](${url})` : `[${name}](${url})`;
}

const stamp = () => formatDate(new Date(), "YYYYMMDDHHmmss");

async function bytesB64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Store `files` in the vault and insert links at `pos`. */
async function insertFiles(view: EditorView, files: File[], pos: number) {
  const note = state.active;
  const dir = attachmentDir(note);
  const links: string[] = [];
  for (const f of files) {
    try {
      const src = pathForFile(f);
      const saved = src
        ? await ipc.importAttachment(src, dir)
        : await ipc.saveAttachment(f.name && f.name !== "image.png" ? f.name : `Pasted image ${stamp()}.${(f.type.split("/")[1] ?? "png").replace("jpeg", "jpg").replace("svg+xml", "svg")}`, await bytesB64(f), dir);
      links.push(linkFor(saved, !!note?.endsWith(".typ")));
    } catch (e) {
      notify(`Could not add ${f.name || "file"}: ${e}`, "error");
    }
  }
  if (!links.length) return;
  const insert = links.join("\n");
  pos = Math.min(pos, view.state.doc.length);
  view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length }, scrollIntoView: true });
  view.focus();
}

export const attachmentDrop = EditorView.domEventHandlers({
  paste(e, view) {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return false;
    e.preventDefault();
    const { from, to } = view.state.selection.main;
    if (to > from) view.dispatch({ changes: { from, to } });
    void insertFiles(view, files, from);
    return true;
  },
  drop(e, view) {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return false;
    e.preventDefault();
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
    void insertFiles(view, files, pos);
    return true;
  },
});
