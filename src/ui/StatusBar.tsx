import { createMemo, For, Show } from "solid-js";
import { CheckCircle2, AlertTriangle, Loader2, Save } from "lucide-solid";
import { app } from "../core/app";
import { isNotePath } from "../core/ipc";
import { state, cursor, isDirty, setRightTab, prefs, setPrefs } from "../core/store";
import { preview } from "../core/render";
import { docThemeId } from "./StyleDialogs";

/** Words in mixed Persian/English text (ZWNJ joins a word). */
export function countWords(text: string): number {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/```[\s\S]*?```/g, " ");
  return (body.match(/[\p{L}\p{N}‌'’-]+/gu) ?? []).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export default function StatusBar() {
  const text = () => (state.active ? state.buffers[state.active]?.content ?? "" : "");
  const words = createMemo(() => countWords(text()));
  const errors = () => preview().diagnostics.filter((d) => d.severity === "error").length;
  const items = () => [...app.statusBar.items()].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  return (
    <footer class="statusbar">
      <Show when={isNotePath(state.active)}>
        <span class="sb-item" title="Save state">
          <Show when={isDirty(state.active!)} fallback={<><CheckCircle2 size={12} /> Saved</>}>
            <Save size={12} /> Editing…
          </Show>
        </span>
        <span class="sb-item">{words().toLocaleString()} words</span>
        <span class="sb-item">{text().length.toLocaleString()} chars</span>
        <span class="sb-item">Ln {cursor().line}, Col {cursor().col}{cursor().selected ? ` (${cursor().selected} sel)` : ""}</span>
      </Show>
      <For each={isNotePath(state.active) ? items() : []}>
        {(it) => (
          <span class="sb-item" classList={{ click: !!it.onClick }} title={it.title} onClick={it.onClick}>{it.render()}</span>
        )}
      </For>
      <div class="spacer" />
      <Show when={isNotePath(state.active)}>
        <span class="sb-item">{state.active!.endsWith(".typ") ? "Typst" : "Markdown"}</span>
        <span class="sb-item">Theme: {docThemeId()}</span>
        <Show when={prefs.layout !== "editor"}>
          <span class="sb-item click" classList={{ err: errors() > 0 }} onClick={() => setRightTab("preview")}>
            <Show when={!preview().busy} fallback={<><Loader2 size={12} class="spin" /> Typesetting</>}>
              <Show when={errors()} fallback={<><CheckCircle2 size={12} /> {preview().pages.length} pp · {preview().millis} ms</>}>
                <AlertTriangle size={12} /> {errors()} error{errors() > 1 ? "s" : ""}
              </Show>
            </Show>
          </span>
        </Show>
        <Show when={prefs.layout === "editor"}>
          <span class="sb-item click" onClick={() => setPrefs("layout", "split")}>Show preview</span>
        </Show>
      </Show>
    </footer>
  );
}
