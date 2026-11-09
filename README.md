# NoteZ

A multilingual note-taking app for Linux, Windows and macOS with LaTeX-quality
PDF export. Notes are plain Markdown or [Typst](https://typst.app) files in a
folder; the PDF engine is Typst, embedded — no TeX installation needed.

![NoteZ](docs/screenshot.png)

## Features

Every feature can be typed by hand, no toolbar needed. See
**[docs/MARKDOWN.md](docs/MARKDOWN.md)** for the full syntax (formatting, callouts,
annotations, styled spans, layout blocks, math, charts, frontmatter).

- **Any language, any script** — Latin, Arabic, Persian, Urdu, Chinese,
  Japanese, Korean, Devanagari, Bengali, Tamil, Thai, Cyrillic, Greek,
  Ethiopic and more, mixed freely. Every line picks its own direction
  (RTL/LTR); the note's language is detected for hyphenation, quotes and
  digits; fonts for every major script are bundled. See
  [docs/LANGUAGES.md](docs/LANGUAGES.md).
- **Beautiful PDF** — Markdown and `.typ` notes are typeset by embedded Typst,
  with a live PDF preview next to the editor.
- **Word-like styling** — a ribbon toolbar (fonts, sizes, colors, alignment,
  direction) and Word-style paragraph styles (Title, Heading 1–6, …) with
  fonts, sizes, colors, spacing and numbering, saved as document themes.
  16 built-in PDF themes (thesis, book, letter, newspaper, two-column notes…),
  or write your own ([docs/PDF-THEMES.md](docs/PDF-THEMES.md)).
- **UI themes** — 13 built-in light and dark themes, your own theme files and
  CSS snippets ([docs/UI-THEMES.md](docs/UI-THEMES.md)).
- **Live preview editing** (Obsidian-style) — syntax hides off the cursor line;
  editable tables, callouts, math (KaTeX / LaTeX syntax), images, and an
  editable Properties card for the frontmatter.
- **Charts & diagrams** — ` ```chart `, ` ```mermaid `, ` ```diagram ` (Fletcher)
  and ` ```draw ` (CeTZ) blocks, rendered inline and in the PDF; a gallery and
  a `/` menu to insert them.
- **Obsidian-friendly** — opens existing vaults: `[[wikilinks]]`, embeds,
  callouts, `%%comments%%`, `==highlights==`, templates with `{{date:…}}`.
  Renaming a note or folder updates the links to it.
- **Search & replace** — filters (`tag:`, `path:`, `prop:status=done`,
  `type:todo`), regular expressions, and replace across the vault with a
  preview of every change ([docs/SEARCH.md](docs/SEARCH.md)); ignores case,
  accents and letter variants.
- **Organizing** — a tag tree with tag renaming, daily notes with a calendar,
  bookmarks (Obsidian-compatible), a global quick-capture shortcut, note icons
  and cover images ([docs/ORGANIZING.md](docs/ORGANIZING.md)).
- **`/` commands with arguments** — `/table 3x4`, `/callout warning Title`,
  `/code python`, `/date`…, plus completion for tags, emoji, code languages,
  callouts and properties ([docs/SLASH.md](docs/SLASH.md)).
- **Blocks** — link to any paragraph or list item with `((`, embed notes,
  sections and blocks (`![[Note#^id]]`, also in the PDF), hover previews,
  block-level backlinks and unlinked mentions, a drag handle to move blocks,
  folding and zoom ([docs/BLOCKS.md](docs/BLOCKS.md)).
- **History & sync** — every note keeps its earlier versions (diff, restore,
  recover deleted notes), daily vault snapshots you can browse and restore,
  and end-to-end encrypted sync through a folder, WebDAV or S3
  ([docs/HISTORY.md](docs/HISTORY.md)).
- **Databases** — Obsidian Bases-compatible `.base` files and ```` ```base ````
  blocks: tables, boards (drag cards between columns), card galleries and
  lists built from note properties, with filters, formulas, sorting and
  grouping; edit cells to update the notes. ```` ```query ```` blocks show live
  search results and toggle tasks; both render in the PDF
  ([docs/DATABASES.md](docs/DATABASES.md)).
- **Flashcards** — write `Q::A`, multi-line and `==cloze==` cards in any note
  tagged `#flashcards` (Obsidian Spaced Repetition syntax); review them with
  the FSRS scheduler, by deck, with undo, a heatmap and a forecast
  ([docs/FLASHCARDS.md](docs/FLASHCARDS.md)).
- **PDF annotations** — a pdf.js viewer with find, highlights, sticky notes and
  area selections (copy as image); link to any annotation from a note
  (`[[paper.pdf#page=3&annotation=id]]`), see which notes link back; the PDF
  itself is never modified ([docs/PDF-ANNOTATIONS.md](docs/PDF-ANNOTATIONS.md)).
- **Vault tools** — outline, graph view, templates, paste/drop
  images, focus mode.
- **Built-in help** — **F1** opens the user guide
  ([docs/GUIDE.md](docs/GUIDE.md)) inside the app.
- **Plugins** — features are plugins on a public TypeScript API; add your own
  in `<vault>/.notez/plugins/` (see [docs/PLUGINS.md](docs/PLUGINS.md)).

## Install

Download a package from [Releases](https://github.com/Reodus/NoteZ/releases)
(Linux: `.rpm`, `.deb` or `.AppImage`; Windows: `NoteZ Setup <version>.exe` installer
or portable `NoteZ <version>.exe`; macOS: `.dmg` or `.zip`, `arm64` for Apple Silicon),
or build it yourself.

The macOS builds are not signed. On first launch, right-click NoteZ in
Applications → **Open** (or run `xattr -dr com.apple.quarantine /Applications/NoteZ.app`).

## Build

Requirements: Node.js 20+, Rust (stable, edition 2024), and on Fedora
`libxcrypt-compat` for building the `.rpm`/`.deb` packages.

```sh
npm install
npm run dev      # fetch fonts, build the core, start Vite + Electron (F12 = devtools)
npm run dist     # Linux packages (deb, rpm, AppImage) into release/
npm run dist:win # Windows installer + portable exe (on Windows)
npm run dist:mac # macOS dmg + zip (on a Mac)
```

Other commands:

- `npm run build` — build the UI (`dist/`) and the core (`core/bin/notez-core`)
- `npm run fonts` — download the bundled Noto fonts into `core/fonts/noto/`
  (once; pinned versions, needs internet)
- `npm start` — run Electron on the built UI
- `npm run clean` — delete build output
- `notez <vault> [note]` — open a vault (and a note) from the command line

Tip: Cargo's build folder grows to several GB. To keep it out of the project,
create `.cargo/config.toml` in the project root (it is git-ignored):

```toml
[build]
target-dir = "/home/<you>/.cache/notez/target"
```

If `npm install` skips Electron's download (npm 11 blocks install scripts), run
`node node_modules/electron/install.js`.

## Releasing

Packages are built by GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml))
when a version tag is pushed. Bump `version` in `package.json` and
`core/Cargo.toml`, commit, then:

```sh
git tag v0.4.0
git push origin main v0.4.0
```

The Linux packages, the Windows installer/portable `.exe` and the macOS `.dmg`/`.zip` appear on the
Releases page a few minutes later.
An existing tag can be rebuilt from the Actions tab (Release → Run workflow).

## Layout

- `electron/` — desktop shell: window, dialogs, file protocol, vault watcher
- `src/` — UI (SolidJS + CodeMirror 6)
- `core/` — Rust core: vault, note index, Markdown → Typst, PDF/SVG rendering.
  Runs as a helper process speaking JSON lines over stdio.
- `core/typst-packages/` — bundled Typst packages (CeTZ, Fletcher, Lilaq, MiTeX, …),
  so everything works offline
- `examples/sample-vault/` — a small vault with a sample plugin
- `examples/multilingual-vault/` — one note per script, for testing languages
- `docs/` — the user guide, also shown in the app's Help (F1)

## License

[Apache License 2.0](LICENSE). Bundled fonts and Typst packages keep their own licenses
(see the license files next to them; Vazirmatn and the Noto fonts are under the
SIL Open Font License).
