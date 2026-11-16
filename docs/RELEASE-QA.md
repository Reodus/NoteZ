# 1.0.0 release verification

All interactive tests use disposable vaults and an isolated Electron configuration. They do not open the user's notes. `scripts/test-ui.mjs` prints the temporary artifact directory, including table screenshots and PDF/Word/HTML exports, for inspection.

## Reproduced issues and regression coverage

| Issue | Reproduction | Required result |
| --- | --- | --- |
| Failed save closes a tab | Edit a note, reject its write, close tab/vault or switch vault | Operation rejects and the dirty buffer remains |
| Native exit races saving | Type, then close; repeat with a failed write | Successful close persists the latest edit; failure keeps the window open |
| Cursor leaves a moved block | Drag `AAA` below `BBB` | Selection remains inside `AAA` |
| Moving detaches comments | Comment `AAA`, move it, undo and redo | Quote, anchor and text stay together |
| Grips miss rendered tables | Hover English and Persian tables in Live mode | Grip sits outside the table on its reading-start side |
| Drag leaves stale state | Start a drag, scroll near an edge, press Escape | Autoscroll works; cancellation leaves text intact and removes indicators/cursor state |
| Nested bookmark deletion fails | Put a group inside another group, then delete it | The nested group is removed |
| Duplicate group names confuse moves | Move a leaf between groups with the same title | Only the selected destination receives it |
| Quick resize drops the final width | Release before requestAnimationFrame executes | Final width is committed in LTR and RTL |
| Failed image/file paste removes selection | Select source text and reject attachment import | Original text remains intact |
| Import lands in a different tab | Start attachment import, immediately switch tabs | Link is inserted only in the original note |

## Note navigation and scrolling follow-up

A long-note regression reproduced a viewport change from 1985px to 1232px after switching tabs, and a delayed line-101 jump landing in a different note. Per-tab CodeMirror scroll snapshots now preserve the visible location. Cached states are patched for external edits and mapped to the changed document; caches are reset between vaults. Pending focus/line/table callbacks are cancelled or checked against the current note/state.

`scripts/scroll-cases.mjs`, invoked by the Electron suite, covers tab switching without moving the cursor, Source/Live editor remounts via an image tab, hidden-note disk edits, delayed line navigation and an old slow read racing an actual tab click. Virtual height estimates may change the absolute scrollTop after remounting, so those cases assert the same visible paragraph rather than an arbitrary pixel offset.

## Automated checks

- `npm run test:asm`: six assembly dialects.
- `npm run test:dir`: 13 direction cases shared with PDF behavior.
- `npm run test:comments`: UTF-16 positions, document edits, external re-anchoring and safe PDF metadata injection.
- `npm run test:stability`: real CodeMirror transactions/history, bookmark trees, serial writes/retry and resize cancellation cleanup.
- `npm run test:ui`: real Electron/CDP mouse dragging, rendered table grips, autoscroll/Escape, Source/Live modes at 900/1280 pixels, tab/file dragging, rename/move/link resolution, attachment failures and tab switches, exports, search, history restore, deletion recovery, encrypted folder sync and failed/native closing.
- `NOTEZ_TEST_LANGUAGE=fa npm run test:ui`: the same suite with the Persian RTL interface.
- `npx tsc --noEmit`, `node --check` for Electron entrypoints, `git diff --check`, and `npm run build`.
- `cargo test --manifest-path core/Cargo.toml --lib --offline`: 104 passed, 5 intentionally ignored. The added atomic-write regression also covers concurrent replacement and cleanup after a failed replacement.

Rendered table screenshots are inspected for grip/text overlap, checkbox and gutter separation, and correct LTR/RTL placement. The UI suite checks native shutdown persistence by reading the saved file after Electron exits.

## Platform and integration limits

Interactive verification runs on Linux/X11; CI uses Xvfb. The existing Windows/macOS build jobs remain responsible for their platform builds. The tests exercise encrypted folder sync; they do not require live WebDAV/S3 credentials. Existing optional/credential-dependent Rust tests remain ignored. Packaging is prepared locally; this document does not assert a published GitHub release or successful remote workflow run.
