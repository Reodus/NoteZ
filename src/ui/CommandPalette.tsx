import { createMemo, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { FileText, FileCode2, TerminalSquare, CornerDownLeft } from "lucide-solid";
import { app } from "../core/app";
import { notesList, openNote, setDialog, createNote, PickItem, newNoteDir, prefs } from "../core/store";
import { stem, dirname } from "../core/ipc";

/** Subsequence fuzzy score (higher is better), -1 if no match. */
export function fuzzy(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct - t.length * 0.1;
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return -1;
    streak = i === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (i - ti);
    ti = i + 1;
  }
  return score;
}

interface Item {
  id: string;
  label: string;
  detail?: string;
  icon: "file" | "typ" | "cmd" | "new";
  key?: string;
  run: () => void;
}

export default function CommandPalette(props: { mode: "files" | "commands" | "pick"; pick?: { placeholder: string; items: PickItem[] }; onClose: () => void }) {
  const [q, setQ] = createSignal(props.mode === "commands" ? ">" : "");
  const [sel, setSel] = createSignal(0);

  const items = createMemo<Item[]>(() => {
    const raw = q();
    const cmdMode = raw.startsWith(">");
    const query = cmdMode ? raw.slice(1).trim() : raw.trim();
    let list: Item[];
    if (props.pick) {
      list = props.pick.items.map((p, i) => ({ id: String(i), label: p.label, detail: p.detail, icon: "file" as const, run: p.run }));
      return list
        .map((it) => ({ it, s: fuzzy(raw.trim(), it.label + " " + (it.detail ?? "")) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.it);
    }
    if (cmdMode) {
      list = app.commands
        .list()
        .filter((c) => c.palette !== false)
        .map((c) => ({ id: c.id, label: c.title, icon: "cmd" as const, key: app.commands.effectiveKey(c.id), run: () => app.commands.run(c.id) }));
    } else {
      list = notesList().map((p) => ({
        id: p,
        label: stem(p),
        detail: dirname(p),
        icon: p.endsWith(".typ") ? ("typ" as const) : ("file" as const),
        run: () => openNote(p),
      }));
    }
    const scored = list
      .map((it) => ({ it, s: fuzzy(query, it.label + " " + (it.detail ?? "")) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.it);
    if (!cmdMode && query && !scored.some((i) => i.label.toLowerCase() === query.toLowerCase())) {
      scored.push({ id: "__new", label: `Create “${query}”`, icon: "new", run: () => createNote(newNoteDir(), query, prefs.defaultNoteType) });
    }
    return scored;
  });

  const choose = (i: number) => {
    const it = items()[i];
    if (!it) return;
    props.onClose();
    it.run();
  };

  const fmtKey = (k?: string) => k?.replace("Mod", "Ctrl").replace(/-/g, "+").replace(/\+(\w)$/, (_, c) => "+" + c.toUpperCase());

  return (
    <Portal>
      <div class="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
        <div class="palette">
          <input
            class="palette-input"
            dir="auto"
            value={q()}
            placeholder={props.pick?.placeholder ?? "Search notes… (type > for commands)"}
            ref={(el) => setTimeout(() => el.focus())}
            onInput={(e) => (setQ(e.currentTarget.value), setSel(0))}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, items().length - 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
              else if (e.key === "Enter") (e.preventDefault(), choose(sel()));
              else if (e.key === "Escape") props.onClose();
            }}
          />
          <div class="palette-list">
            <For each={items()} fallback={<div class="pane-empty">No matches</div>}>
              {(it, i) => (
                <div
                  class="palette-item"
                  classList={{ active: sel() === i() }}
                  onMouseMove={() => setSel(i())}
                  onClick={() => choose(i())}
                  ref={(el) => sel() === i() && el.scrollIntoView({ block: "nearest" })}
                >
                  {it.icon === "cmd" ? <TerminalSquare size={16} /> : it.icon === "typ" ? <FileCode2 size={16} /> : <FileText size={16} />}
                  <span class="palette-label" dir="auto">{it.label}</span>
                  <Show when={it.detail}><span class="palette-detail">{it.detail}</span></Show>
                  <Show when={it.key}><kbd>{fmtKey(it.key)}</kbd></Show>
                </div>
              )}
            </For>
          </div>
          <div class="palette-foot">
            <span><kbd>↑↓</kbd> navigate</span>
            <span><kbd><CornerDownLeft size={11} /></kbd> open</span>
            <span><kbd>&gt;</kbd> commands</span>
          </div>
        </div>
      </div>
    </Portal>
  );
}

app.commands.register({ id: "palette.files", title: "Quick open note", key: "Mod-p", palette: false, run: () => setDialog({ kind: "palette", mode: "files" }) });
app.commands.register({ id: "palette.commands", title: "Command palette", key: "Mod-Shift-p", palette: false, run: () => setDialog({ kind: "palette", mode: "commands" }) });
