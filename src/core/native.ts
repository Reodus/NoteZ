// Everything the UI needs from the desktop shell (electron/preload.cjs):
// Rust core calls, dialogs, opening links/files, and URLs for local files.

interface DialogFilter {
  name: string;
  extensions: string[];
}

interface Native {
  core<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  startupArgs(): Promise<string[]>;
  openUrl(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  dialogOpen(o: { title?: string; directory?: boolean; multiple?: boolean; defaultPath?: string; filters?: DialogFilter[] }): Promise<string | string[] | null>;
  dialogSave(o: { title?: string; defaultPath?: string; filters?: DialogFilter[] }): Promise<string | null>;
  ask(message: string, o?: { title?: string; kind?: "info" | "warning" | "error"; okLabel?: string; cancelLabel?: string }): Promise<boolean>;
}

const native: Native = (window as unknown as { notezNative: Native }).notezNative;

/** Call a Rust core command (core/src/lib.rs `dispatch`). */
export const invoke = <T>(cmd: string, args?: Record<string, unknown>) => native.core<T>(cmd, args);
export const startupArgs = () => native.startupArgs();
export const openUrl = (url: string) => native.openUrl(url);
export const openPath = (path: string) => native.openPath(path);
export const openDialog = (o: Parameters<Native["dialogOpen"]>[0]) => native.dialogOpen(o);
export const saveDialog = (o: Parameters<Native["dialogSave"]>[0]) => native.dialogSave(o);
export const ask = (message: string, o?: Parameters<Native["ask"]>[1]) => native.ask(message, o);

/** URL the page can load for a file on disk (images in notes). */
export function fileSrc(absPath: string): string {
  return "notez-asset://local" + absPath.split("/").map(encodeURIComponent).join("/");
}
