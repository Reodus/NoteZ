# Tags, daily notes, bookmarks and quick capture

Ways to find your way around a growing vault, besides folders and links.

- [Tags](#tags)
- [Daily notes and the calendar](#daily-notes-and-the-calendar)
- [Bookmarks](#bookmarks)
- [Quick capture](#quick-capture)
- [Note icons and covers](#note-icons-and-covers)

## Tags

Write `#tag` anywhere in a note, or list tags in its properties:

```markdown
---
tags: [project, reading/books]
---
Notes about #project planning and #reading/books.
```

- A tag starts with `#` after a space (or at the start of a line) and is made
  of letters, digits, `_`, `-` and `/`, in any script: `#مقاله`, `#读书`,
  `#à-faire`. It needs at least one letter: `#123` is not a tag, `#2024/review` is.
- `/` nests tags: `#reading/books` is also counted under `#reading`.
- Tags in code (`` `#x` `` or a code block) don't count; nor does `# Heading`.
- Tags ignore case: `#Work` and `#work` are the same tag.

The **Tags** pane (the `#` button in the sidebar) lists every tag with the
number of notes, as a tree. Click a tag to search for it (`tag:name`);
right-click it to **rename** the tag in every note (nested tags too, in the
text and in the properties) or to bookmark the search.

In the editor, tags are highlighted. In live preview a click on a tag
searches for it (with the cursor on the line, the click edits the text);
in source mode use Ctrl+click. Typing `#` and a letter suggests existing tags.

## Daily notes and the calendar

A daily note is one note per day, for journaling, logs and to-dos.

- **Ctrl+Alt+D** opens today's note, creating it if needed.
- **Ctrl+Alt+←** / **Ctrl+Alt+→** go to the previous / next existing daily note.
- The command palette also has *Open yesterday's / tomorrow's daily note*.
- The **Calendar** (calendar icon in the right panel) shows the month: a dot
  marks days that have a note, the open note's day is filled. Click a day to
  open or create its note. Week numbers are ISO weeks.

**Settings → Daily notes & capture**:

| Setting | Default | |
|---|---|---|
| Daily notes folder | `Daily` | empty = the vault's top level |
| File name format | `YYYY-MM-DD` | see the tokens below; `/` makes subfolders, e.g. `YYYY/MM/YYYY-MM-DD` |
| Template | none | a note whose text new daily notes start with |
| Weeks start on | Monday | Monday, Sunday or Saturday |

Date format tokens (as in Obsidian and Moment.js): `YYYY` 2026, `YY` 26,
`MMMM` November, `MMM` Nov, `MM` 11, `M` 11, `DD` 09, `D` 9, `Do` 9th,
`dddd` Monday, `ddd` Mon, `ww` ISO week, `Q` quarter, `HH:mm` time; text
in `[brackets]` is kept as it is: `YYYY-[W]ww` → `2026-W46`.

In the template, `{{date}}` is the daily note's date (also when you create a
note for another day from the calendar), `{{date:dddd}}` its weekday,
`{{title}}` the file name and `{{time}}` the current time.

## Bookmarks

The **Bookmarks** pane (bookmark icon in the sidebar) keeps notes, folders,
headings and searches at hand, in groups.

- Bookmark a note or folder from its right-click menu (file tree, tab) or the
  note's **⋯** menu, or drag it from the file tree onto the pane.
- Bookmark a heading: right-click the heading in the editor →
  *Bookmark this heading*.
- Bookmark a search: run it, then click *Bookmark* above the results.
- **New group**: the folder button at the top of the pane. Drag bookmarks to
  reorder them or drop them on a group; right-click to rename or remove.

Bookmarks are stored in `<vault>/.notez/bookmarks.json`, in the same format
as Obsidian's `bookmarks.json`. A vault with Obsidian bookmarks and no NoteZ
bookmarks yet shows the Obsidian ones; the first change saves them for NoteZ.
Renaming or moving a bookmarked note keeps its bookmark.

## Quick capture

A global shortcut opens a small window over whatever you are doing; type a
thought, press **Enter**, and it is added to a note. **Shift+Enter** makes a
new line, **Esc** cancels.

Set it up in **Settings → Daily notes & capture**:

- **Quick capture shortcut**: click the box and press the keys, e.g.
  Ctrl+Shift+Space. It works while NoteZ is running, even in the background.
  If another app already uses the keys, NoteZ tells you.
- **Capture to**: today's daily note (created if needed) or a note you choose.
- **Captured line**: the format of the added line. `{{text}}` is what you
  typed, `{{time}}` and `{{date:FORMAT}}` work as in templates. Default:
  `- {{time}} {{text}}`.

## Note icons and covers

Give a note an icon and a banner image in its properties:

```yaml
---
icon: 🚀
cover: images/launch.jpg
cover-position: center 30%
---
```

- `icon` (an emoji or one or two characters) is shown in the file tree, the
  tab, and at the top of the note.
- `cover` is an image in the vault (a path, a file name, or `[[image.png]]`)
  or a web address. It is shown as a banner above the note in live preview.
  `banner` (Obsidian's Banners plugin) works too.
- `cover-position` moves the visible part of the image: `top`, `bottom`,
  `center 30%`. Obsidian's `banner_y: 0.3` is understood as well.
