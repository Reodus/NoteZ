// Built-in plugin: ```mermaid blocks, rendered by Mermaid.js in the
// frontend and embedded into the PDF as vector SVG.
import type { BuiltinPlugin } from "../core/plugins";
import { fontStack } from "../core/fonts";

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
let counter = 0;

function load(dark: boolean) {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default);
  }
  return mermaidPromise.then((mermaid) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "neutral",
      fontFamily: fontStack("Noto Sans"),
      // Typst renders SVG text, not HTML: keep labels as <text>.
      htmlLabels: false,
      flowchart: { htmlLabels: false, curve: "basis" },
      sequence: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
    } as any);
    return mermaid;
  });
}

async function renderSvg(code: string, dark: boolean): Promise<string> {
  const mermaid = await load(dark);
  const { svg } = await mermaid.render(`nz-mermaid-${++counter}`, code);
  return svg;
}

function typstString(s: string) {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n") + '"';
}

export const mermaidPlugin: BuiltinPlugin = {
  id: "core.mermaid",
  name: "Mermaid diagrams",
  description: "Sequence diagrams, Gantt charts, class diagrams… in ```mermaid blocks.",
  onload(api) {
    api.blocks.register({
      lang: "mermaid",
      // Previews sit on a white "paper" card, like the PDF.
      preview: (code) => renderSvg(code, false),
      async toTypst(code) {
        let svg = await renderSvg(code, false);
        // Natural width from the viewBox, capped to the text width (~450pt).
        const vb = /viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"/.exec(svg);
        const widthPt = vb ? Math.min(Number(vb[1]) * 0.75, 450) : 400;
        // Typst's SVG renderer doesn't need the max-width style.
        svg = svg.replace(/style="max-width:[^"]*"/, "");
        return `#align(center, image(bytes(${typstString(svg)}), format: "svg", width: ${widthPt.toFixed(1)}pt))`;
      },
    });
  },
};
