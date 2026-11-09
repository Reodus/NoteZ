import { createEffect, createSignal, on, onCleanup } from "solid-js";
// Word counting for notes in any language.
const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;

/** Scripts written without spaces between words: these need the segmenter. */
const UNSPACED = /[\u0E00-\u0EFF\u1000-\u109F\u1780-\u17FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{3FFFF}]+/gu;
// Starts with a letter or digit, so runs like "-----" can't backtrack.
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}\u200C'’-]*/gu;

/**
 * Words in text of any language. Spaced scripts are counted with a regular
 * expression (fast, even for long notes); runs of Chinese, Japanese, Thai,
 * Lao, Khmer or Myanmar text go through the browser's word segmenter, which
 * splits them into real words. ZWNJ-joined Persian words stay whole.
 */
export function countWords(text: string): number {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/```[\s\S]*?```/g, " ");
  let n = 0;
  const spaced = body.replace(UNSPACED, (run) => {
    if (segmenter) for (const s of segmenter.segment(run)) n += s.isWordLike ? 1 : 0;
    else n += run.length;
    return " ";
  });
  return n + (spaced.match(WORD)?.length ?? 0);
}

const [words, setWords] = createSignal(0);
/** Words in the active note, updated when typing pauses. */
export const activeWords = words;

/** Keep {@link activeWords} counting `text` (call once, inside a component). */
export function trackWords(text: () => string, key: () => unknown) {
  let timer: number | undefined;
  let fresh = true;
  createEffect(on(key, () => (fresh = true)));
  createEffect(() => {
    const t = text();
    clearTimeout(timer);
    // A newly opened note is counted at once; edits once typing pauses.
    timer = window.setTimeout(() => setWords(countWords(t)), fresh ? 0 : 400);
    fresh = false;
  });
  onCleanup(() => clearTimeout(timer));
}
