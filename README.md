# NoteZ

Bilingual (Persian + English) notes with LaTeX-quality PDF export via embedded Typst.

- `electron/` — desktop shell (window, dialogs, file protocol)
- `src/` — UI (Solid + CodeMirror 6)
- `core/` — Rust core: vault, Markdown → Typst, PDF/SVG rendering. Runs as a helper process speaking JSON lines over stdio.

## Commands

- `npm run dev` — build the core, start Vite and Electron (F12 = devtools)
- `npm run build` — build UI (dist/) and core (release)
- `npm start` — run Electron on the built UI
- `npm run dist` — packages (deb, rpm, AppImage) into `release/`
- `notez <vault> [note]` — open a vault (and note) from the command line
