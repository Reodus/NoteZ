import { Table, type MarkdownConfig } from "@lezer/markdown";

const [table] = Table.parseBlock!;

function hasTablePipe(text: string, start: number) {
  for (let i = start; i < text.length; i++) {
    if (text[i] === "|") return true;
    if (text[i] === "\\") i++;
  }
  return false;
}

/** Let prose interrupt a table when it has no unescaped cell delimiter. */
export const tableBoundaries: MarkdownConfig = {
  parseBlock: [{
    name: table.name,
    leaf(cx, leaf) {
      const parser = table.leaf!(cx, leaf);
      if (!parser) return null;
      const parseNext = parser.nextLine.bind(parser);
      // Keep the original instance so Lezer's GFM endLeaf check still recognizes it.
      parser.nextLine = (cx, line, leaf) => (
        (!hasTablePipe(line.text, line.pos) && parser.finish(cx, leaf)) || parseNext(cx, line, leaf)
      );
      return parser;
    },
  }],
};
