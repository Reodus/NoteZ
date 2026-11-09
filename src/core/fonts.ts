import { createSignal } from "solid-js";
import { ipc } from "./ipc";
import { bundledFonts, fileSrc } from "./native";

const [fonts, setFonts] = createSignal<string[]>([]);
let loading: Promise<unknown> | null = null;

/** Font families Typst can use (embedded + bundled + system), loaded once. */
export function fontList() {
  if (!loading) {
    loading = ipc
      .fonts()
      .then(setFonts)
      .catch(() => setFonts(["New Computer Modern", "Libertinus Serif", "Noto Sans", "Noto Serif", "Vazirmatn", "DejaVu Sans Mono"]));
  }
  return fonts();
}

export const FONT_SIZES = ["8pt", "9pt", "10pt", "10.5pt", "11pt", "12pt", "13pt", "14pt", "16pt", "18pt", "20pt", "24pt", "28pt", "32pt", "40pt", "48pt"];

/**
 * Fallback families for scripts the UI font lacks, in the order the browser
 * should try them (it picks per character). Shared by the UI, the editor and
 * diagram labels; matches the PDF fallbacks in core/src/render/script.rs.
 */
export const SCRIPT_FALLBACKS = [
  "Vazirmatn", "Noto Naskh Arabic", "Noto Sans Devanagari", "Noto Sans Bengali",
  "Noto Sans Thai", "Noto Sans Syriac", "Noto Sans Thaana", "Noto Sans NKo", "Noto Sans Gurmukhi",
  "Noto Sans Gujarati", "Noto Sans Oriya", "Noto Sans Tamil", "Noto Sans Telugu", "Noto Sans Kannada",
  "Noto Sans Malayalam", "Noto Sans Sinhala", "Noto Sans Lao", "Noto Serif Tibetan", "Noto Sans Myanmar",
  "Noto Sans Khmer", "Noto Sans Armenian", "Noto Sans Georgian", "Noto Sans Ethiopic", "Noto Sans Cherokee",
  "Noto Sans Mongolian", "Noto Sans SC", "Noto Sans JP", "Noto Sans KR", "Noto Sans TC",
];

/** CSS font-family value: `first` families, then the script fallbacks. */
export const fontStack = (...first: string[]) =>
  [...first, ...SCRIPT_FALLBACKS].map((f) => `"${f.replace(/"/g, "")}"`).join(", ") + ", system-ui, sans-serif";

/** Unicode ranges per bundled family, so the browser only loads a font for text that needs it. */
const RANGES: Record<string, string> = {
  "Noto Sans": "U+0000-024F, U+0370-052F, U+1E00-1FFF, U+2000-206F",
  "Noto Serif": "U+0000-024F, U+0370-052F, U+1E00-1FFF, U+2000-206F",
  "Noto Naskh Arabic": "U+0600-06FF, U+0750-077F, U+0870-08FF, U+FB50-FDFF, U+FE70-FEFF",
  "Noto Sans Syriac": "U+0700-074F, U+0860-086F",
  "Noto Sans Thaana": "U+0780-07BF",
  "Noto Sans NKo": "U+07C0-07FF",
  "Noto Sans Devanagari": "U+0900-097F, U+A8E0-A8FF",
  "Noto Serif Devanagari": "U+0900-097F, U+A8E0-A8FF",
  "Noto Sans Bengali": "U+0980-09FF",
  "Noto Sans Gurmukhi": "U+0A00-0A7F",
  "Noto Sans Gujarati": "U+0A80-0AFF",
  "Noto Sans Oriya": "U+0B00-0B7F",
  "Noto Sans Tamil": "U+0B80-0BFF",
  "Noto Sans Telugu": "U+0C00-0C7F",
  "Noto Sans Kannada": "U+0C80-0CFF",
  "Noto Sans Malayalam": "U+0D00-0D7F",
  "Noto Sans Sinhala": "U+0D80-0DFF",
  "Noto Sans Thai": "U+0E00-0E7F",
  "Noto Serif Thai": "U+0E00-0E7F",
  "Noto Sans Lao": "U+0E80-0EFF",
  "Noto Serif Tibetan": "U+0F00-0FFF",
  "Noto Sans Myanmar": "U+1000-109F, U+AA60-AA7F",
  "Noto Sans Khmer": "U+1780-17FF, U+19E0-19FF",
  "Noto Sans Armenian": "U+0530-058F, U+FB13-FB17",
  "Noto Sans Georgian": "U+10A0-10FF, U+1C90-1CBF, U+2D00-2D2F",
  "Noto Sans Ethiopic": "U+1200-139F, U+2D80-2DDF, U+AB00-AB2F",
  "Noto Sans Cherokee": "U+13A0-13FF, U+AB70-ABBF",
  "Noto Sans Mongolian": "U+1800-18AF",
};
const CJK_RANGE = "U+1100-11FF, U+2E80-2FDF, U+3000-30FF, U+3130-318F, U+31F0-31FF, U+3400-4DBF, U+4E00-9FFF, U+A960-A97F, U+AC00-D7FF, U+F900-FAFF, U+FF00-FFEF, U+20000-3FFFF";

/** "NotoSansThai-Bold.ttf" → ["Noto Sans Thai", 700]. */
export function familyOf(file: string): [string, number] | null {
  const m = /^(.+?)-(Regular|Bold)\.(ttf|otf)$/i.exec(file);
  if (!m) return null;
  return [m[1].replace(/(?<=[a-z])(?=[A-Z])/g, " "), m[2].toLowerCase() === "bold" ? 700 : 400];
}

/** Register the bundled Noto fonts (from the app's resources) as web fonts. */
export async function installBundledFonts() {
  const { dir, files } = await bundledFonts().catch(() => ({ dir: "", files: [] as string[] }));
  if (!dir || !files.length) return;
  const rules: string[] = [];
  for (const f of files) {
    const fam = familyOf(f);
    if (!fam) continue;
    const [family, weight] = fam;
    const range = RANGES[family] ?? (/ (SC|TC|JP|KR)$/.test(family) ? CJK_RANGE : null);
    rules.push(
      `@font-face { font-family: "${family}"; src: url("${fileSrc(`${dir}/${f}`)}"); font-weight: ${weight}; font-display: swap;${range ? ` unicode-range: ${range};` : ""} }`,
    );
  }
  const style = document.createElement("style");
  style.dataset.notez = "bundled-fonts";
  style.textContent = rules.join("\n");
  document.head.appendChild(style);
}
