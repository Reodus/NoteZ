// Languages NoteZ knows how to typeset: ISO 639 codes for the `lang:`
// frontmatter key, the language pickers and spell checking. Names come from
// the browser (Intl.DisplayNames), in English and in the language itself.

/** Common document languages; any other ISO 639 code also works in `lang:`. */
export const LANGUAGE_CODES = [
  "en", "ar", "fa", "ur", "ps", "ckb", "ku", "dv", "syr",
  "zh", "zh-TW", "ja", "ko",
  "hi", "mr", "ne", "bn", "pa", "gu", "or", "ta", "te", "kn", "ml", "si",
  "th", "lo", "km", "my", "bo",
  "ru", "uk", "be", "bg", "sr", "mk", "kk", "mn",
  "el", "hy", "ka", "am", "ti",
  "de", "fr", "es", "pt", "pt-BR", "it", "nl", "sv", "da", "nb", "fi", "is", "pl", "cs", "sk", "sl", "hr", "bs",
  "ro", "hu", "et", "lv", "lt", "sq", "ga", "cy", "eu", "ca", "gl", "mt",
  "tr", "az", "uz", "tk", "ky", "tt", "id", "ms", "tl", "vi", "sw", "ha", "yo", "ig", "zu", "xh", "af", "eo", "la",
];

let english: Intl.DisplayNames | null = null;
const name = (code: string, locale?: string) => {
  try {
    if (!locale) return (english ??= new Intl.DisplayNames(["en"], { type: "language" })).of(code) ?? code;
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** "Persian — فارسی (fa)" */
export function languageLabel(code: string): string {
  const en = name(code);
  const own = name(code, code);
  return own && own !== en ? `${en} — ${own} (${code})` : `${en} (${code})`;
}

export interface LanguageOption {
  value: string;
  label: string;
}

/** Options for a language picker, sorted by English name; `auto` first. */
export function languageOptions(autoLabel = "Automatic (detect from the text)"): LanguageOption[] {
  const opts = LANGUAGE_CODES.map((c) => ({ value: c, label: languageLabel(c) })).sort((a, b) => a.label.localeCompare(b.label));
  return [{ value: "", label: autoLabel }, ...opts];
}

/** Digit systems for page and heading numbers (core/src/render/script.rs). */
export const DIGIT_OPTIONS: LanguageOption[] = [
  { value: "", label: "As written in each numbering pattern" },
  { value: "auto", label: "Automatic — the document language's own digits" },
  { value: "latin", label: "Latin — 1 2 3" },
  { value: "arabic-indic", label: "Arabic-Indic — ١ ٢ ٣" },
  { value: "persian", label: "Persian / Urdu — ۱ ۲ ۳" },
  { value: "devanagari", label: "Devanagari — १ २ ३" },
  { value: "bengali", label: "Bengali — ১ ২ ৩" },
  { value: "gurmukhi", label: "Gurmukhi — ੧ ੨ ੩" },
  { value: "gujarati", label: "Gujarati — ૧ ૨ ૩" },
  { value: "oriya", label: "Odia — ୧ ୨ ୩" },
  { value: "tamil", label: "Tamil — ௧ ௨ ௩" },
  { value: "telugu", label: "Telugu — ౧ ౨ ౩" },
  { value: "kannada", label: "Kannada — ೧ ೨ ೩" },
  { value: "malayalam", label: "Malayalam — ൧ ൨ ൩" },
  { value: "thai", label: "Thai — ๑ ๒ ๓" },
  { value: "lao", label: "Lao — ໑ ໒ ໓" },
  { value: "khmer", label: "Khmer — ១ ២ ៣" },
  { value: "myanmar", label: "Myanmar — ၁ ၂ ၃" },
  { value: "tibetan", label: "Tibetan — ༡ ༢ ༣" },
  { value: "mongolian", label: "Mongolian — ᠑ ᠒ ᠓" },
  { value: "nko", label: "NKo — ߁ ߂ ߃" },
  { value: "fullwidth", label: "Full-width — １ ２ ３" },
];

/** Per-script font keys of a theme style (`fonts:`), with labels and a sample. */
/** `font` = the bundled font a new row starts with. */
export const SCRIPT_FONT_KEYS: { key: string; label: string; sample: string; font: string }[] = [
  { key: "latin", label: "Latin", sample: "Abc", font: "Noto Serif" },
  { key: "greek", label: "Greek", sample: "Αβγ", font: "Noto Serif" },
  { key: "cyrillic", label: "Cyrillic", sample: "Абв", font: "Noto Serif" },
  { key: "arabic", label: "Arabic script (Arabic, Persian, Urdu…)", sample: "ابج", font: "Vazirmatn" },
  { key: "syriac", label: "Syriac", sample: "ܐܒܓ", font: "Noto Sans Syriac" },
  { key: "thaana", label: "Thaana", sample: "ހށނ", font: "Noto Sans Thaana" },
  { key: "devanagari", label: "Devanagari", sample: "कखग", font: "Noto Serif Devanagari" },
  { key: "bengali", label: "Bengali", sample: "কখগ", font: "Noto Sans Bengali" },
  { key: "gurmukhi", label: "Gurmukhi", sample: "ਕਖਗ", font: "Noto Sans Gurmukhi" },
  { key: "gujarati", label: "Gujarati", sample: "કખગ", font: "Noto Sans Gujarati" },
  { key: "oriya", label: "Odia", sample: "କଖଗ", font: "Noto Sans Oriya" },
  { key: "tamil", label: "Tamil", sample: "கஙச", font: "Noto Sans Tamil" },
  { key: "telugu", label: "Telugu", sample: "కఖగ", font: "Noto Sans Telugu" },
  { key: "kannada", label: "Kannada", sample: "ಕಖಗ", font: "Noto Sans Kannada" },
  { key: "malayalam", label: "Malayalam", sample: "കഖഗ", font: "Noto Sans Malayalam" },
  { key: "sinhala", label: "Sinhala", sample: "කඛග", font: "Noto Sans Sinhala" },
  { key: "thai", label: "Thai", sample: "กขค", font: "Noto Serif Thai" },
  { key: "lao", label: "Lao", sample: "ກຂຄ", font: "Noto Sans Lao" },
  { key: "tibetan", label: "Tibetan", sample: "ཀཁག", font: "Noto Serif Tibetan" },
  { key: "myanmar", label: "Myanmar", sample: "ကခဂ", font: "Noto Sans Myanmar" },
  { key: "khmer", label: "Khmer", sample: "កខគ", font: "Noto Sans Khmer" },
  { key: "armenian", label: "Armenian", sample: "Աբգ", font: "Noto Sans Armenian" },
  { key: "georgian", label: "Georgian", sample: "აბგ", font: "Noto Sans Georgian" },
  { key: "ethiopic", label: "Ethiopic", sample: "ሀለሐ", font: "Noto Sans Ethiopic" },
  { key: "cjk", label: "Chinese, Japanese, Korean", sample: "漢字かな한글", font: "Noto Sans SC" },
];
