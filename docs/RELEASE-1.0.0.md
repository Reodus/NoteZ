# NoteZ 1.0.0

This release stabilizes editing, drag and drop, persistence and review comments.

## Editing and moving

- Reading positions survive tab switches and returns from image/PDF tabs. Disk reloads map the viewport anchor instead of resetting the editor. Superseded note loads and delayed line jumps cannot steal navigation.

- Block grips remain hover-only and follow the rendered block's reading direction, including editable tables, task markers and mixed Persian/English notes.
- Moving a block keeps its cursor/selection and comments. Undo and redo restore comment anchors along with the text.
- Block dragging supports edge autoscroll and cancels cleanly on Escape, pointer cancellation, lost capture, blur or editor destruction.
- File, tab, bookmark and board drops accept their own payload types and clear destination indicators when leaving or ending a drag. Invalid file/bookmark destinations are rejected.
- Nested bookmark groups can be deleted and reordered without confusing groups with identical names. Dropping an already-bookmarked file does not remove its bookmark.
- Preview size updates are deferred outside ResizeObserver notifications to avoid resize loops.
- Fast panel resizing commits the final pointer position even before the next animation frame.

## Persistence

- A failed save keeps the note, tab and vault open. Native close/quit waits for the renderer's save acknowledgement while the core remains running.
- Writes to each file execute in order. Failed side-file writes remain available for retry before leaving the vault.
- Notes, comment sidecars, annotations and history metadata use atomic replacement through a unique temporary file. Existing file permissions are preserved.
- Pending PDF annotations and attachment imports participate in save barriers. A failed file paste retains its selected source text; switching tabs while importing cannot insert the attachment into a different note.
- Deletion saves edits first and closes tabs after the filesystem operation succeeds, retaining recovery history.

## Comments

Comments on Markdown and Typst notes live in `.notez/comments/`, separate from source files. The Comments panel provides replies, resolve/reopen, filters, reattachment and Copy as prompt. Open Markdown comments can optionally appear in PDF margins; Typst comments remain panel-only. Word, HTML and Markdown exports stay free of comment metadata. See [COMMENTS.md](COMMENTS.md).

## Distribution

Version manifests and lockfiles use `1.0.0`. The existing GitHub Actions release workflow builds the platform packages. Linux CI additionally runs editor regression tests and isolated Electron smoke tests under Xvfb in English and Persian.
