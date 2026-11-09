# Exporting notes

A Markdown note can be exported to four formats. A `.typ` note can only be
exported to PDF. To export, use any of these:

- **⋯** (note menu) → *Export to PDF… / Word… / HTML… / Markdown…*
- The export button above the PDF preview
- Right-click in the editor, or right-click the note in the file tree → *Export*
- The command palette: *Export PDF* (**Ctrl+Shift+S**), *Export to Word*,
  *Export to HTML*, *Export to portable Markdown*

**Settings → PDF → Export to** sets where the save dialog starts: the vault
root, next to the note, or a fixed folder. *Open the file after exporting*
opens the result in the default app for its type.

If something could not be carried over, the toast after an export lists it. For
example: "3 links to other notes became plain text" or "missing file: x.png".

## What each format keeps

| | PDF | Word (.docx) | HTML | Markdown |
|---|---|---|---|---|
| Theme fonts, sizes, colors, spacing | ✓ | ✓ (as Word styles) | ✓ (as CSS) | — |
| Right-to-left paragraphs and tables | ✓ | ✓ | ✓ | as written |
| Footnotes | ✓ | real Word footnotes | numbered list at the end | `[^1]` kept |
| Table of contents | ✓ | Word TOC field | linked list | linked list |
| Math | ✓ | picture | picture (SVG) | `$…$` kept |
| Charts, diagrams, `draw`, `typst` blocks | ✓ | picture | picture (SVG) | SVG file + source |
| Mermaid | ✓ | picture | picture | kept (GitHub draws it) |
| Images | ✓ | embedded | embedded | copied to `<note>_files/` |
| PDF pages (`![[doc.pdf#page=2]]`) | ✓ | picture | picture | SVG file |
| Callouts | ✓ | colored bar + tint | colored box | GitHub alert (`> [!NOTE]`) |
| `[text]{…}` spans, `::: {…}` divs | ✓ | ✓ | ✓ | `<span>` / `<div>` |
| Links to other notes | ✓ (text) | text | text | relative `.md` links |
| Page size, margins, header/footer | ✓ | ✓ | — | — |
| `%% comments %%` | removed | removed | removed | removed |

Every format decides the direction of a paragraph or table with the same rule
as the PDF and the editor. A `::: {dir=…}` or `::: {lang=…}` block decides
first. Otherwise the text's own letters decide. See
[Languages and direction](MARKDOWN.md#languages-and-direction).

## Word (.docx)

- Headings are Word's *Heading 1–6* styles, so the navigation pane, the table
  of contents and heading numbering work.
- Persian/Arabic text uses Word's complex-script font slot (the theme's
  Persian font, Vazirmatn by default). Install that font for the best result.
- Fonts that Typst bundles but Word users rarely have are mapped: New Computer
  Modern becomes Cambria, and the code font becomes Consolas.
- Word asks to *update fields* when you open a note that has a table of
  contents. Answer *Yes* to fill in the page numbers.
- `columns=` divs become Word sections with columns.

## HTML

The result is one self-contained `.html` file. Images, diagrams and math are
inside it, and it needs no internet connection. When the note contains
Persian/Arabic text, the Vazirmatn font is embedded too. It prints well from a
browser.

## Portable Markdown

This is plain Markdown that other apps and GitHub can show. The note is
rewritten line by line, so your own formatting stays as you wrote it. The
export makes `<note>.md` plus a `<note>_files/` folder:

- `[[Note]]` becomes `[Note](relative/path/Note.md)`, and `[[Note#Heading]]`
  becomes a link with a `#heading` anchor.
- Images and attachments are copied into `<note>_files/`. Widths become
  `<img width>`.
- Each special block (chart, diagram, flow, …) becomes an SVG file, with the
  original code kept below it in a collapsed *Source* section.
- An embedded note (`![[Note]]`) is copied in place.
- Callouts become GitHub alerts. `==highlight==` becomes `<mark>`, and page
  breaks are dropped.
