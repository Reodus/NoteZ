import type { BlockContext, LeafBlock, LeafBlockParser, MarkdownConfig } from "@lezer/markdown";

/** `[^1]: word` is a footnote definition, but CommonMark also reads it as a
 * link reference (label `[^1]`, URL `word`), so a one-word footnote got the
 * small muted URL style while longer ones looked normal. Claim footnote
 * definitions before the link-reference parser sees them. */
class FootnoteDef implements LeafBlockParser {
  // Ending here (not only in finish) keeps the link-reference parser, which
  // ends its leaf on the next line, from claiming it first.
  nextLine(cx: BlockContext, _line: unknown, leaf: LeafBlock) {
    return this.finish(cx, leaf);
  }
  finish(cx: BlockContext, leaf: LeafBlock) {
    cx.addLeafElement(leaf, cx.elt("Paragraph", leaf.start, leaf.start + leaf.content.length, cx.parser.parseInline(leaf.content, leaf.start)));
    return true;
  }
}

export const footnoteDefinitions: MarkdownConfig = {
  parseBlock: [
    {
      name: "FootnoteDefinition",
      before: "LinkReference",
      leaf: (_cx, leaf) => (/^\[\^[^\]\s]+\]:/.test(leaf.content) ? new FootnoteDef() : null),
    },
  ],
};
