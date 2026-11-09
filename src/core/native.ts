// Everything the UI needs from the desktop shell (electron/preload.cjs):
// Rust core calls, dialogs, opening links/files, and URLs for local files.

interface DialogFilter {
  name: string;
  extensions: string[];
}

export interface UserCssFile {
  name: string;
  kind: "theme" | "snippet";
  source: "vault" | "global";
  path: string;
  css: string;
}

interface Native {
  core<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  startupArgs(): Promise<string[]>;
  /** Files the OS asked to open before the UI was ready (macOS Finder/Dock). */
  takeOpenedFiles?(): Promise<string[]>;
  setCaptureShortcut?(accel: string, target: string): Promise<boolean>;
  onCapture?(cb: (text: string) => void): () => void;
  /** UI themes and snippets from the vault and the config folder. */
  userCss?(vault: string | null): Promise<UserCssFile[]>;
  /** Create (if needed) and return a themes/snippets folder (vault = null: the config folder). */
  cssFolder?(kind: "themes" | "snippets", vault: string | null): Promise<string>;
  /** The bundled Noto font files (scripts/fonts.mjs). */
  bundledFonts?(): Promise<{ dir: string; files: string[] }>;
  /** Files the OS asks to open while the app runs (macOS). */
  onOpenPath?(cb: (path: string) => void): () => void;
  openUrl(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  showInFolder?(path: string): Promise<void>;
  dialogOpen(o: { title?: string; directory?: boolean; multiple?: boolean; defaultPath?: string; filters?: DialogFilter[] }): Promise<string | string[] | null>;
  dialogSave(o: { title?: string; defaultPath?: string; filters?: DialogFilter[] }): Promise<string | null>;
  ask(message: string, o?: { title?: string; kind?: "info" | "warning" | "error"; okLabel?: string; cancelLabel?: string }): Promise<boolean>;
  onVaultFs(cb: (paths: string[]) => void): () => void;
  pathForFile(file: File): string | null;
  trash(path: string): Promise<void>;
  secretStore?(): Promise<"keychain" | "plain" | "none">;
  secretGet?(key: string): Promise<string | null>;
  secretSet?(key: string, value: string | null): Promise<void>;
  setZoom(factor: number): void;
  setSpellcheck(on: boolean, langs?: string[]): Promise<void>;
  /** Dictionaries the spell checker can use (empty on macOS: the system decides). */
  spellcheckLanguages?(): Promise<string[]>;
  replaceMisspelling?(word: string): Promise<void>;
  addToDictionary?(word: string): Promise<void>;
  onContextMenu?(cb: (info: { word: string; suggestions: string[]; x: number; y: number }) => void): () => void;
}

const native: Native = (window as unknown as { notezNative: Native }).notezNative;

/** Call a Rust core command (core/src/lib.rs `dispatch`). */
export const invoke = <T>(cmd: string, args?: Record<string, unknown>) => native.core<T>(cmd, args);
export const startupArgs = () => native.startupArgs();
export const userCss = (vault: string | null) => native.userCss?.(vault) ?? Promise.resolve([] as UserCssFile[]);
export const cssFolder = (kind: "themes" | "snippets", vault: string | null) => native.cssFolder?.(kind, vault) ?? Promise.reject("not available");
export const bundledFonts = () => native.bundledFonts?.() ?? Promise.resolve({ dir: "", files: [] as string[] });
export const takeOpenedFiles = () => native.takeOpenedFiles?.() ?? Promise.resolve([] as string[]);
/** Register (or clear, with "") the global quick-capture shortcut; false if it is taken. */
export const setCaptureShortcut = (accel: string, target: string) => native.setCaptureShortcut?.(accel, target) ?? Promise.resolve(true);
export const onCapture = (cb: (text: string) => void) => native.onCapture?.(cb) ?? (() => {});
export const onOpenPath = (cb: (path: string) => void) => native.onOpenPath?.(cb) ?? (() => {});
export const openUrl = (url: string) => native.openUrl(url);
export const openPath = (path: string) => native.openPath(path);
/** Open the system file manager with `path` selected. */
export const showInFolder = (path: string) => (native.showInFolder ? native.showInFolder(path) : native.openPath(path.slice(0, path.lastIndexOf("/")) || "/"));
export const openDialog = (o: Parameters<Native["dialogOpen"]>[0]) => native.dialogOpen(o);
export const saveDialog = (o: Parameters<Native["dialogSave"]>[0]) => native.dialogSave(o);
export const ask = (message: string, o?: Parameters<Native["ask"]>[1]) => native.ask(message, o);
/** Move an absolute path to the system trash. */
export const trashPath = (p: string) => native.trash(p);
export const setZoom = (f: number) => native.setZoom(f);
/** Where secrets are kept: the system keychain, weakly ("plain"), or nowhere. */
export const secretStore = () => native.secretStore?.() ?? Promise.resolve("none" as const);
export const secretGet = (key: string) => native.secretGet?.(key) ?? Promise.resolve(null);
export const secretSet = (key: string, value: string | null) => native.secretSet?.(key, value) ?? Promise.reject("not available");
export const setSpellcheck = (on: boolean, langs: string[] = []) => native.setSpellcheck(on, langs);
export const spellcheckLanguages = () => native.spellcheckLanguages?.() ?? Promise.resolve([] as string[]);
export const replaceMisspelling = (w: string) => void native.replaceMisspelling?.(w);
export const addToDictionary = (w: string) => void native.addToDictionary?.(w);
/** Right-clicks the page didn't prevent, with the misspelled word (if any). */
export const onSpellMenu = (cb: (info: { word: string; suggestions: string[]; x: number; y: number }) => void) =>
  native?.onContextMenu?.(cb) ?? (() => {});
/** Absolute path of a dropped/pasted File, or null (e.g. a clipboard image). */
export const pathForFile = (file: File) => native.pathForFile(file);
/** Files changed on disk (vault-relative paths), batched. */
export const onVaultFs = (cb: (paths: string[]) => void) => native.onVaultFs(cb);

/** URL the page can load for a file on disk (images in notes). */
export function fileSrc(absPath: string): string {
  // Windows paths (C:\x\y.png) become /C:/x/y.png; the shell strips the leading slash again.
  const p = absPath.replace(/\\/g, "/");
  return "notez-asset://local" + (p.startsWith("/") ? "" : "/") + p.split("/").map(encodeURIComponent).join("/");
}
