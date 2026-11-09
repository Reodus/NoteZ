import { createSignal, For, onCleanup, Show } from "solid-js";
import { CheckCircle2, AlertTriangle, Loader2, Save, Cloud, CloudOff, RefreshCw, GraduationCap } from "lucide-solid";
import { runSync, syncConfigured, syncState } from "../core/safety";
import { when } from "./HistoryDialog";
import { app } from "../core/app";
import { isNotePath } from "../core/ipc";
import { state, cursor, isDirty, setRightTab, prefs, setPrefs, root, setDialog } from "../core/store";
import { ipc as ipc2 } from "../core/ipc";
import { srsSettings } from "../core/srs";
import { preview } from "../core/render";
import { docThemeId } from "./StyleDialogs";

export { countWords } from "../core/words";
import { activeWords, trackWords } from "../core/words";

export default function StatusBar() {
  // Flashcards due now (learning + review + today's new), refreshed a moment
  // after the vault or a review changes.
  const [dueCards, setDueCards] = createSignal(0);
  let dueTimer: number | undefined;
  const refreshDue = () => {
    clearTimeout(dueTimer);
    dueTimer = window.setTimeout(async () => {
      if (!root()) return setDueCards(0);
      const o = await ipc2.srsOverview(srsSettings(), [...prefs.excludedFolders]).catch(() => null);
      setDueCards(o ? o.decks.reduce((n, d) => n + d.new + d.learning + d.due, 0) : 0);
    }, 1500);
  };
  refreshDue();
  const offs = [app.events.on("vault:changed", refreshDue), app.events.on("srs:changed", refreshDue)];
  const minute = window.setInterval(refreshDue, 5 * 60_000);
  onCleanup(() => (offs.forEach((o) => o()), clearInterval(minute), clearTimeout(dueTimer)));
  const text = () => (state.active ? state.buffers[state.active]?.content ?? "" : "");
  trackWords(text, () => state.active);
  const words = activeWords;
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
      <Show when={dueCards() > 0}>
        <span class="sb-item click" title="Flashcards to review — click to study (Ctrl+Shift+R)" onClick={() => setDialog({ kind: "review", deck: null })}>
          <GraduationCap size={12} /> {dueCards()} due
        </span>
      </Show>
      <Show when={syncConfigured()}>
        <span class="sb-item click" classList={{ err: syncState().status === "error" || syncState().status === "needs-passphrase" }}
          title={syncState().error ?? (syncState().last ? `Last synced ${when(syncState().last)} — click to sync now` : "Click to sync now")}
          onClick={() => void runSync(true)}>
          <Show when={syncState().status !== "syncing"} fallback={<><RefreshCw size={12} class="spin" /> Syncing</>}>
            <Show when={syncState().status === "idle"} fallback={<><CloudOff size={12} /> Sync</>}>
              <Cloud size={12} /> {syncState().last ? "Synced" : "Sync"}
            </Show>
          </Show>
        </span>
      </Show>
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
