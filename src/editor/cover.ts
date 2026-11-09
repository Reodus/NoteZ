// Frontmatter `cover:` (an image) and `icon:` (an emoji) shown as a banner
// at the top of the note in live preview, like a Notion page header.
import { EditorState, StateField, type Extension } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { readFrontmatter } from "../core/frontmatter";
import { resolveImage } from "./livepreview";

/** `[[image.png]]` / `![[image.png]]` / "image.png" → "image.png". */
const target = (v: unknown) =>
  typeof v === "string" ? v.trim().replace(/^!?\[\[([^\]|]+)(\|[^\]]*)?\]\]$/, "$1").replace(/^<|>$/g, "") : "";

class CoverWidget extends WidgetType {
  constructor(readonly cover: string, readonly icon: string, readonly pos: string) {
    super();
  }
  eq(o: CoverWidget) {
    return o.cover === this.cover && o.icon === this.icon && o.pos === this.pos;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-nz-cover" + (this.cover ? " has-image" : "");
    el.contentEditable = "false";
    if (this.cover) {
      const img = document.createElement("div");
      img.className = "cm-nz-cover-img";
      img.style.backgroundPosition = this.pos;
      void resolveImage(this.cover).then((u) => {
        if (u) img.style.backgroundImage = `url("${u.replace(/"/g, "%22")}")`;
        else el.classList.add("missing");
      });
      el.append(img);
    }
    if (this.icon) {
      const i = document.createElement("div");
      i.className = "cm-nz-cover-icon";
      i.textContent = this.icon;
      el.append(i);
    }
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

function build(state: EditorState): DecorationSet {
  const text = state.doc.sliceString(0, Math.min(state.doc.length, 4000));
  if (!text.startsWith("---")) return Decoration.none;
  const fm = readFrontmatter(text);
  const cover = target(fm.cover ?? fm.banner);
  const icon = typeof fm.icon === "string" ? fm.icon.trim().slice(0, 8) : "";
  if (!cover && !icon) return Decoration.none;
  // "banner_y: 0.3" (Obsidian Banners) or "cover-position: top".
  const y = fm["cover-position"] ?? (typeof fm.banner_y === "number" ? `center ${Math.round(fm.banner_y * 100)}%` : "center");
  return Decoration.set([Decoration.widget({ widget: new CoverWidget(cover, icon, String(y)), side: -1, block: true }).range(0)]);
}

export const coverField: Extension = StateField.define<DecorationSet>({
  create: build,
  update(deco, tr) {
    if (!tr.docChanged) return deco;
    // Only the frontmatter matters.
    let touched = false;
    tr.changes.iterChangedRanges((a) => (touched ||= a < 4000));
    return touched ? build(tr.state) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
