# Note comments

Select text, or place the cursor on a line, then use **Add comment** in the editor context menu or press **Ctrl+Alt+M** (Cmd+Alt+M on macOS). The Comments tab opens with a focused draft. Markdown and Typst notes both support comments.

The panel shows the quoted selection, an editable body, replies, Resolve/Reopen and Delete. Filter by open, resolved or all comments. Click a line chip to jump to its source. The gutter marker opens its card; the status bar shows the number of open comments. The command palette also offers Show comments, Copy comments as prompt, Next comment and Previous comment. Settings → Plugins can disable Comments.

**Copy as prompt** copies open threads with their source lines and quotes. Resolved threads remain stored and can be reopened.

## Storage and anchors

Comments are stored only in `.notez/comments/<note path>.json`, using version 1 of the sidecar format. Adding, editing or resolving a comment never modifies the note's `.md` or `.typ` source. Lines are 1-based and columns are UTF-16 offsets, starting at zero. Sidecars are included in normal vault sync.

While typing, CodeMirror maps the selected range through document changes and updates its quote. When loading or externally reloading a note, quotes relocate comments to the closest matching line. If no match remains, the card is marked detached and retains its old quote. Select replacement text and click **Attach to selection** to reconnect it.

Renaming a note or folder inside NoteZ moves its sidecars. Deleting a note retains its comments so restoring the note at its original path recovers them. External filesystem renames do not relocate sidecars.

## PDF margins

Settings → Comments → **Show open comments in PDF margins** is off by default. When enabled, Markdown previews and PDF exports include numbered margin notes and replies. Metadata is injected into the render input only; source files and line counts are preserved. The Typst `drafting` 0.2.2 package is vendored with its license.

Markers inside frontmatter, tables, fenced code, math or HTML are moved to the next safe line. If no safe line remains, that comment stays in the panel. Typst comments are panel-only, with a preview notice. Word, HTML and Markdown exports receive the original document without comment metadata.

## Verification

- `npm run test:comments` checks UTF-16 anchors, insertions, deletions, external re-anchoring and safe PDF injection.
- `npx tsc --noEmit` checks the frontend.
- `cargo test --manifest-path core/Cargo.toml --lib` includes sidecar file/folder renames and LTR/RTL PDF margin-note compilation.
- `npm run build` builds the UI, fonts and core.
