// Sample NoteZ plugin. A plugin is one ES module: export default { onload(api) }.
// Everything registered through `api` is removed automatically when the plugin
// is disabled in Settings → Plugins. Types: docs/notez-plugin.d.ts

/** "Label: 70" lines → [{ label, value }] */
function parse(code) {
  return code
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.lastIndexOf(":");
      const label = i < 0 ? l : l.slice(0, i).trim();
      const value = Math.max(0, Math.min(100, parseFloat(i < 0 ? "0" : l.slice(i + 1)) || 0));
      return { label, value };
    });
}

const typstStr = (s) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const colorFor = (v) => (v >= 80 ? "#1f9d55" : v >= 40 ? "#4c7bd9" : "#e07a2e");

export default {
  onload(api) {
    // 1) A new fenced block type — rendered in the editor and in the PDF.
    api.blocks.register({
      lang: "progress",
      toTypst(code) {
        const rows = parse(code)
          .map(
            ({ label, value }) =>
              `[#text(size: 0.9em, ${typstStr(label)})], ` +
              `box(width: 100%, height: 0.75em, radius: 0.4em, fill: luma(232), clip: true, ` +
              `box(width: ${value}%, height: 100%, radius: 0.4em, fill: rgb("${colorFor(value)}"))), ` +
              `[#text(size: 0.85em, fill: luma(90))[${value}%]]`,
          )
          .join(",\n  ");
        return `#block(width: 100%, inset: (y: 4pt), grid(columns: (auto, 1fr, auto), column-gutter: 10pt, row-gutter: 8pt, align: horizon,\n  ${rows}\n))`;
      },
      preview(code) {
        const rows = parse(code)
          .map(
            ({ label, value }) => `
          <div style="display:flex;align-items:center;gap:10px;margin:6px 0">
            <span style="min-width:90px;text-align:start">${esc(label)}</span>
            <div style="flex:1;height:10px;border-radius:6px;background:#e8e8ee;overflow:hidden">
              <div style="width:${value}%;height:100%;border-radius:6px;background:${colorFor(value)}"></div>
            </div>
            <span style="color:#666;font-size:12px;min-width:36px">${value}%</span>
          </div>`,
          )
          .join("");
        return `<div dir="auto" style="padding:4px 8px">${rows}</div>`;
      },
    });

    // 2) A command (shows up in the command palette, Ctrl+Shift+P).
    api.commands.register({
      id: "insert",
      title: "Insert progress block",
      run: () => api.editor.insertBlock("```progress\nDesign: 90\nBackend: 60\nDocs: 20\n```"),
    });

    // 3) A toolbar button.
    api.toolbar.addButton({
      id: "date",
      title: "Insert today's date",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
      run: () => {
        const persian = api.settings.get("persianDate", true);
        const d = new Date().toLocaleDateString(persian ? "fa-IR" : "en-CA");
        api.editor.insert(d);
      },
    });

    api.ui.notify("Progress bars plugin loaded", "success");
  },
};
