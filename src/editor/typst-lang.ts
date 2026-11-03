// A lightweight Typst highlighter (StreamLanguage tokenizer).
import { StreamLanguage, StringStream } from "@codemirror/language";

interface S {
  math: boolean;
  code: number; // nesting depth of code blocks after '#'
  raw: boolean;
  comment: boolean;
}

export const typst = StreamLanguage.define<S>({
  name: "typst",
  startState: () => ({ math: false, code: 0, raw: false, comment: false }),
  token(stream: StringStream, s: S): string | null {
    if (s.comment) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        s.comment = false;
      } else stream.skipToEnd();
      return "comment";
    }
    if (s.raw) {
      if (stream.match("```")) s.raw = false;
      else stream.next();
      return "monospace";
    }
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      s.comment = true;
      return "comment";
    }
    if (stream.match("```")) {
      s.raw = true;
      return "monospace";
    }
    if (stream.match(/^`[^`]*`/)) return "monospace";
    if (stream.sol() && stream.match(/^\s*=+\s/)) {
      stream.skipToEnd();
      return "heading";
    }
    if (stream.match("$")) {
      s.math = !s.math;
      return "keyword";
    }
    if (s.math) {
      stream.next();
      return "number";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/^#(let|set|show|import|include|if|else|for|while|return|context)\b/)) return "keyword";
    if (stream.match(/^#[\w-]+(\.[\w-]+)*/)) return "function";
    if (stream.match(/^<[\w:.-]+>/)) return "labelName";
    if (stream.match(/^@[\w:.-]+/)) return "link";
    if (stream.match(/^\*[^*\n]+\*/)) return "strong";
    if (stream.match(/^_[^_\n]+_/)) return "emphasis";
    if (stream.match(/^\d+(\.\d+)?(pt|em|cm|mm|in|%|deg|fr)?\b/)) return "number";
    if (stream.sol() && stream.match(/^\s*[-+]\s/)) return "list";
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
});
