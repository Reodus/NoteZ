# Writing NoteZ plugins

A plugin is a folder inside your vault:

```
<vault>/.notez/plugins/<id>/
  manifest.json   { "id": "<id>", "name": "...", "version": "1.0.0", "description": "...", "author": "..." }
  main.js         export default { onload(api) { ... }, onunload() { ... } }
```

The folder name must equal `id`. Enable it in **Settings → Plugins**. Everything you register
through `api` (commands, buttons, panels, blocks, editor extensions, event handlers) is removed
automatically when the plugin is disabled.

Full types: [`notez-plugin.d.ts`](./notez-plugin.d.ts). A complete working example is in
`examples/sample-vault/.notez/plugins/progress-bars/`.

## What you can add

| API | Example |
|---|---|
| `api.commands.register({id, title, key, run})` | appears in the command palette (Ctrl+Shift+P) |
| `api.toolbar.addButton({id, title, icon, run})` | button in the formatting toolbar |
| `api.statusBar.addItem({id, render})` | text in the status bar |
| `api.panels.add({id, title, icon, mount(el)})` | a tab in the right panel |
| `api.blocks.register({lang, toTypst, preview})` | a new ```` ```lang ```` block, shown in the editor and the PDF |
| `api.editor.registerExtension(ext)` | any CodeMirror 6 extension (use `api.editor.cm.*`) |
| `api.events.on("note:saved", fn)` | react to app events |

## New block types

`toTypst(code)` returns Typst markup that replaces the block in the PDF — any Typst is allowed,
including the bundled offline packages — import them inside your markup, e.g.
`#import "@preview/cetz:0.5.3"`, `"@preview/fletcher:0.5.8"`, `"@preview/lilaq:0.6.0"`. `preview(code)` returns HTML or SVG for the editor; it is optional,
and without it the editor shows the Typst rendering.

Use **View generated Typst source** from the command palette to debug what the engine compiles.
