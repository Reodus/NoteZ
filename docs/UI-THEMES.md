# UI themes and CSS snippets

The **UI theme** is the look of the app itself: sidebar, editor, panels,
menus. (The look of your documents and PDFs is a
[document theme](PDF-THEMES.md).) You can pick a built-in theme, install
someone else's, write your own, and add small CSS **snippets** that tweak
anything.

- [Choosing a theme](#choosing-a-theme)
- [Built-in themes](#built-in-themes)
- [Writing a theme](#writing-a-theme)
- [Design tokens](#design-tokens)
- [Going further: styling parts of the app](#going-further-styling-parts-of-the-app)
- [CSS snippets](#css-snippets)
- [Where theme files live](#where-theme-files-live)
- [Developing and debugging](#developing-and-debugging)

## Choosing a theme

**Settings → Appearance**:

- **Mode**: *Light*, *Dark*, or *System* (follows your desktop's setting).
- **Light theme** / **Dark theme**: the theme used in each mode. With *System*
  the app switches between the two automatically.
- **Accent color**: *Theme* uses the accent the theme comes with; pick a dot
  or a custom color to override it.

The sun / monitor / moon buttons at the bottom of the sidebar switch the mode
too.

## Built-in themes

| Light | Dark |
|---|---|
| Light (default) | Dark (default) |
| Arctic — frosted blues and greys | Arctic Night — polar-night slate |
| Paper — warm sepia | Forest — deep greens, amber |
| Rose — blush and plum | Grape — purple with vivid syntax colors |
| Solar Light — cream and teal | Solar Dark — deep blue-green |
| High Contrast Light | Midnight — true black for OLED |
| | High Contrast Dark |

## Writing a theme

A theme is one `.css` file. It starts with a comment that describes it, then
sets **design tokens** (CSS custom properties) inside `:root { … }`:

```css
/* @name Ocean
   @mode dark
   @description Deep sea blues with a cyan accent.
   @accent #00b4d8 */
:root {
  --bg: #031a26;
  --surface: #06293a;
  --surface-2: #08304a;
  --sidebar: #041f2e;
  --border: #0d3a52;
  --border-strong: #165070;
  --fg: #e0f4ff;
  --fg-soft: #bfe1f2;
  --fg-muted: #7fa9c0;
  --fg-faint: #4d7690;
  --canvas: #021219;
}
```

Save it as `ocean.css` in a themes folder (see
[where theme files live](#where-theme-files-live)). It appears in
**Settings → Appearance** right away, under *Dark theme* because of
`@mode dark`.

The header fields:

| Field | Meaning |
|---|---|
| `@name` | Name shown in Settings (default: the file name) |
| `@mode` | `light` or `dark`. The theme is built on top of the default light or dark palette, so you only set what you want to change. It also tells charts, diagrams and code which palette to use. |
| `@description` | Shown when you hover the theme card |
| `@accent` | Default accent color (`#rrggbb`), used when the accent setting is *Theme* |

The theme id is the file name without `.css` (lowercase; other characters
become `-`). A vault theme with the same id as a global or built-in one
replaces it in that vault.

How it works: NoteZ wraps the whole file in
`:root[data-ui-theme="<id>"] { … }` (CSS nesting) and replaces `:root` inside
it with that selector. So `:root { … }` sets tokens, and any other rule in the
file applies only while your theme is active. `@import` and `@font-face`
rules are moved to the top level automatically.

## Design tokens

Everything in the app is drawn from these tokens. Unset tokens keep the
default light or dark value.

### Surfaces and text

| Token | Used for |
|---|---|
| `--bg` | Window background behind panels |
| `--surface` | Panels, the editor, dialogs, menus |
| `--surface-2` | Slightly raised areas: inputs, cards, table headers |
| `--sidebar` | The file tree / sidebar |
| `--canvas` | Behind the PDF pages and the graph view |
| `--border` | Hairlines between areas, input borders |
| `--border-strong` | Hovered or emphasized borders |
| `--fg` | Main text |
| `--fg-soft` | Secondary text (headings in lists, labels) |
| `--fg-muted` | Hints, inactive tabs, icons |
| `--fg-faint` | Placeholders, disabled items, line numbers |
| `--hover` | Background of hovered items |
| `--hover-strong` | Background of pressed / selected items |
| `--code-bg` | Inline code background |

### Accent and status

| Token | Used for |
|---|---|
| `--accent` | Buttons, links, selection, focus rings, active tab line (set by the accent setting; prefer `@accent`) |
| `--accent-rgb` | The accent as `r, g, b` (set automatically) |
| `--accent-2` | A second accent mixed from the first (gradients) |
| `--accent-soft`, `--accent-softer` | Tinted accent backgrounds (active rows, chips) |
| `--accent-fg` | Text on accent-colored buttons (white by default; use a dark color for light accents) |
| `--danger`, `--success`, `--warning` | Errors, success marks, warnings |

### Syntax colors (code blocks and Typst notes)

| Token | Used for |
|---|---|
| `--syn-keyword` | Keywords (`if`, `let`, `#set`) |
| `--syn-func` | Function names |
| `--syn-string` | Strings |
| `--syn-number` | Numbers |
| `--syn-atom` | Constants, booleans, special values |
| `--syn-type` | Types and classes |

### Shape, depth and type

| Token | Default |
|---|---|
| `--radius-sm`, `--radius`, `--radius-lg` | `6px`, `9px`, `14px` corner radii |
| `--shadow-sm`, `--shadow-md`, `--shadow-lg` | Shadows of cards, popovers and dialogs |
| `--ease` | Animation easing curve |
| `--font-ui` | Interface font stack |
| `--font-editor` | Editor font stack (the *Editor font* setting overrides it) |
| `--font-mono` | Code font stack |
| `--font-scripts` | Bundled fallback fonts for every script; keep it at the end of your own stacks: `--font-ui: "IBM Plex Sans", var(--font-scripts), sans-serif;` |

## Going further: styling parts of the app

Any CSS rule in a theme file applies while the theme is active. Useful
selectors:

| Selector | Part |
|---|---|
| `.sidebar` | Left sidebar |
| `.tree-item` | A row in the file tree |
| `.tabbar`, `.tab`, `.tab.active` | Note tabs |
| `.toolbar` | Formatting toolbar |
| `.editor`, `.cm-content`, `.cm-line` | The editor and its lines |
| `.cm-nz-h1` … `.cm-nz-h6` | Headings in the editor |
| `.cm-nz-quote`, `.cm-nz-callout` | Quotes and callouts |
| `.right-panel` | Preview / Styles / Outline / Links panel |
| `.statusbar` | Status bar |
| `.modal` | Dialogs |
| `.menu` | Context menus and popovers |

```css
/* @name Notebook
   @mode light */
:root { --surface: #fffef8; }

/* Ruled paper behind the editor text */
.cm-content {
  background-image: repeating-linear-gradient(transparent 0 calc(1.85em - 1px), #dfe6f0 calc(1.85em - 1px) 1.85em);
}
.cm-nz-h1 { font-family: "Libertinus Serif", var(--font-scripts), serif; }
```

Class names other than the tokens may change between versions; tokens are
the stable part.

## CSS snippets

A **snippet** is a small CSS file you switch on and off on top of any theme:
a font, a wider editor, hidden toolbar buttons…

1. Put a `.css` file in a snippets folder (below).
2. Turn it on in **Settings → Appearance → CSS snippets**.

Snippets are added as-is (not wrapped), so they apply to every theme:

```css
/* wide-editor.css: use more of the window for text */
.editor.readable .cm-content { max-width: 960px; }
```

```css
/* my-font.css: another interface font, with fallbacks for every script */
:root { --font-ui: "IBM Plex Sans", var(--font-scripts), sans-serif; }
```

## Where theme files live

| Folder | Applies to |
|---|---|
| `<vault>/.notez/themes/` | this vault only |
| `<vault>/.notez/snippets/` | this vault only |
| `<config>/themes/` | every vault |
| `<config>/snippets/` | every vault |

`<config>` is the app's settings folder: `~/.config/NoteZ` on Linux,
`%APPDATA%\NoteZ` on Windows, `~/Library/Application Support/NoteZ` on
macOS. **Settings → Appearance** has buttons that open (and create) each
folder.

Changes are picked up as soon as you save a file; **Reload** re-reads them
all.

## Developing and debugging

- Run NoteZ from source (`npm run dev`) and press **F12** for the developer
  tools: inspect any element to find its class, and edit tokens live on
  `<html>` in the Styles pane.
- The default token values are at the top of `src/styles/app.css`; the
  built-in themes are in `src/styles/themes/` and make good starting points.
- A theme that doesn't show up: check that the file ends in `.css` and the
  header comment is the first thing in the file.
- A theme that half-applies: a CSS syntax error stops the rest of the file;
  the developer tools' console shows where.
