# Slash commands and completion

## The / menu

Type `/` at the start of a line or after a space. A menu of things to insert
opens; keep typing to filter it, **↑ ↓** to choose, **Enter** to insert,
**Esc** to close.

The menu finds commands by their name, by other English words and by words
in many other languages: `/table`, `/جدول`, `/tabla`, `/表格`, `/तालिका` all
find *Table*.

### Commands with arguments

Some commands take arguments, typed after the command name:

```
/table 4x3
/callout warning Read this first
/code python
```

- **Tab** on a command in the menu writes `/command ` so you can type its
  arguments; **Enter** inserts it right away with the defaults.
- While you type, the arguments still missing appear in grey after the
  cursor: `/callout ‹type› ‹title›`.
- Arguments with known values are completed: callout types, code languages,
  chart kinds, note names, tags, emoji names, date formats, language codes.
- The last argument takes the rest of the line (so a title can have spaces).
- **Enter** runs the command with what you typed.

| Command | Arguments | Inserts |
|---|---|---|
| `/text`, `/h1`, `/h2`, `/h3` | | normal text, headings |
| `/heading` | level 1–6 | a heading of that level |
| `/bullet`, `/numbered`, `/todo` | | lists, a task list |
| `/quote`, `/divider` | | a quote, a horizontal rule |
| `/table` | rows×columns (`3x4`, `3 4`) | a table with a header row |
| `/code` | language | a code block |
| `/link` | note or URL | `[[note]]` or `<https://…>`; no argument: a Markdown link |
| `/embed` | note or file | `![[note]]` (a note or image shown inline) |
| `/footnote` | | a footnote reference and its text |
| `/tag` | tag | `#tag` |
| `/emoji` | name | the emoji (`/emoji rocket` → 🚀) |
| `/math`, `/inline-math` | | display or inline math |
| `/callout` | type, title | a callout (`note`, `tip`, `warning`, `danger`…) |
| `/note`, `/tip`, `/warning`, … | | a callout of that type |
| `/chart` | kind: bar, grouped, hbar, line, area, scatter, pie, donut | a chart |
| `/diagram` | kind: flow, flow-lr, mindmap, timeline, graph, seq, gantt, shapes, axes | a diagram |
| `/flowchart`, `/mindmap`, `/timeline`, `/mermaid`, `/shapes` | | that diagram |
| `/gallery` | | the diagram gallery |
| `/center` | | a centered block |
| `/columns` | count 2–4 | a block in columns |
| `/ltr`, `/rtl` | | a block with a fixed direction |
| `/lang` | language code | a block in another language (`::: {lang=ja}`) |
| `/pagebreak`, `/toc` | | a page break, a table of contents |
| `/today`, `/tomorrow`, `/yesterday` | | the date, `YYYY-MM-DD` |
| `/date` | format | today in any [date format](ORGANIZING.md#daily-notes-and-the-calendar) |
| `/time` | format | the time (`HH:mm` by default) |
| `/now` | | date and time |
| `/daily` | | a link to today's daily note |

In Typst notes the menu offers the commands that make sense there and
inserts Typst markup.

Plugins can add commands (see [Writing plugins](PLUGINS.md#slash-commands)).

## Completion as you type

| Type | Suggests |
|---|---|
| `[[` | notes (and their aliases); `[[note#` its headings |
| `#` and a letter | tags used in the vault |
| `:` and two letters | emoji by name: `:tada` → 🎉 |
| ```` ``` ```` at the start of a line | code block languages, NoteZ blocks first (`chart`, `mermaid`…) |
| `> [!` | callout types |
| in the properties, at the start of a line | property names (`title`, `tags`, `lang`, `theme`, `icon`, `cover`…) |
| `theme: ` / `lang: ` / `tags: ` | document themes / language codes / tags |
| `{{` in a template | template variables (`title`, `date`, `date:FORMAT`…) |
| `#` in a Typst note | Typst functions and keywords |

**Ctrl+Space** opens completion where it doesn't open by itself.
