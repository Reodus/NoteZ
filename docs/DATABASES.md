# Databases and queries

NoteZ turns the properties of your notes (their YAML frontmatter) into
tables, boards, card galleries and lists. Nothing is stored in a separate
database: every view is computed from your notes, and editing a cell writes
the note's frontmatter.

There are three ways to show data:

| | What it is | Where |
|---|---|---|
| **`.base` file** | A database of its own, with several views | Its own tab |
| **```` ```base ```` block** | The same YAML, inside a note | Live in the note, and in the PDF |
| **```` ```query ```` block** | A one-line search (`tag:book`, `type:task`…) | Live in the note, and in the PDF |

`.base` files use the **Obsidian Bases** format, so a base made in Obsidian
opens in NoteZ and vice versa.

---

## Quick start

1. Give a few notes some properties:

   ```yaml
   ---
   author: Frank Herbert
   status: reading
   rating: 5
   tags: [book, scifi]
   ---
   ```

2. Right-click a folder → **New database**, or run **New database (.base)**
   from the command palette (Ctrl+P). The new base lists the Markdown notes
   in that folder.
3. Use the toolbar above the view:
   - **Columns**: choose properties, or add a formula.
   - **Sort**, or click a column header (A→Z, Z→A, off).
   - **Group**, by a property.
   - **Filter**: one expression for this view.
   - **Layout**: table, cards, list, board.
   - **+** adds a view. Right-click a view's tab to rename, duplicate or delete it.
4. Double-click a cell to edit it. **Enter** saves and **Esc** cancels.
   Checkboxes toggle with a click.

In a note, type `/base` (or `/base board`) for a database block, and
`/query tag:book` for a query.

---

## Base files

A base is YAML with four optional parts:

```yaml
filters:                 # which files are included
  and:
    - file.inFolder("Books")
    - file.ext == "md"
formulas:                # computed columns
  stars: '"★".repeat(rating)'
  age: (now() - file.ctime).days.round()
properties:              # display names for columns
  note.author:
    displayName: Author
  formula.stars:
    displayName: Rating
views:
  - type: table          # table | cards | list | board
    name: All books
    order: [file.name, author, status, formula.stars]
    sort:
      - property: rating
        direction: DESC
    limit: 50
  - type: board
    name: Board
    groupBy:
      property: status
      direction: ASC
    order: [file.name, author]
  - type: cards
    name: Covers
    image: cover         # the property holding the cover image
    order: [file.name, author]
```

Click **Edit source** in a base's tab to edit the YAML directly.
**Ctrl+S** or **Apply** saves it. Any toolbar change rewrites the YAML for
you and keeps your formatting and comments.

### Filters

A filter is one expression, or a list under `and:`, `or:` or `not:`.
The lists can nest:

```yaml
filters:
  or:
    - file.hasTag("book")
    - and:
        - file.inFolder("Reading")
        - 'status != "dropped"'
```

The top-level `filters` applies to every view. A view's own `filters` is
combined with it (both must match).

Quote an expression in YAML when it starts with a quote mark or contains
`: `, `#` or `!`, e.g. `'status != "done"'`.

### Views

| Key | Meaning |
|---|---|
| `type` | `table`, `cards`, `list` or `board` |
| `name` | The tab's name |
| `order` | The columns, in order (`file.name`, `status`, `note.status`, `formula.x`) |
| `sort` | A list of `{ property, direction: ASC \| DESC }` |
| `groupBy` | `{ property, direction }`: a section (or a board column) per value |
| `limit` | At most this many rows |
| `filters` | Extra filters for this view |
| `image` | Cards: the property with the cover image (a path, `[[image.png]]` or a URL) |

**Board** is a kanban: one column per value of the `groupBy` property. Drag a
card to another column, and NoteZ sets that property in the note. A board
needs a group: choose **Group** in the toolbar.

**Cards** show the cover image when `image:` names a property. Without it,
cards are text only.

Notes have no fixed column order. When `order` is missing, a view shows the
file name followed by the properties found in the matching notes.

---

## Expressions

The syntax is the one Obsidian Bases uses.

### Values

- Properties of the note: `status`, `note.status`, `note["due date"]`
- Formulas: `formula.stars`
- File data: `file.name`, `file.basename`, `file.path`, `file.folder`,
  `file.ext`, `file.size`, `file.ctime`, `file.mtime`, `file.tags`,
  `file.links`, `file.backlinks`, `file.embeds`, `file.properties`
- `this`: the note showing the base. In a `.base` tab it is the base itself;
  for a block or an `![[x.base]]` embed it is the note containing it. So
  `file.hasLink(this.file)` lists the notes that link here.
- Literals: `"text"`, `'text'`, `42`, `3.5`, `true`, `false`, `null`,
  lists `[1, 2]`, regular expressions `/^draft/i`

### Operators

`+ - * / %`, `== != < <= > >=`, `&& || !` (also `and`, `or`, `not`), and
`condition ? a : b`.

- Dates minus dates give durations: `(now() - file.mtime).days`.
- Dates plus strings shift them: `date(due) + "1 week"`.
- `+` joins strings.

### Functions

| Function | Result |
|---|---|
| `if(cond, a, b)` | `a` when `cond` is true, else `b` (or null) |
| `now()`, `today()` | The current date and time; today at midnight |
| `date("2026-11-09")` | A date (also `2026-11-09 14:30`) |
| `duration("3 days")` | A duration: `ms s m h d w mo y` and their long names |
| `number(x)`, `string(x)`, `list(x)` | Conversions |
| `link("Note", "text")` | A link |
| `file("path")` | A file, to read its `file.*` data |
| `min(a, b, …)`, `max(a, b, …)` | Smallest and largest value |

### Methods

**Any value:** `isEmpty()`, `isTruthy()`, `isType("string")`, `toString()`

**Files:** `file.hasTag("a", "b")` (nested tags count: `#a/b` has `a`),
`file.inFolder("Books")` (subfolders count), `file.hasProperty("x")`,
`file.hasLink("Note")` (alias `linksTo`), `file.asLink("text")`

**Strings:** `length`, `contains()`, `containsAll()`, `containsAny()`,
`startsWith()`, `endsWith()`, `lower()`, `upper()`, `title()`, `trim()`,
`reverse()`, `repeat(n)`, `slice(a, b)`, `split(sep)`,
`replace(a, b)` / `replaceAll(a, b)` (also with a `/regex/`),
`matches(/regex/)`, `date()` (parse)

**Numbers:** `abs()`, `ceil()`, `floor()`, `round(digits)`, `toFixed(digits)`

**Dates:** `year`, `month`, `day`, `hour`, `minute`, `second`,
`format("YYYY-MM-DD")`, `date()` (drop the time), `time()`,
`relative()` (“3 days ago”)

**Durations:** `days`, `hours`, `minutes`, `seconds`, `milliseconds`

**Lists:** `length`, `contains()`, `containsAll()`, `containsAny()`,
`join(", ")`, `reverse()`, `sort()`, `unique()`, `flat()`, `slice(a, b)`,
`filter(value > 2)`, `map(value * 2)` (inside them, `value` is the item and
`index` its position)

**Objects:** `keys()`, `values()`

**Regular expressions:** `/x/.matches("text")`

The format tokens follow Moment.js: `YYYY YY MMMM MMM MM M DD D dddd ddd
HH H hh h mm ss A a`, and `[text]` for literal text.

### Formulas

A formula is an expression with a name, shown as a column `formula.name`.
Formulas can use other formulas. A loop (`a` uses `b`, `b` uses `a`) shows
an error in that cell and doesn't break the view.

```yaml
formulas:
  pages_left: pages - pages_read
  progress: (pages_read / pages * 100).round() + "%"
  overdue: if(due && date(due) < today(), "⚠ overdue", "")
```

Errors (an unknown function, a bad comparison…) appear in the cell, with a
summary in the view's footer. The rest of the view still works.

---

## Editing data from a view

- **Double-click** a property cell to edit it. The value is typed by what
  you enter:
  - `12` and `3.5` become numbers, `true` and `false` become booleans.
  - In a list property, commas separate the items: `book, scifi`.
  - An empty value removes the property.
- **Checkboxes** (true/false properties) toggle with a click.
- **Board:** drag a card to another column.
- **Task lines** in a query: click the checkbox to tick the task in its note.

`file.*` and formula columns are computed, so you can't edit them.

A note that is open in a tab is changed in that tab and saved; other notes
are changed on disk. File history records these saves like any other
([History](HISTORY.md)).

---

## Database blocks in a note

````markdown
```base
filters: 'status == "reading"'
views:
  - type: list
    name: Reading now
    order: [file.name, author]
```
````

The block shows the live view. Its toolbar works as in a `.base` tab and
rewrites the block's YAML. Click the **base · edit** label to edit the source.

To show a base file inside a note, embed it, optionally naming a view:

```markdown
![[Reading.base]]
![[Reading.base#Board]]
```

---

## Query blocks

A query block runs a search ([Search syntax](SEARCH.md)) and lists what
matches:

````markdown
```query
tag:book prop:status=reading
```
````

Searches that match lines (`type:task`, `type:heading`, `"a phrase"`, a word)
list each note with its matching lines. Task checkboxes in that list toggle
the task in the note. Searches that match whole notes (`tag:`, `path:`,
`prop:`) list the notes.

Options go on their own lines after the search:

| Option | Meaning |
|---|---|
| `view: table` | `lines`, `list`, `table`, `cards`, `count` (`show:` also works) |
| `columns: author, rating` | The columns for table, cards and list |
| `sort: rating desc` | Sort by a column |
| `limit: 10` | At most this many notes |
| `group: status` | Group by a property |

````markdown
```query
type:task -"[x]" path:Projects
limit: 20
```

```query
tag:book
view: table
columns: author, rating, status
sort: rating desc
```

```query
tag:inbox
view: count
```
````

---

## In the PDF

Base blocks, query blocks and embedded bases are rendered when the PDF is
made, with the data as it is at that moment:

- Tables, cards and boards become a table, with a header row per group.
- Lists become a bulleted list.
- Task lines show ☐ and ☑.
- `count` becomes the number.

The preview refreshes when notes change.

---

## Compatibility with Obsidian

The `.base` format, the expression language and the view keys match Obsidian
Bases. Things to know:

- Obsidian's view-specific settings that NoteZ doesn't use (column widths,
  row height…) are kept in the file untouched.
- Obsidian's `map` and plugin views show as tables in NoteZ.
- Summaries (`summaries:`) are kept but not shown yet.
- `html()`, `image()` and `icon()` show their text.
