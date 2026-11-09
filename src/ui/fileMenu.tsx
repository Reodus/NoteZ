// The file / folder menu (file tree, tabs), modelled on Obsidian's: open,
// open in the default app, show in the system file manager, make a copy,
// move to…, copy path / link, embed in the current note, export, rename,
// delete.
import {
  FilePlus, FileCode2, FolderPlus, Pencil, Trash2, Copy, CopyPlus, FolderInput, FolderOpen, ExternalLink,
  FileDown, Link2, PanelLeftOpen, ListTree, ChevronsDownUp, ChevronsUpDown, Eye, Files, Bookmark as BookmarkIcon, History, Table2,
} from "lucide-solid";
import { basename, dirname, Entry, fileKind, ipc, isNotePath, stem } from "../core/ipc";
import {
  createFolder, createNote, deleteEntry, editorView, moveEntry, openNote, pick, prefs, refreshTree, renameEntry,
  root, setDialog, setPrefs, setSidebarOpen, setSidebarTab, state, tree, notesList,
} from "../core/store";
import { openPath, showInFolder } from "../core/native";
import { app, notify } from "../core/app";
import { exportPdf } from "../core/render";
import { askText, MenuItem } from "./primitives";
import { newBaseText } from "../core/bases";
import { insertText } from "../editor/format";
import { isBookmarked, toggleBookmark } from "../core/bookmarks";
import { collapseAll, expandAll, revealInTree } from "./Sidebar";

type Item = MenuItem | "-";

const abs = (p: string) => `${root()}/${p}`.replace(/\/$/, "");

export function newNoteIn(dir: string, ext: "md" | "typ" = prefs.defaultNoteType) {
  askText(ext === "md" ? "New note" : "New Typst note", "Untitled").then((name) => void (name && createNote(dir, name.replace(/\.(md|typ)$/, ""), ext)));
}

/** A new database (.base) listing the notes of `dir`. */
export function newBaseIn(dir: string) {
  askText("New database", "Untitled").then(async (name) => {
    if (!name) return;
    const base = name.trim().replace(/\.base$/i, "").replace(/[\\/:*?"<>|]/g, "-");
    let path = dir ? `${dir}/${base}.base` : `${base}.base`;
    for (let n = 1; (await ipc.read(path).then(() => true).catch(() => false)); n++) path = dir ? `${dir}/${base} ${n}.base` : `${base} ${n}.base`;
    try {
      await ipc.write(path, newBaseText(dir));
      await refreshTree();
      await openNote(path);
    } catch (e) {
      notify(String(e), "error");
    }
  });
}

export function newFolderIn(dir: string) {
  askText("New folder", "New folder").then((name) => void (name && createFolder(dir, name)));
}

/** All folders of the vault ("" = root), for "Move to…". */
function allFolders(entries: Entry[] = tree(), out: string[] = [""]): string[] {
  for (const e of entries) {
    if (!e.is_dir) continue;
    out.push(e.path);
    allFolders(e.children, out);
  }
  return out;
}

function moveTo(path: string, isDir: boolean) {
  const here = dirname(path);
  const folders = allFolders().filter((f) => f !== here && f !== path && !(isDir && f.startsWith(path + "/")));
  pick(
    `Move “${basename(path)}” to…`,
    folders.map((f) => ({ label: f || "/ (vault root)", detail: f ? dirname(f) : "", run: () => void moveEntry(path, f) })),
  );
}

async function duplicate(path: string) {
  try {
    const to = await ipc.duplicate(path);
    await refreshTree();
    if (fileKind(to) !== "other" && !to.includes("/" + basename(path) + "/")) void openNote(to);
  } catch (e) {
    notify(String(e), "error");
  }
}

/** `[[Note]]` / `![[image.png]]`: by name when unique, else by vault path. */
export function linkTo(path: string): string {
  const note = isNotePath(path);
  const name = note ? stem(path) : basename(path);
  const clash = note ? notesList().filter((p) => stem(p) === name).length > 1 : false;
  const target = clash ? path.replace(/\.md$/, "") : name;
  return `${note ? "" : "!"}[[${target}]]`;
}

function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text);
  notify(`Copied ${what}`, "success");
}

/** Menu for a file tree entry (null = the empty area / vault root). */
export function fileMenu(entry: Entry | null, from: "tree" | "tab" = "tree"): Item[] {
  if (!entry) {
    return [
      { label: "New note", icon: <FilePlus size={15} />, run: () => newNoteIn("") },
      { label: "New Typst note", icon: <FileCode2 size={15} />, run: () => newNoteIn("", "typ") },
      { label: "New database", icon: <Table2 size={15} />, run: () => newBaseIn("") },
      { label: "New folder", icon: <FolderPlus size={15} />, run: () => newFolderIn("") },
      "-",
      { label: "Collapse all folders", icon: <ChevronsDownUp size={15} />, run: collapseAll },
      { label: "Expand all folders", icon: <ChevronsUpDown size={15} />, run: expandAll },
      {
        label: "Show images & PDFs",
        icon: <Eye size={15} />,
        hint: prefs.showAttachments ? "✓" : "",
        run: () => setPrefs("showAttachments", !prefs.showAttachments),
      },
      {
        label: "Show all file types",
        icon: <Files size={15} />,
        hint: prefs.showAllFiles ? "✓" : "",
        run: () => setPrefs("showAllFiles", !prefs.showAllFiles),
      },
      "-",
      { label: "Show vault in system file manager", icon: <FolderOpen size={15} />, run: () => void openPath(abs("")) },
    ];
  }
  const p = entry.path;
  const kind = entry.is_dir ? "dir" : fileKind(p);
  const items: Item[] = [];

  if (entry.is_dir) {
    items.push(
      { label: "New note", icon: <FilePlus size={15} />, run: () => newNoteIn(p) },
      { label: "New Typst note", icon: <FileCode2 size={15} />, run: () => newNoteIn(p, "typ") },
      { label: "New database", icon: <Table2 size={15} />, run: () => newBaseIn(p) },
      { label: "New folder", icon: <FolderPlus size={15} />, run: () => newFolderIn(p) },
      "-",
    );
  } else {
    if (from === "tree") items.push({ label: "Open in new tab", icon: <PanelLeftOpen size={15} />, run: () => void openNote(p) });
    if (from === "tab") {
      items.push({
        label: "Reveal in file tree",
        icon: <ListTree size={15} />,
        run: () => (setSidebarOpen(true), setSidebarTab("files"), revealInTree(p)),
      });
    }
    items.push({ label: "Open in default app", icon: <ExternalLink size={15} />, run: () => void openPath(abs(p)).catch((e) => notify(String(e), "error")) });
  }
  items.push({ label: "Show in system file manager", icon: <FolderOpen size={15} />, run: () => void showInFolder(abs(p)) });
  {
    const b = { type: entry.is_dir ? "folder" : "file", path: p } as const;
    items.push({
      label: isBookmarked(b) ? "Remove bookmark" : "Bookmark",
      icon: <BookmarkIcon size={15} />,
      run: () => toggleBookmark(b),
    });
  }
  items.push("-");

  if (!entry.is_dir) {
    const active = state.active;
    const view = editorView();
    if (active && active !== p && isNotePath(active) && view && !active.endsWith(".typ")) {
      items.push({
        label: kind === "note" ? "Insert link in current note" : "Embed in current note",
        icon: <Link2 size={15} />,
        run: () => insertText(view, linkTo(p)),
      });
    }
    items.push({ label: kind === "note" ? "Copy link" : "Copy embed link", icon: <Link2 size={15} />, run: () => copy(linkTo(p), linkTo(p)) });
  }
  items.push({
    label: "Copy path",
    icon: <Copy size={15} />,
    run: () => {},
    items: [
      { label: "Vault path", hint: p.length > 28 ? "" : p, run: () => copy(p, "vault path") },
      { label: "Absolute path", run: () => copy(abs(p), "absolute path") },
      { label: "File name", run: () => copy(basename(p), "file name") },
    ],
  });
  items.push("-");

  items.push({ label: "Make a copy", icon: <CopyPlus size={15} />, run: () => void duplicate(p) });
  items.push({ label: entry.is_dir ? "Move folder to…" : "Move file to…", icon: <FolderInput size={15} />, run: () => moveTo(p, entry.is_dir) });
  if (kind === "note") items.push({ label: "Export to PDF…", icon: <FileDown size={15} />, run: () => void exportPdf(p) });
  if (!entry.is_dir && /\.(md|typ|base|canvas)$/i.test(p))
    items.push({ label: "File history…", icon: <History size={15} />, run: () => setDialog({ kind: "history", tab: "note", path: p }) });
  items.push(
    "-",
    {
      label: "Rename…",
      icon: <Pencil size={15} />,
      hint: p === state.active ? "F2" : "",
      run: () => askText("Rename", entry.name).then((n) => void (n && renameEntry(p, n))),
    },
    { label: "Delete", icon: <Trash2 size={15} />, danger: true, run: () => void deleteEntry(p) },
  );
  return items;
}

/** A tab's path as a tree entry (for the tab menu). */
export const entryFor = (path: string): Entry => ({ name: basename(path), path, is_dir: false, children: [] });

function renameActive() {
  const p = state.active;
  if (!p) return;
  askText("Rename", basename(p)).then((n) => void (n && renameEntry(p, n)));
}

app.commands.register({ id: "file.rename", title: "Rename current file", key: "F2", run: renameActive });
app.commands.register({
  id: "file.reveal",
  title: "Reveal current file in file tree",
  run: () => state.active && (setSidebarOpen(true), setSidebarTab("files"), revealInTree(state.active)),
});
app.commands.register({ id: "file.show-in-folder", title: "Show current file in system file manager", run: () => state.active && void showInFolder(abs(state.active)) });
app.commands.register({ id: "file.duplicate", title: "Make a copy of current file", run: () => state.active && void duplicate(state.active) });
app.commands.register({ id: "file.move", title: "Move current file to…", run: () => state.active && moveTo(state.active, false) });
