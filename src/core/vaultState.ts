// Reactive data shared by the vault, editor, and workspace.
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type { EditorView } from "@codemirror/view";
import { frontmatterRange } from "./frontmatter";
import { ipc, isNotePath, type Entry, type Theme } from "./ipc";

export const [root, setRoot] = createSignal<string | null>(null);
export const [tree, setTree] = createSignal<Entry[]>([]);
export const [notesList, setNotesList] = createSignal<string[]>([]);

/** Every file in the vault tree (notes, PDFs, images…). */
export function allFiles(): string[] {
  const out: string[] = [];
  const walk = (es: Entry[]) => es.forEach((e) => (e.is_dir ? walk(e.children) : out.push(e.path)));
  walk(tree());
  return out;
}

/** A PDF link to follow: the PDF view scrolls to the page / annotation. `n` makes repeats distinct. */
export const [pdfJump, setPdfJump] = createSignal<{ path: string; page?: number; annotation?: string; n: number } | null>(null);

export interface Buffer {
  content: string;
  saved: string;
}

interface State {
  tabs: string[];
  active: string | null;
  buffers: Record<string, Buffer>;
}

export const [state, setState] = createStore<State>({ tabs: [], active: null, buffers: {} });

/** The CodeMirror view of the active note (set by the editor). */
export const [editorView, setEditorView] = createSignal<EditorView | null>(null);
/** Effective theme of the active note (for WYSIWYM styling + styles panel). */
export const [activeTheme, setActiveTheme] = createSignal<Theme | null>(null);

export function activeThemeKey() {
  const path = state.active;
  if (!path || !isNotePath(path)) return "";
  const text = state.buffers[path]?.content ?? "";
  const meta = path.endsWith(".typ") ? text.split("\n", 1)[0] : text.slice(0, frontmatterRange(text)?.to ?? 0);
  return `${root()}\u0000${path}\u0000${meta}`;
}

let themeRequest = 0;
export async function refreshActiveTheme() {
  const path = state.active;
  const key = activeThemeKey();
  const request = ++themeRequest;
  if (!path || !key) return setActiveTheme(null);
  const theme = await ipc.noteTheme(path, state.buffers[path]?.content ?? "").catch(() => null);
  if (request === themeRequest && key === activeThemeKey()) setActiveTheme(theme);
}
/** Cursor info for the status bar. */
export const [cursor, setCursor] = createSignal({ line: 1, col: 1, selected: 0 });

export const activeBuffer = () => (state.active ? state.buffers[state.active] : undefined);
export const isDirty = (path: string) => {
  const b = state.buffers[path];
  return !!b && b.content !== b.saved;
};

/** Bumped when files change on disk, so image/PDF tabs reload. */
export const [fileRev, setFileRev] = createSignal(0);
