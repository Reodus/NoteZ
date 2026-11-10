// Shortcut labels. Commands use CodeMirror-style keys ("Mod-Shift-p"); Mod
// runs on Ctrl or Cmd, and is shown as the platform's own key.

export const isMac = typeof navigator !== "undefined" && /^Mac/i.test(navigator.platform);

/** The name of the main modifier on this platform. */
export const modName = isMac ? "Cmd" : "Ctrl";

/** "Mod-Shift-p" → "Ctrl + Shift + P" (or "Cmd + Shift + P" on a Mac). */
export function fmtKey(k?: string, sep = " + "): string | undefined {
  if (!k) return k;
  // "Mod--" is Ctrl and the minus key.
  const cut = k.endsWith("--") ? k.length - 2 : k.lastIndexOf("-");
  const last = k.endsWith("--") ? "-" : k.slice(cut + 1);
  const parts = cut > 0 ? k.slice(0, cut).split("-") : [];
  const mods = parts.map((p) => (p === "Mod" || (isMac && p === "Ctrl") ? modName : p));
  return [...mods, last.length === 1 ? last.toUpperCase() : last].join(sep);
}

/** Replace "Ctrl+" in a ready-made label with the platform's modifier. */
export function platformKeys(s: string): string {
  return isMac ? s.replace(/\bCtrl(\s*\+)/g, "Cmd$1") : s;
}
