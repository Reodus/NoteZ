// #tags in the editor: coloured, and Ctrl/Cmd-click (or click in live
// preview) searches the vault for the tag.
import { Decoration, DecorationSet, EditorView, MatchDecorator, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

const CODE = /Code|Comment|URL|HTMLBlock|LinkMark|CodeText|FencedCode|InlineCode|CodeBlock|Frontmatter|Math/;

const tagMatcher = new MatchDecorator({
  // Same rule as the core: after a start/space/bracket, at least one non-digit.
  regexp: /(?<=^|[\s(\[,])#(?=[\p{L}\p{N}_\-/]*[\p{L}_\-])[\p{L}\p{N}\p{M}_\-/]+/gu,
  decorate: (add, from, _to, match, view) => {
    const tree = syntaxTree(view.state);
    for (let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(from + 1, 1); n; n = n.parent) {
      if (CODE.test(n.name)) return;
    }
    const tag = match[0].slice(1).replace(/[/-]+$/, "");
    add(from, from + 1 + tag.length, Decoration.mark({ class: "cm-nz-tag", attributes: { "data-tag": tag } }));
  },
});

const highlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = tagMatcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = tagMatcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

/** `onTag` runs on click (live preview) or Ctrl/Cmd-click (source mode). */
export function tagExtension(onTag: (tag: string) => void) {
  return [
    highlighter,
    EditorView.domEventHandlers({
      mousedown(e, view) {
        const el = (e.target as HTMLElement).closest?.(".cm-nz-tag") as HTMLElement | null;
        if (!el || e.button !== 0) return false;
        const live = view.dom.classList.contains("cm-nz-live");
        if (!live && !(e.ctrlKey || e.metaKey)) return false;
        // In live preview a plain click on the tag searches; with the cursor
        // already on the tag's line, clicking edits it.
        const line = view.state.doc.lineAt(view.posAtDOM(el));
        if (live && !(e.ctrlKey || e.metaKey) && view.state.selection.main.head >= line.from && view.state.selection.main.head <= line.to) return false;
        e.preventDefault();
        onTag(el.dataset.tag ?? "");
        return true;
      },
    }),
  ];
}
