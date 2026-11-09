# PDF themes (document styles)

A **document theme** decides how a note looks: page size and margins, header
and footer, page numbers, and the paragraph styles (fonts, sizes, colors,
spacing, numbering), Word-style. The same theme styles the PDF and, as far as
it can, the editor.

- [Choosing a theme](#choosing-a-theme)
- [Built-in themes](#built-in-themes)
- [Three ways to change styles](#three-ways-to-change-styles)
- [Theme files](#theme-files)
- [Reference: top level](#reference-top-level)
- [Reference: page](#reference-page)
- [Reference: styles](#reference-styles)
- [Header and footer placeholders](#header-and-footer-placeholders)
- [How layers merge (and `null`)](#how-layers-merge-and-null)
- [Examples](#examples)
- [Typst notes](#typst-notes)
- [Tips and troubleshooting](#tips-and-troubleshooting)

## Choosing a theme

Open the note's **⋯** menu (top right) → **Themes**, or set it in the
note's properties:

```yaml
---
title: My report
theme: technical
---
```

New notes use the theme chosen in **Settings → PDF & preview** ("default"
unless you change it).

## Built-in themes

| id | Look |
|---|---|
| `default` | Clean, versatile serif layout; works for any language |
| `academic` | LaTeX-style paper: numbered sections, running header |
| `modern` | Sans-serif, airy, colorful headings: notes and handouts |
| `report` | Formal report: header rule, underlined chapter headings, page *x / y* |
| `minimal` | Black on white, no color, generous margins |
| `thesis` | Dissertation: wide binding margin, numbered chapters, 1.5 spacing |
| `book` | A5 book pages: classic serif, indents, small-caps chapters |
| `letter` | Business letter: sender in the header, airy body |
| `compact` | Two columns, small sans text: cheat sheets and study notes |
| `newspaper` | Three justified columns under a bold masthead |
| `elegant` | Refined serif, small-caps headings, gold accents |
| `technical` | Documentation: sans text, numbered sections, roomy code |
| `night` | Light text on a dark page, for reading on screen |
| `naskh` | Arabic, Persian and Urdu documents in Noto Naskh Arabic |
| `cjk` | Chinese, Japanese and Korean documents in Noto Sans CJK |
| `devanagari` | Hindi, Marathi, Nepali, Sanskrit in Noto Serif Devanagari |

Every theme works with every language. Fonts for scripts a theme doesn't
name come from the bundled fonts (see [Languages](LANGUAGES.md#fonts)).

## Three ways to change styles

1. **For one note.** In the Styles panel (right side), click a style →
   **Modify** → *Apply to: This note only*. Or **⋯ → Page setup**. The change is
   written into the note's properties (frontmatter), so it travels with the
   note.
2. **For every note that uses a theme.** Same dialogs, *Apply to: Theme "…"*.
   This saves the whole theme to `<vault>/.notez/styles/<id>.yaml`. Built-in
   themes can be changed this way too; **Themes → Reset** removes your file
   and restores the built-in look.
3. **A new theme.** **Themes → Duplicate** copies a theme under a new id, or
   write a file by hand (below).

## Theme files

Vault themes are YAML files in `<vault>/.notez/styles/`. The file name
without `.yaml` is the theme id (`my-paper.yaml` → `theme: my-paper`). A file
with the id of a built-in theme changes that built-in theme in this vault.

The smallest useful theme changes only what it needs; everything else comes
from the built-in `default` theme (or from the built-in theme with the same
id):

```yaml
# <vault>/.notez/styles/my-paper.yaml
name: My Paper
description: Libertinus with blue headings
styles:
  body: { font: Libertinus Serif, size: 11.5pt }
  h1: { color: "#1a4f9c" }
  h2: { color: "#1a4f9c" }
```

The preview updates as soon as the file is saved.

## Reference: top level

| Key | Meaning |
|---|---|
| `name` | Shown in the Themes dialog |
| `description` | One line shown under the name |
| `lang` | Language of documents using the theme (`en`, `ar`, `ja`, …). Leave it out to detect each note's language — usually what you want. A note's own `lang` wins. |
| `sample` | Language of the sample text in the Themes dialog thumbnail, for a theme made for one script (`ar`, `zh`, `hi`…). Default: `lang`, else English. |
| `page` | Page setup, see below |
| `styles` | Paragraph styles, see below |

## Reference: page

```yaml
page:
  paper: a4                  # a4, a5, a3, b5, us-letter, us-legal, … (any Typst paper name)
  orientation: portrait      # or landscape
  margin: 2.5cm              # one value, "y x", or "top right bottom left"
  columns: 2                 # 2–4 text columns
  background: "#fffdf7"      # page color
  numbering: "1"             # page number pattern
  digits: auto               # digits of page and heading numbers
  heading-digits: latin      # digits of heading numbers only (overrides digits)
  skip-first: true           # no header/footer on page 1
  header: { left: "{title}", right: "{chapter}", line: true }
  footer: { center: "{page} / {total}" }
```

- **Lengths** use `pt`, `mm`, `cm`, `in` or `em` (`2.5cm`, `11pt`, `1.2em`).
- **Page number patterns**: `"1"`, `"i"`, `"I"`, `"a"`, `"A"`, `"α"`, `"一"`,
  `"あ"`, `"가"`, and patterns with text around the counter such as
  `"- 1 -"`. `"1 / 1"` prints *page / total*.
- **Digits**: `auto`, `latin`, `arabic-indic`, `persian`, `devanagari`,
  `bengali`, `gurmukhi`, `gujarati`, `oriya`, `tamil`, `telugu`, `kannada`,
  `malayalam`, `thai`, `lao`, `khmer`, `myanmar`, `tibetan`, `mongolian`,
  `nko`, `fullwidth`. `auto` uses the document language's own digits (see
  [Languages](LANGUAGES.md#digits-in-page-and-heading-numbers)). Without
  `digits`, numbers are printed as written in the pattern.
- **Header / footer**: slots `left`, `center`, `right` and `line: true` for a
  thin rule. Each slot's direction follows its own text.

## Reference: styles

Style names: `body`, `title`, `subtitle`, `h1` … `h6`, `quote`, `code`,
`link`, `caption`. Every key is optional; a heading without `font` uses the
body's font.

```yaml
styles:
  body:
    font: New Computer Modern       # main font
    fonts:                          # fonts for other scripts
      arabic: Vazirmatn
      cjk: Noto Serif CJK SC
    size: 11pt
    weight: regular                 # thin … black, or 100–900
    italic: false
    underline: false
    smallcaps: false
    tracking: 0em                   # letter spacing
    color: "#222222"
    align: justify                  # start, end, left, center, right, justify
    line-spacing: 1.45              # Word-style: 1 = single, 1.5, 2 = double
    space-before: 0em
    space-after: 0.9em
    indent: 1.2em                   # first-line indent (body)
  h1:
    size: 18pt
    weight: bold
    numbering: "1."                 # "1.", "1.1.", "1.1.1", "I.", "A.", "a)", "α.", "第1章", "none"
    border: "#1d2b4f"               # a rule under the heading
    space-before: 1.4em
    space-after: 0.8em
  quote: { background: "#f3f5fa", border: "#7b93d1", italic: true }
  code:  { size: 9.5pt, background: "#f5f6f8", border: "#e1e4ea", font: JetBrains Mono }
  link:  { color: "#2f5fc4", underline: true }
  caption: { size: 9.5pt, color: "#5b6478", align: center }
```

| Key | Applies to | Values |
|---|---|---|
| `font` | all | a font family installed or bundled |
| `fonts` | all | map of script → font (keys in [Languages](LANGUAGES.md#choosing-your-own-font-for-a-script)) |
| `font-fa` | all | old name of `fonts.arabic` |
| `size` | all | length |
| `weight` | all | `thin`, `extralight`, `light`, `regular`, `medium`, `semibold`, `bold`, `extrabold`, `black`, or 100–900 |
| `italic`, `underline`, `smallcaps` | all | `true` / `false` |
| `tracking` | all | length, may be negative |
| `color` | all | `#rgb`, `#rrggbb`, `#rrggbbaa` or a color name |
| `align` | body, title, subtitle, headings, quote, code, caption | `start`, `end`, `left`, `center`, `right`, `justify` (body) |
| `line-spacing` | body | number, 0.5–4 |
| `space-before`, `space-after` | blocks | length |
| `indent` | body | length |
| `numbering` | h1–h6 | numbering pattern or `none` |
| `background`, `border` | quote, code (border also headings) | color |

Colors by name: `black gray silver white navy blue aqua teal eastern purple
fuchsia maroon red orange yellow olive green lime`.

## Header and footer placeholders

| Placeholder | Becomes |
|---|---|
| `{page}` | the page number, in the theme's numbering and digits |
| `{total}` | the number of pages |
| `{title}` | the note's `title` |
| `{author}` | the note's `author` |
| `{date}` | the note's `date` (`today` = today) |
| `{chapter}` | the current level-1 heading |

Any other text is printed as written: `"Page {page} of {total}"`,
`"صفحه {page} از {total}"`, `"— {page} —"`.

## How layers merge (and `null`)

A note's look is built in layers; later layers win, key by key:

1. the built-in theme with the note's theme id (or `default`),
2. your vault file `.notez/styles/<id>.yaml`,
3. the note's properties: `lang`, `page` and `styles`.

Only the keys you write change. To **remove** a value a lower layer sets,
write `null`:

```yaml
page:
  footer: { center: null, right: "{page}" }   # move the page number to the right
styles:
  h1: { numbering: null }                      # no heading numbers
```

A header or footer whose slots are all empty is not drawn.

A layer that sets `page.numbering` without `page.digits` prints its pattern
as written (that is how themes saved before NoteZ 0.6 keep their look).

## Examples

### A Persian or Arabic report

```yaml
name: Persian Report
page:
  margin: 2.5cm
  numbering: "1"
  digits: auto
  footer: { center: "صفحه {page} از {total}", line: true }
styles:
  body: { font: Vazirmatn, size: 11pt, line-spacing: 1.6, align: justify }
  h1: { size: 17pt, weight: bold, color: "#0f3d5e", numbering: "1." }
  h2: { size: 13.5pt, weight: bold, numbering: "1.1." }
```

### A Japanese handout

```yaml
name: 配布資料
lang: ja
page: { paper: a4, margin: 2cm, footer: { center: "{page}" } }
styles:
  body: { font: Noto Sans, fonts: { cjk: Noto Sans JP }, size: 10.5pt, line-spacing: 1.75, indent: 1em }
  h1: { size: 16pt, weight: bold, color: "#8c1c13", border: "#8c1c13" }
```

### Lecture notes in two columns

```yaml
name: Lecture
page:
  paper: a4
  margin: 1.5cm
  columns: 2
  header: { left: "{title}", right: "{date}", line: true }
  footer: { center: "{page}" }
styles:
  body: { font: Noto Sans, size: 9.5pt, line-spacing: 1.3, space-after: 0.4em }
  h1: { size: 13pt, weight: bold, color: "#0b5d6b", border: "#0b5d6b" }
  code: { size: 8pt }
```

## Typst notes

`.typ` notes are plain [Typst](https://typst.app/docs). A theme still applies:
put `// theme: <id>` on the first line. Its page setup and styles become Typst
`set` and `show` rules before your code, so your own `#set` rules override
them.

## Tips and troubleshooting

- **See what the engine compiles:** command palette → *View generated Typst
  source*. The theme's rules are at the top.
- **A font doesn't apply:** the name must match the family name exactly
  (pick it from the font list in the style dialog). The preview warns about
  unknown fonts.
- **"No font has … letters":** install a font for that script or name one
  under `fonts:`.
- **Back to the built-in look:** Themes → *Reset*, or delete the file in
  `.notez/styles/`.
- **Share a theme:** copy its `.yaml` file into another vault's
  `.notez/styles/`.
