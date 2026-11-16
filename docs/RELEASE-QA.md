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

## Post-release Live scrolling investigation

The earlier navigation tests did **not** verify continuous reading of a long mixed Persian/English note. They established fixes for tab/navigation jumps, not for every report of jumping within Live preview.

The supplied 588-line note exposed two interacting layout problems:

- Recreated image widgets briefly lost their dimensions. On an upward 400px wheel step, the same text moved as much as 1076px in a copy with replacement images. Missing-asset labels also collapsed during asynchronous resolution (a separate 25px shift in the supplied note without assets). Known image dimensions and missing labels are now restored synchronously; missing assets are still retried and the cache is scoped by vault and note.
- Viewport-only styles were removed from CodeMirror's retained offscreen cursor line. Its font size changed, invalidating measured paragraph heights. Short styled code lines could also be mistaken for the default text metric sample. In a narrow editor, repeated metric changes left the height model inconsistent with the rendered lines, and coordinate lookup threw. Height-affecting styles now live in a document state field; styled headings/code/markers use a text wrapper so they are not sampled as unstyled body text. No CodeMirror internals or dependency versions are patched.

`npm run test:reading` uses a synthetic mixed-direction note with long wrapped paragraphs, headings, code, present images and a missing image. It sends native CDP wheel input in both directions at 1280/900px (including fractional device scaling), measures the same text position before and after each step, verifies offscreen cursor styles, clicks/types/undoes, checks missing-image recovery, and verifies the saved Markdown is unchanged. Geometry-loop warnings fail the test. The first version of the test failed on the old code with a 118.6px excess movement; increasing the tolerance was not used to hide the failure.

Optional local reproduction (only a copy is edited):

```sh
NOTEZ_SCROLL_FILE='/absolute/path/to/note.md' npm run test:reading
NOTEZ_TEST_LANGUAGE=fa NOTEZ_SCROLL_IMAGES=1 NOTEZ_SCROLL_FILE='/absolute/path/to/note.md' npm run test:reading
NOTEZ_READING_MODE=source NOTEZ_SCROLL_FILE='/absolute/path/to/note.md' npm run test:reading
```

`NOTEZ_SCROLL_IMAGES=1` supplies repository-icon stand-ins for bare PNG embeds in the temporary vault; it does not reconstruct the original attachments. The user's note and its contents are not committed. Logs, text-anchor traces and screenshots stay in the printed temporary artifact directory. Initial font loading and window resizing settle before wheel measurements; this suite does not claim to freeze layout while a user deliberately changes fonts or window dimensions.

The supplied note with image stand-ins passed 524 wheel steps and 14 click/type/undo cases in the Persian interface across both widths on Linux. Final checks also passed 336 Live wheel steps without the attachments at 900px, 180 Source wheel steps at 1280px, and seven click/type/undo cases in each. The synthetic fixture passed 264 steps plus image aspect-ratio and missing-asset recovery checks.

The general Persian smoke suite passed its interaction, persistence and export assertions. Its rapid Source tab/remount setup still emits two `Measure loop restarted more than 5 times` warnings; the visible-paragraph preservation assertions pass. These are recorded separately from the continuous-reading test, which fails on geometry-loop warnings and emitted none. This follow-up does not assert that every possible layout warning has been eliminated.

CI now includes the reading test on Windows as well as Linux/Xvfb. A locally passing Linux run is not a claim that the Windows job has run or that the friend's exact Windows setup has been verified.

## 1.0.2 CI startup correction

The Windows 1.0.1 reading job failed before exercising the editor: CDP attached while the initial application document was still loading, and `/src/core/store.ts` was imported from a context without the Vite origin. The harness now waits for a page target and for the expected application origin with a complete document before importing editor modules, including after the Persian-language reload. Only context-replacement errors during navigation are retried; actual module/application errors still fail. CI deliberately delays initial HTML by 1500ms to exercise this startup ordering. Failure diagnostics (stderr, exception details, screenshots and reading traces) are uploaded as artifacts on both platforms.

## 1.0.3 reading-test click destination

The Windows 1.0.2 job completed the 1280px wheel test, then failed the `line 74 must be reachable for editing` assertion. The harness scrolled the paragraph's start but tried to click 20 characters later after a fixed 250ms delay. It now scrolls that exact target character and waits up to five seconds for coordinates inside the editor. Failure still fails the test and records geometry; no paragraph is skipped. A further assertion checks the real click lands in the requested paragraph before typing. A narrow 900px run with `NOTEZ_READING_FONT_SIZE=22` passed 298 wheel steps and four click/type/undo cases, exercising paragraphs taller than the viewport.

During local validation of this harness-only change, one complete run also failed a separate upward wheel assertion at line 80 before the edit checks (trace `/tmp/notez-ui-ikXPL5/reading-1280.json`). The wheel thresholds/checks are unchanged. This click-destination correction does not claim to resolve that intermittent wheel failure.
