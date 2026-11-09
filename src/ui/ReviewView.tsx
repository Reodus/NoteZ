// Flashcards: decks, a review session (FSRS scheduling in core/src/srs.rs)
// and statistics. Cards are written in notes (docs/FLASHCARDS.md).
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { BookOpen, Layers, Pencil, RotateCcw, Undo2 } from "lucide-solid";
import katex from "katex";
import { Modal } from "./primitives";
import { ipc, stem, SrsCard, SrsSched } from "../core/ipc";
import { app, notify } from "../core/app";
import { openNote, prefs, setDialog } from "../core/store";
import { previewHtml } from "../core/blocks";
import { hydrateImages } from "../editor/livepreview";
import { srsSettings } from "../core/srs";

import { t, tn, num } from "../core/i18n";
/** Markdown (with $math$, images, ==marks==) into `el`. */
async function renderInto(el: HTMLElement, md: string) {
  el.innerHTML = await previewHtml(md);
  hydrateImages(el);
  el.querySelectorAll<HTMLElement>("span.math").forEach((m) => {
    try {
      katex.render(m.textContent ?? "", m, { displayMode: m.classList.contains("math-display"), throwOnError: false, output: "html" });
    } catch {
      /* left as text */
    }
  });
  el.querySelectorAll<HTMLElement>("[data-target]").forEach((a) =>
    a.addEventListener("click", () => {
      setDialog(null);
      void import("../editor/Editor").then((m) => m.openLinkTarget(a.dataset.target!));
    }),
  );
}

function CardFace(props: { md: string; class?: string }) {
  let el!: HTMLDivElement;
  createEffect(on(() => props.md, (md) => void renderInto(el, md)));
  return <div ref={el} class={`srs-face ${props.class ?? ""}`} dir="auto" />;
}

const GRADES: [1 | 2 | 3 | 4, string][] = [
  [1, "Again"],
  [2, "Hard"],
  [3, "Good"],
  [4, "Easy"],
];

function Session(props: { deck: string | null; onDone: () => void }) {
  const [queue, setQueue] = createSignal<SrsCard[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [shown, setShown] = createSignal(false);
  const [done, setDone] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const sched = new Map<string, SrsSched>();
  const undo: { card: SrsCard; prev: SrsSched | null }[] = [];
  const [canUndo, setCanUndo] = createSignal(false);

  /** Fetch the queue; `last` (just graded) goes after the others when it's back already. */
  const load = async (last?: string) => {
    const q = await ipc.srsQueue(props.deck, srsSettings(), [...prefs.excludedFolders]);
    if (last && q.length > 1 && q[0].id === last) q.push(q.shift()!);
    setQueue(q);
    setShown(false);
    setLoaded(true);
  };
  void (async () => {
    const all = await ipc.srsLoad().catch(() => ({}) as Record<string, SrsSched>);
    for (const [k, v] of Object.entries(all)) sched.set(k, v);
    await load();
  })().catch((e) => notify(String(e), "error"));

  const card = () => queue()[0];
  const grade = async (g: 1 | 2 | 3 | 4) => {
    const c = card();
    if (!c || !shown() || busy()) return;
    setBusy(true);
    try {
      const next = await ipc.srsGrade(c.id, g, srsSettings());
      undo.push({ card: c, prev: sched.get(c.id) ?? null });
      setCanUndo(true);
      sched.set(c.id, next);
      setDone((n) => n + 1);
      await load(c.id);
      app.events.emit("srs:changed", undefined);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const back = async () => {
    const u = undo.pop();
    setCanUndo(undo.length > 0);
    if (!u) return;
    await ipc.srsRestore(u.card.id, u.prev);
    if (u.prev) sched.set(u.card.id, u.prev);
    else sched.delete(u.card.id);
    setDone((n) => Math.max(0, n - 1));
    await load();
    // the undone card first, answer hidden
    setQueue((q) => [u.card, ...q.filter((x) => x.id !== u.card.id)]);
    setShown(false);
    app.events.emit("srs:changed", undefined);
  };
  const edit = () => {
    const c = card();
    if (!c) return;
    setDialog(null);
    void openNote(c.path, { line: c.line });
  };

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest?.("input, textarea")) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (!shown()) setShown(true);
      else void grade(3);
    } else if (shown() && /^[1-4]$/.test(e.key)) {
      e.preventDefault();
      void grade(Number(e.key) as 1 | 2 | 3 | 4);
    } else if (e.key === "u" || ((e.ctrlKey || e.metaKey) && e.key === "z")) {
      e.preventDefault();
      void back();
    } else if (e.key === "e") {
      e.preventDefault();
      edit();
    }
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  const counts = createMemo(() => {
    const q = queue();
    return { new: q.filter((c) => c.state === 0).length, learn: q.filter((c) => c.state === 1 || c.state === 3).length, due: q.filter((c) => c.state === 2).length };
  });

  return (
    <div class="srs-session">
      <div class="srs-session-head">
        <button class="btn small" onClick={props.onDone}><Layers size={14} /> {t("Decks")}</button>
        <span class="srs-deck-name" dir="auto">{props.deck ?? t("All decks")}</span>
        <span class="grow" />
        <span class="srs-counts" title={t("New · learning · due")}>
          <span class="n">{counts().new}</span> <span class="l">{counts().learn}</span> <span class="d">{counts().due}</span>
        </span>
        <button class="btn small icon" title={t("Undo (U)")} disabled={!canUndo()} onClick={() => void back()}><Undo2 size={14} /></button>
      </div>
      <Show when={loaded()} fallback={<div class="srs-empty">{t("Loading…")}</div>}>
        <Show when={card()} fallback={
          <div class="srs-empty">
            <div class="srs-big">🎉</div>
            <p>{done() ? tn(done(), t("Done for now: {n} card reviewed."), t("Done for now: {n} cards reviewed.")) : t("Nothing to study in this deck right now.")}</p>
            <button class="btn primary" onClick={props.onDone}>{t("Back to decks")}</button>
          </div>
        }>
          {(c) => (
            <>
              <div class="srs-card" classList={{ cloze: c().kind === "cloze" }}>
                <div class="srs-meta">
                  <span class="srs-kind">{c().state === 0 ? t("New") : c().state === 2 ? t("Review") : t("Learning")}</span>
                  <a class="srs-source" title={t("Open the note (E)")} onClick={edit}><Pencil size={12} /> {stem(c().path)}</a>
                </div>
                <CardFace md={c().front} />
                <Show when={shown()}>
                  <hr class="srs-divider" />
                  <CardFace md={c().back} class="back" />
                </Show>
              </div>
              <div class="srs-actions">
                <Show when={shown()} fallback={
                  <button class="btn primary srs-show" onClick={() => setShown(true)}>{t("Show answer")} <kbd>{t("Space")}</kbd></button>
                }>
                  <For each={GRADES}>
                    {([g, label]) => (
                      <button class={`btn srs-grade g${g}`} disabled={busy()} onClick={() => void grade(g)}>
                        <span class="srs-ivl">{c().intervals[g - 1]}</span>
                        <span>{label}</span>
                        <kbd>{g}</kbd>
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}

/** Reviews per day for the last 26 weeks, GitHub style. */
function Heatmap(props: { days: Record<string, number> }) {
  const cells = createMemo(() => {
    const out: { date: string; n: number }[] = [];
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - (7 * 25 + today.getDay()));
    for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      out.push({ date: key, n: props.days[key] ?? 0 });
    }
    return out;
  });
  const max = () => Math.max(1, ...cells().map((c) => c.n));
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max()) * 4)));
  return (
    <div class="srs-heatmap">
      <For each={cells()}>{(c) => <span class={`h${level(c.n)}`} title={`${c.date}: ${tn(c.n, "{n} review", "{n} reviews")}`} />}</For>
    </div>
  );
}

function Overview(props: { onStudy: (deck: string | null) => void }) {
  const [tick, setTick] = createSignal(0);
  const off = app.events.on("vault:changed", () => setTick((t) => t + 1));
  onCleanup(off);
  const [ov] = createResource(tick, () => ipc.srsOverview(srsSettings(), [...prefs.excludedFolders]));
  const [stats] = createResource(tick, () => ipc.srsStats([...prefs.excludedFolders]));
  const total = () => (ov()?.decks ?? []).reduce((a, d) => ({ new: a.new + d.new, learning: a.learning + d.learning, due: a.due + d.due, total: a.total + d.total }), { new: 0, learning: 0, due: 0, total: 0 });
  const studyable = (d: { new: number; learning: number; due: number }) => d.new + d.learning + d.due > 0;
  return (
    <div class="srs-overview">
      <Show when={ov.error}>
        <div class="base-errors">{String(ov.error)}</div>
      </Show>
      <Show when={ov()} fallback={<div class="srs-empty">{t("Loading…")}</div>}>
        <Show when={ov()!.decks.length} fallback={
          <div class="srs-empty">
            <div class="srs-big"><BookOpen size={36} /></div>
            <p>{t("No flashcards yet. Tag a note")} <code>#flashcards</code> {t("and write cards in it:")}</p>
            <pre class="srs-sample">{"#flashcards\n\nperro::dog\nThe ==mitochondria== is the powerhouse of the cell.\n\nWhat does FSRS stand for?\n?\nFree Spaced Repetition Scheduler"}</pre>
            <button class="btn" onClick={() => setDialog({ kind: "help", doc: "FLASHCARDS" })}>{t("How to write cards")}</button>
          </div>
        }>
          <table class="srs-decks">
            <thead>
              <tr><th>{t("Deck")}</th><th class="n">{t("New")}</th><th class="l">{t("Learning")}</th><th class="d">{t("Due")}</th><th>{t("Cards")}</th><th /></tr>
            </thead>
            <tbody>
              <For each={ov()!.decks}>
                {(d) => (
                  <tr>
                    <td dir="auto"><a class="base-link" onClick={() => studyable(d) && props.onStudy(d.name)}>{d.name}</a></td>
                    <td class="n">{d.new}</td>
                    <td class="l">{d.learning}</td>
                    <td class="d">{d.due}</td>
                    <td class="muted">{d.total}</td>
                    <td><button class="btn small" disabled={!studyable(d)} onClick={() => props.onStudy(d.name)}>{t("Study")}</button></td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <div class="row gap srs-overview-actions">
            <button class="btn primary" disabled={!studyable(total())} onClick={() => props.onStudy(null)}>
              Study all{studyable(total()) ? ` (${total().new + total().learning + total().due})` : ""}
            </button>
            <span class="field-hint">
              {t("Reviewed today: {reviewed} · new cards left today: {left}", { reviewed: ov()!.reviewed_today, left: ov()!.new_left_today })}
            </span>
          </div>
        </Show>
      </Show>
      <Show when={stats() && stats()!.total_reviews + stats()!.young + stats()!.mature + stats()!.new > 0}>
        <h4 class="srs-h">{t("Activity")}</h4>
        <Heatmap days={stats()!.days} />
        <h4 class="srs-h">{t("Due in the next 30 days")}</h4>
        <div class="srs-forecast">
          <For each={stats()!.forecast}>
            {(n, i) => <span style={{ height: `${Math.round((n / Math.max(1, ...stats()!.forecast)) * 100)}%` }} title={`${i() === 0 ? t("Today") : tn(i(), "In {n} day", "In {n} days")}: ${num(n)}`} />}
          </For>
        </div>
        <div class="srs-legend">
          <span><i class="n" /> {t("New")} {num(stats()!.new)}</span>
          <span><i class="l" /> Learning {stats()!.learning}</span>
          <span><i class="y" /> Young {stats()!.young}</span>
          <span><i class="m" /> Mature {stats()!.mature}</span>
          <span class="muted">{tn(stats()!.total_reviews, "{n} review in all", "{n} reviews in all")}</span>
        </div>
      </Show>
    </div>
  );
}

export default function ReviewView(props: { deck?: string | null; onClose: () => void }) {
  const [deck, setDeck] = createSignal<string | null | undefined>(props.deck);
  return (
    <Modal title={t("Flashcards")} subtitle={t("Cards from notes tagged #flashcards, scheduled with FSRS.")} width="min(820px, 94vw)" class="srs-dialog" onClose={props.onClose}>
      <Show when={deck() !== undefined} fallback={<Overview onStudy={(d) => setDeck(d)} />}>
        <Session deck={deck() ?? null} onDone={() => setDeck(undefined)} />
      </Show>
      <div class="srs-foot">
        <button class="btn small" onClick={() => setDialog({ kind: "settings", tab: "flashcards" })}><RotateCcw size={13} /> {t("Scheduling settings")}</button>
        <span class="grow" />
        <span class="field-hint"><kbd>{t("Space")}</kbd> {t("show / good ·")} <kbd>1</kbd>–<kbd>4</kbd> {t("grade ·")} <kbd>U</kbd> {t("undo ·")} <kbd>E</kbd> {t("edit")}</span>
      </div>
    </Modal>
  );
}
