// Interface language. UI strings are written in English in the code and
// wrapped in t("…"); each other language is a dictionary from that English
// text to its translation (src/locales/<code>.ts). A missing entry shows the
// English text, so a half-finished translation still works.
//
// The language is read once at startup (from the saved preferences, before
// any component runs), so t() is a plain lookup that also works in module-
// level constants. Changing it in Settings reloads the window.
//
// Adding a language: copy src/locales/fa.ts to src/locales/<code>.ts,
// translate the values, and add it to LOCALES and UI_LANGUAGES below.
import fa from "../locales/fa";
import { platformKeys } from "./keys";

export type UiLang = "en" | "fa";

const LOCALES: Record<Exclude<UiLang, "en">, Record<string, string>> = { fa };
const RTL: UiLang[] = ["fa"];

/** Choices for Settings → Languages → Interface language (names in their own language). */
export const UI_LANGUAGES: { value: string; label: string }[] = [
  { value: "auto", label: "Automatic (system language)" },
  { value: "en", label: "English" },
  { value: "fa", label: "فارسی (Persian)" },
];

/** The saved choice ("auto", "en", "fa"…). Same key as src/core/store.ts. */
function saved(): string {
  try {
    return JSON.parse(localStorage.getItem("notez.prefs.v1") ?? "{}").uiLanguage ?? "auto";
  } catch {
    return "auto";
  }
}

function resolve(choice: string): UiLang {
  if (choice === "en" || choice in LOCALES) return choice as UiLang;
  for (const l of navigator.languages ?? [navigator.language]) {
    const code = l.toLowerCase().split("-")[0];
    if (code in LOCALES) return code as UiLang;
  }
  return "en";
}

/** The language the UI is shown in (fixed until the next reload). */
export const uiLang: UiLang = resolve(saved());
export const uiRtl = RTL.includes(uiLang);
const dict: Record<string, string> = uiLang === "en" ? {} : LOCALES[uiLang];

const DIGITS: Partial<Record<UiLang, string>> = { fa: "۰۱۲۳۴۵۶۷۸۹" };

/** Numbers in the UI language's digits (Persian: ۱۲۳). */
export function num(n: number | string): string {
  const d = DIGITS[uiLang];
  return d ? String(n).replace(/[0-9]/g, (c) => d[+c]) : String(n);
}

/**
 * The UI text for `s` (English) in the interface language. `{name}`
 * placeholders are filled from `vars`; numbers use the language's digits.
 */
export function t(s: string, vars?: Record<string, unknown>): string {
  // Shortcut hints are written with Ctrl; a Mac shows Cmd.
  const out = platformKeys(dict[s] ?? s);
  if (!vars) return out;
  return out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? (typeof vars[k] === "number" ? num(vars[k] as number) : String(vars[k] ?? "")) : m));
}

/** Plural-aware: picks `one` or `other` (English rules; Persian uses one form). */
export function tn(n: number, one: string, other: string, vars?: Record<string, unknown>): string {
  return t(n === 1 ? one : other, { n, ...vars });
}

/** Set <html lang dir> for the interface (called once at startup). */
export function applyUiLanguage() {
  document.documentElement.lang = uiLang;
  document.documentElement.dir = uiRtl ? "rtl" : "ltr";
}

/**
 * Save a new interface language and reload the window to apply it. Open
 * notes are saved first; the preference is written straight to storage so
 * it is there when the page comes back.
 */
export async function setUiLanguage(choice: string) {
  const { prefs, setPrefs, saveAll } = await import("./store");
  if (prefs.uiLanguage === choice) return;
  setPrefs("uiLanguage", choice);
  try {
    localStorage.setItem("notez.prefs.v1", JSON.stringify(prefs));
  } catch {
    /* the store's own effect saves it too */
  }
  if (resolve(choice) === uiLang) return; // e.g. "auto" that resolves to what is shown already
  await saveAll();
  location.reload();
}
