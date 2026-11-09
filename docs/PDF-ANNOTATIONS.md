# PDF annotations

PDFs in your vault open in NoteZ's own viewer. In it you can:
- highlight text,
- pin notes on a page,
- mark areas such as figures or equations,
- link to any of these from your notes.

The PDF file itself is never changed.

---

## The viewer

Click a PDF in the file tree, or follow a link to one. The toolbar has:

| Control | |
|---|---|
| <kbd>V</kbd> Select | Select and copy text (the default tool) |
| <kbd>H</kbd> Highlight | Selected text is highlighted right away |
| <kbd>N</kbd> Note | Click anywhere on a page to pin a note |
| <kbd>A</kbd> Area | Drag a rectangle around a figure, a table, an equation… |
| Colours | The colour for new annotations |
| Page box | Type a page number and press Enter |
| − / % / + | Zoom. The % button fits the page to the width again; **Ctrl+wheel** zooms too |
| 🔍 | Find in the PDF (**Ctrl+F**; Enter = next, Shift+Enter = previous) |
| ▯ | Show or hide the annotations panel |

The viewer remembers the last page you read in each PDF. Links inside the
PDF work: table-of-contents entries jump to their page, and web links open
in your browser.

---

## Annotating

**Highlight.** Select text with the Select tool. A small box offers the
colours: click one to highlight. **Highlight + comment** highlights and opens
the comment field. **Copy** copies the text. With the Highlight tool, every
selection is highlighted straight away in the current colour.

**Note.** With the Note tool, click on the page. A pin appears and the
comment box opens.

**Area.** With the Area tool, drag a rectangle. The area can hold a comment.
**Copy as image** puts the region on the clipboard, ready to paste into a
note as a picture.

**Editing.** Click an annotation on the page, or in the panel, to open its
box. There you can:
- change its colour,
- write a comment (**Ctrl+Enter** or **Esc** closes the box),
- copy its link or a quote,
- delete it.

**Delete** removes the selected annotation, and **Esc** deselects it.
Highlights with a comment show a small dot at their start.

---

## Linking from notes

Every annotation has a link. In the panel, click 🔗 **Copy link** to get:

```markdown
[[Paper.pdf#page=3&annotation=k2x9ab1]]
```

Paste it into any note. Clicking it opens the PDF, scrolls to the annotation
and makes it blink. Add a label like any other link:
`[[Paper.pdf#page=3&annotation=k2x9ab1|the key result]]`.

The ❝ button copies a **quote**: the highlighted text as a blockquote, ending
with the link. The comment follows if there is one.

```markdown
> The tcache was introduced in glibc 2.26 to speed up small allocations
> — [[Heap Paper.pdf#page=1&annotation=vt9u9ggcg|Heap Paper, p. 1]]
```

A plain page link works too: `[[Paper.pdf#page=12]]`.

When a file name is used by more than one file in the vault, the links use
the full path instead of just the name.

### Backlinks

The panel shows, under each annotation, the notes that link to it (**↩
Note name**). Click one to open that note at the link. Links to the PDF or
to a page, not to a particular annotation, are listed under **Linked from**.

---

## Where annotations are kept

Annotations are stored next to your notes, not inside the PDF:

```
.notez/annotations/<path of the PDF>.json
```

So:
- the original PDF stays byte-for-byte the same;
- annotations sync along with the rest of `.notez` ([Sync](HISTORY.md));
- renaming or moving the PDF, or its folder, inside NoteZ takes the
  annotations along (links to it are updated as usual).

Each annotation stores its page and its position as a fraction of the page
size, so it stays in place at any zoom. Highlights also store their text,
which the panel shows and quotes use.

---

## Embedding

`![[Paper.pdf]]` and `![[Paper.pdf#page=3]]` show the PDF (or one page) in a
note, and the page is placed in the exported PDF. See [Markdown](MARKDOWN.md).
