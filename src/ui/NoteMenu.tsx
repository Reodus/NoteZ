// The "⋯" menu of the open note (like Obsidian's view menu): export, PDF
// page/theme setup and the file actions, so the formatting toolbar only
// holds formatting.
import { Show } from "solid-js";
import { MoreVertical, FileDown, FileCode, Palette, FileCog } from "lucide-solid";
import { app } from "../core/app";
import { setDialog, state } from "../core/store";
import { isNotePath } from "../core/ipc";
import { exportPdf } from "../core/render";
import { MenuItem, openMenuAt } from "./primitives";
import { docThemeId } from "./StyleDialogs";
import { entryFor, fileMenu } from "./fileMenu";

type Item = MenuItem | "-";

export function noteMenuItems(path: string): Item[] {
  const items: Item[] = [];
  if (isNotePath(path)) {
    if (app.commands.has("pdf.export")) {
      items.push({ label: "Export to PDF…", icon: <FileDown size={15} />, hint: "Ctrl+Shift+S", run: () => void exportPdf(path) });
    }
    if (app.commands.has("pdf.typst")) {
      items.push({ label: "View generated Typst", icon: <FileCode size={15} />, run: () => app.commands.run("pdf.typst") });
    }
    items.push(
      "-",
      { label: "Document theme…", icon: <Palette size={15} />, hint: docThemeId(), run: () => setDialog({ kind: "themes" }) },
      { label: "Page setup…", icon: <FileCog size={15} />, run: () => setDialog({ kind: "page" }) },
      "-",
    );
  }
  // The file menu has its own export entry; ours is at the top already.
  const file = fileMenu(entryFor(path), "tab").filter((i) => i === "-" || i.label !== "Export to PDF…");
  items.push(...file);
  // No leading / doubled separators.
  return items.filter((it, i, a) => it !== "-" || (i > 0 && a[i - 1] !== "-"));
}

export function NoteMenuButton(props: { class?: string }) {
  return (
    <Show when={state.active}>
      {(path) => (
        <button
          class={props.class ?? "icon-btn"}
          title="More options"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenuAt(Math.max(8, r.right - 220), r.bottom + 4, noteMenuItems(path()));
          }}
        >
          <MoreVertical size={17} />
        </button>
      )}
    </Show>
  );
}
