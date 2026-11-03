import { createSignal } from "solid-js";
import { ipc } from "./ipc";

const [fonts, setFonts] = createSignal<string[]>([]);
let loading: Promise<unknown> | null = null;

/** Font families Typst can use (embedded + bundled + system), loaded once. */
export function fontList() {
  if (!loading) {
    loading = ipc
      .fonts()
      .then(setFonts)
      .catch(() => setFonts(["New Computer Modern", "Libertinus Serif", "Vazirmatn", "DejaVu Sans Mono"]));
  }
  return fonts();
}

export const FONT_SIZES = ["8pt", "9pt", "10pt", "10.5pt", "11pt", "12pt", "13pt", "14pt", "16pt", "18pt", "20pt", "24pt", "28pt", "32pt", "40pt", "48pt"];
