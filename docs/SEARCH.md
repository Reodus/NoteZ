# Search and replace

**Ctrl+Shift+F** opens the search pane; **Ctrl+Shift+H** opens it with
*Replace* on. The **?** button shows a short syntax summary.

- [What search ignores](#what-search-ignores)
- [Search syntax](#search-syntax)
- [Results](#results)
- [Replace in the vault](#replace-in-the-vault)
- [Renaming a tag](#renaming-a-tag)

## What search ignores

Searching for words ignores case, accents on Latin, Greek and Cyrillic
letters (`cafe` finds `café`), full-width and presentation forms, and Arabic
and Persian letter variants and diacritics (see
[Languages → Search](LANGUAGES.md#search)). Folders listed in
**Settings → Files & links → Excluded folders** are not searched.

## Search syntax

Terms are separated by spaces and all must match.

| Query | Finds |
|---|---|
| `budget meeting` | lines that contain both words |
| `"budget meeting"` | the words next to each other |
| `-draft` | leaves out notes that contain *draft* |
| `/colou?r/` | lines matching a regular expression (case-sensitive) |
| `/^- \[ \]/i` | `i` after the closing `/`: ignore case |
| `tag:project` or `#project` | notes tagged `#project` or `#project/…` |
| `path:Work/2024` | notes whose path contains `Work/2024` |
| `file:review` | notes whose file name contains `review` |
| `prop:status` | notes whose properties have `status` |
| `prop:status=done` | … with the value `done` (or a list containing it) |
| `type:task` | task lines; `type:todo` open ones, `type:done` finished ones |
| `type:heading` | headings |
| `type:code` | lines inside code blocks |
| `type:quote` | quote lines |
| `type:link` | lines with a link |

Any term can be negated with `-`: `-tag:archive`, `-path:Templates`,
`-/TODO/`.

Combined:

```
tag:project type:todo -path:Archive
prop:status=reading #books
/\bv\d+\.\d+/ path:Releases
```

Filters alone (`tag:x`, `path:y`, `prop:z`) list the matching notes; with
words, a regex or `type:` they list the matching lines.

## Results

Results are grouped by note: click the note to open it, a line to jump to it,
the arrow to fold the group. Up to 500 results are shown. **Bookmark** above
the results saves the search in [Bookmarks](ORGANIZING.md#bookmarks).

## Replace in the vault

Click the replace button next to the search box (or **Ctrl+Shift+H**):

1. **Find**: the text to find. The buttons next to it: *Match case* (Aa),
   *Whole words* and *Regular expression* (.\*).
2. **Replace with**: the new text. With a regular expression, `$1`, `$2` or
   `${name}` put in what the groups matched.
3. **Only in…** (optional): note filters that limit where to replace, with
   the search syntax: `path:Work tag:draft -path:Archive`.

The list below previews every change, each match struck out with its
replacement next to it. Untick a note to leave it out. **Replace all** asks
for confirmation, then rewrites the notes; open notes show the new text.
Unsaved edits are saved before the preview and before replacing, so what you
see is what gets replaced.

Replacing works line by line: a pattern can't match across lines.

## Renaming a tag

Right-click a tag in the **Tags** pane → **Rename tag…**. The tag is renamed
in every note: `#tag` in the text and entries of the `tags:` property, and
its nested tags with it (`#work/q1` → `#job/q1` when renaming `work` to
`job`). Tags inside code and longer tags that only start the same way
(`#workshop`) are left alone.
