# NoteZ user guide

NoteZ is a note-taking app for plain-text notes, in any language, with
LaTeX-quality PDF output. Notes are Markdown (`.md`) or Typst (`.typ`) files
in an ordinary folder — your **vault** — so they stay yours, readable by any
other program.

Press **F1** at any time to open this guide. **Ctrl+Shift+P** opens the
command palette, which lists every command with its shortcut.

## Getting started

1. **Open or create a vault**: on the welcome screen, choose an existing
   folder (an Obsidian vault works as it is) or create a new one.
2. **Create a note**: **Ctrl+N**, or the *new note* button above the file
   tree.
3. **Write**: type Markdown, use the formatting toolbar, or type `/` at the
   start of a line for the insert menu (headings, lists, tables, callouts,
   math, charts, diagrams, dates…). See [Slash commands](SLASH.md).
4. **See the PDF**: the preview on the right updates as you type. **⋯ →
   Export to PDF** saves it. Word, HTML and portable Markdown are there too
   (see [Exporting](EXPORT.md)).
5. **Style it**: **⋯ → Themes** picks a document theme; the *Styles* panel
   and **⋯ → Page setup** change fonts, colors, spacing, margins, header and
   footer — for this note or for the whole theme.

## The window

| Area | What it does |
|---|---|
| Sidebar (left) | Files, search (**Ctrl+Shift+F**), tags, bookmarks and the graph. **Ctrl+\\** shows or hides it. |
| Tabs | Open notes, images and PDFs. **Ctrl+Tab** / **Ctrl+Shift+Tab** switch. |
| Toolbar | Paragraph style, font, size, bold/italic/…, colors, alignment, direction, lists, insert. |
| Editor | *Live preview* (Markdown hides away from the cursor) or *Source* (**Ctrl+Shift+M**). |
| Right panel | PDF preview, styles, outline, links (backlinks) and the calendar. |
| Status bar | Save state, words, characters, cursor position, theme, preview status. |

**Ctrl+Shift+Enter** is focus mode: only the text.

## Guides

- [Writing notes (Markdown syntax)](MARKDOWN.md): every formatting rule,
  callouts, annotations, styled text, layout blocks, math, code, charts and
  diagrams, frontmatter, templates and shortcuts.
- [Languages and scripts](LANGUAGES.md): writing in any language, direction,
  fonts, digits, spell checking.
- [PDF themes](PDF-THEMES.md): document themes, page setup, every style
  option, writing your own theme files.
- [UI themes and CSS snippets](UI-THEMES.md): the app's look, writing your
  own theme, design tokens.
- [Tags, daily notes, bookmarks and quick capture](ORGANIZING.md): finding
  your way around a growing vault.
- [Slash commands and completion](SLASH.md): the `/` menu, commands with
  arguments, completion as you type.
- [Search and replace](SEARCH.md): the search syntax, replacing across the
  vault, renaming tags.
- [Blocks, references and embeds](BLOCKS.md): `^block-ids`, `((` links,
  embeds, backlinks and unlinked mentions, the block handle, folding, zoom.
- [History, snapshots and sync](HISTORY.md): earlier versions of a note,
  recovering deleted notes, vault snapshots, encrypted sync.
- [Databases and queries](DATABASES.md): `.base` files (Obsidian Bases),
  tables, boards and cards from note properties, live ```` ```query ```` blocks.
- [Flashcards](FLASHCARDS.md): cards written in notes (`Q::A`, `?`, `==cloze==`),
  spaced repetition with FSRS, decks and statistics.
- [PDF annotations](PDF-ANNOTATIONS.md): highlights, notes and areas on PDFs,
  linking to them from notes, backlinks.
- [Writing plugins](PLUGINS.md): extending NoteZ with JavaScript.

## Files and folders

- Notes are `.md` and `.typ` files. Images, PDFs and other files can live
  anywhere in the vault; **Settings → Files & links** decides where pasted
  and dropped files go.
- Renaming or moving a note updates the links to it (ask / always / never,
  in Settings).
- NoteZ keeps its own data in `<vault>/.notez/`: document themes
  (`styles/`), UI themes (`themes/`), snippets (`snippets/`), plugins
  (`plugins/`) and bookmarks (`bookmarks.json`).
- **Ctrl+Alt+D** opens today's [daily note](ORGANIZING.md#daily-notes-and-the-calendar).
- Settings are stored per computer, not in the vault.

## The graph

**Ctrl+G** (or the graph button in the sidebar) opens the graph of the vault.

- **Folders** are rounded squares, linked to the notes and subfolders inside them; the vault is the large node in the middle. **Click a folder** to collapse it into one node (it then shows `+` and how many notes it holds), click again to expand. **Ctrl+click** a folder opens its folder note (`Folder/Folder.md`, `Folder/index.md` or `Folder/README.md`).
- **Notes** are circles; click one to open it. **Dashed lines** are `[[links]]` between notes.
- **Right-click** a node for more: collapse/expand, open the folder note, reveal in the file tree, show the local graph of a note. Right-click the background to collapse or expand every folder.
- Drag a node to pin it where you drop it; **Alt+drag** lets it go back. Drag the background to pan, scroll to zoom. Type in **Filter** to highlight notes by name or folder path.
- **Local** shows only what is near the open note (set the depth in the options).

The options button (sliders icon) has more:

| Option | What it does |
|--------|--------------|
| Folders | Draw the folder structure. Off: a plain link graph |
| Note links | Draw `[[links]]` between notes |
| Tags | Add each tag as a diamond, linked to its notes |
| Attachments | Add images and PDFs |
| Notes without links | Off: hide notes that only hang on their folder |
| Link arrows | Show which way a link points |
| Color by | Top-level folder, node type, or no color |
| Node size, link distance, repel force | Size and spacing of the layout |
| Note labels from zoom | How far you zoom in before note names appear |

Options and collapsed folders are remembered. **Reset options** goes back to the defaults.

## Updates

NoteZ checks GitHub for a new release a few seconds after it starts and then
every six hours. When there is one, a message offers **Update**:

- **Linux AppImage, .deb, .rpm and the Windows installer**: NoteZ downloads
  the new version in the background and shows **Restart** when it is ready.
  Your notes are saved first. If you don't restart, the update is installed
  the next time you quit.
- **macOS and the portable Windows .exe**: these can't replace themselves, so
  NoteZ downloads the new file to your Downloads folder, checks it against the
  checksum GitHub publishes, and opens it (macOS) or shows it in the file
  manager (portable .exe).

**Settings → Updates** shows your version and the state of the check, has a
**Check now** button, and lets you turn the automatic check off. The command
palette has **Check for updates** too.

Versions 0.12.0 and older can't update themselves: install 0.12.1 or later
once by hand from
[GitHub releases](https://github.com/Reodus/NoteZ/releases); after that,
updates come in by themselves.

## Getting help

- **F1**: this guide (with search).
- **Ctrl+Shift+P**: every command.
- Report problems and ideas on
  [GitHub](https://github.com/Reodus/NoteZ/issues).
