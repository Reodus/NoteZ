# Blocks, references and embeds

A note is made of **blocks**: paragraphs, headings, list items, quotes and
callouts, tables, code and math. You can link to one block of a note, show
it inside another note, move it with the mouse, fold it, or zoom into it.
The syntax is the same as Obsidian's, so links work in both apps.

- [Block ids](#block-ids)
- [Linking to a block: `((`](#linking-to-a-block)
- [Embeds](#embeds)
- [Previews and jumping](#previews-and-jumping)
- [Backlinks and unlinked mentions](#backlinks-and-unlinked-mentions)
- [The block handle](#the-block-handle)
- [Folding](#folding)
- [Zoom](#zoom)
- [In the PDF](#in-the-pdf)

## Block ids

A block gets a name with `^id` at its end:

```markdown
Spaced repetition makes memory stick. ^srs

- Build a garden ^garden
  - Water daily

| What | When |
|------|------|
| Trip | May  |

^plan
```

- For paragraphs, headings and list items, the id goes at the end of the
  block's (last) line, after a space.
- For tables, quotes, callouts and code blocks, the id goes on a line of its
  own after the block, with an empty line before it.
- An id is made of letters, digits, `-` and `_`. NoteZ makes ids of six
  letters and digits when it adds one for you.
- Ids are shown small and faded in the editor and are left out of the PDF.

You rarely type ids yourself: linking to a block adds one when it has none.

## Linking to a block

Type `((` and a few words from the block you mean. Every block in the vault
that contains those words is listed, those of the current note first; pick one
with **Enter**. NoteZ inserts a link and gives the block an id if it has
none:

```markdown
See [[Ideas#^srs]].           a block in another note
See [[#^srs]].                a block in this note
See [[Ideas#^srs|this idea]]. with your own text
```

You can also copy a link from the block itself: hover over it, click the
[handle](#the-block-handle) and choose **Copy link to block**.

Headings don't need ids: link to them by their text, `[[Ideas#Later]]`, or
`[[Ideas#Later#Sub]]` for a heading under another one.

## Embeds

Put `!` in front of a link, alone on its line, to show what it points at:

```markdown
![[Ideas]]              the whole note (without its properties)
![[Ideas#Later]]        a heading and everything under it
![[Ideas#^plan]]        one block
```

In live preview the embed appears below the line, framed by a bar on the
left. It updates when the embedded note is saved. Click its title to open
the note. Embeds can contain embeds (up to four levels deep).

## Previews and jumping

- **Hover** over a `[[link]]` to see what it points at.
- **Click** a link (Ctrl+click in source mode) to open the note. For a block
  or heading, the note scrolls there and the block blinks briefly.

## Backlinks and unlinked mentions

The **Links** panel (right panel) lists:

- **Backlinks**: every link to the open note, grouped by the note it is in.
  Each one shows the paragraph or list item around the link, and whether it
  points at a block (`block ^srs`), a heading (`# Later`) or the whole note,
  and whether it is an embed. Click one to go there.
- **Unlinked mentions** (click the title to look for them): places where
  another note writes this note's name, or one of its `aliases`, without
  linking to it. Names must be at least three letters; matches ignore case
  and must be whole words; text in code, links, URLs and tags is skipped.
  **Link** turns that mention into a link (`[[Ideas|ideas]]`, keeping the
  text as written); **Link all** does it for every mention listed.
- **Outgoing links** of the open note.

## The block handle

Move the mouse over a block: a grip `⋮⋮` appears at its left.

- **Drag** the grip to move the block. A line shows where it will go: before
  or after the block under the mouse. Dragging a heading moves its whole
  section; dragging a list item moves its nested items with it.
- **Click** the grip for a menu:
  - *Copy link to block* / *Copy embed of block*: `[[Note#^id]]` or
    `![[Note#^id]]` (for a heading, `[[Note#Heading]]`), adding the id when
    needed.
  - *Turn into*: text, heading 1–3, bulleted, numbered or task list, quote.
  - *Duplicate* (the copy has no id), *Fold* / *Unfold*, *Zoom in*, *Delete*.

## Folding

Headings (with their section), list items with nested items, quotes, code
blocks and tables can be folded:

- click the arrow in the left margin (it shows when the mouse is over the
  margin; folded blocks keep it, turned sideways),
- or **Ctrl+Shift+[** to fold and **Ctrl+Shift+]** to unfold at the cursor
  (**Cmd+Alt+[** / **]** on macOS), **Ctrl+Alt+[** / **Ctrl+Alt+]** to fold
  or unfold everything.

A folded block ends with `…`; click it to unfold. Folding only changes the
view, not the note or the PDF.

## Zoom

Zoom shows one heading's section, or one list item with its nested items,
alone, like an outliner:

- **Ctrl+Shift+.** zooms into the heading section or list item at the
  cursor (inside a section without a list item: the section's heading),
- or choose *Zoom in* from the block handle's menu.

A bar at the top shows where you are (*Note › Heading › …*): click a part to
zoom out to it. **Esc**, **Ctrl+Shift+,** or **×** shows the whole note again.
While zoomed you edit the note as usual; the rest of the note is only hidden.

## In the PDF

- `^ids` are not printed.
- `[[#^id]]` links to a block of the same note are clickable and jump to it,
  like `[[#Heading]]` links.
- Embeds are printed in place, with a thin bar on their left.
- A link to another note's block or heading shows the note's name
  (`Ideas` or `Ideas › Later`) unless it has its own text.
