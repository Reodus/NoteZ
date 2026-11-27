import { parser, type MarkdownConfig } from "@lezer/markdown";

// The CommonMark form stays with Lezer's built-in Image parser. This rule
// only accepts a single-line local destination with a literal space.
const spacedImage = /^!\[((?:\\.|[^\[\]\\\r\n])*)\]\(( *[^<\s"'():]+(?: +[^<\s"'():]+)+)(?: +(?:"[^"\r\n]*"|'[^'\r\n]*'))? *\)/;

export const spacedImages: MarkdownConfig = {
  defineNodes: ["SpacedImage"],
  parseInline: [{
    name: "SpacedImage",
    before: "Image",
    parse(cx, next, pos) {
      if (next !== 33 || cx.char(pos + 1) !== 91) return -1;
      const end = cx.text.indexOf("\n", pos - cx.offset);
      const match = spacedImage.exec(cx.slice(pos, end < 0 ? cx.end : end + cx.offset));
      if (!match) return -1;
      const start = pos + match[1].length + 4;
      const dest = match[2];
      const from = start + dest.length - dest.trimStart().length;
      return cx.addElement(cx.elt("SpacedImage", pos, pos + match[0].length, [
        cx.elt("URL", from, start + dest.length),
      ]));
    },
  }],
};

const inlineParser = parser.configure(spacedImages);

export function markdownImages(text: string): { from: number; to: number; alt: string; url: string }[] {
  if (!text.includes("![")) return [];
  const images: { from: number; to: number; alt: string; url: string }[] = [];
  inlineParser.parse(text).iterate({
    enter(node) {
      if (node.name !== "Image" && node.name !== "SpacedImage") return;
      const url = node.node.getChild("URL");
      if (!url || text.slice(node.from, node.to).includes("\n")) return false;
      images.push({
        from: node.from,
        to: node.to,
        alt: imageCaption(text.slice(node.from, url.from)),
        url: text.slice(url.from, url.to).replace(/^<|>$/g, ""),
      });
      return false;
    },
  });
  return images;
}

export function imageCaption(prefix: string) {
  const end = prefix.lastIndexOf("](");
  return end < 0 ? "" : prefix.slice(2, end).replace(/\\([\[\]|])/g, "$1");
}
