// Dev harness: renders the gallery's Mermaid templates and prints the Typst
// the PDF engine receives (read it with `chromium --dump-dom`).
import { TEMPLATES } from "../src/ui/DiagramGallery";
import { mermaidPlugin } from "../src/plugins/mermaid";
import type { BlockRenderer } from "../src/core/app";

let r!: BlockRenderer;
await mermaidPlugin.onload({ blocks: { register: (x: BlockRenderer) => (r = x) } } as any);
let md = "# Mermaid\n\n";
for (const t of TEMPLATES.filter((t) => t.lang === "mermaid")) {
  try {
    const svg = await r.preview!(t.code, { dark: false });
    document.getElementById("svgs")!.insertAdjacentHTML("beforeend", `<div>${svg}</div>`);
    md += `## ${t.id}\n\n\`\`\`typst\n${await r.toTypst(t.code)}\n\`\`\`\n\n`;
  } catch (e) {
    md += `ERROR ${t.id}: ${e}\n`;
  }
}
document.getElementById("out")!.textContent = "BEGIN\n" + md + "\nEND";
