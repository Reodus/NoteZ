// Built-in plugin: daily notes and the calendar panel.
// A daily note is <folder>/<date in the chosen format>.md, created from the
// daily template on first open (Obsidian's Daily notes conventions).
import { createMemo, createSignal, For, Show } from "solid-js";
import { render } from "solid-js/web";
import type { BuiltinPlugin } from "../core/plugins";
import { ipc, stem } from "../core/ipc";
import { prefs, notesList, openNote, refreshTree, state, setPrefs, setRightTab, editorView, updateContent } from "../core/store";
import { notify } from "../core/app";
import { fillTemplate, formatDate, parseDate, isoWeek } from "./templates";

import { t } from "../core/i18n";
const ICON = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const folder = () => prefs.dailyFolder.trim().replace(/^\/+|\/+$/g, "");
const format = () => prefs.dailyFormat.trim() || "YYYY-MM-DD";

/** Vault path of the daily note for `d`. */
export function dailyPath(d: Date): string {
  const name = formatDate(d, format());
  return `${folder() ? folder() + "/" : ""}${name}.md`;
}

/** The date of a daily note, or null when `path` isn't one. */
export function dailyDate(path: string): Date | null {
  const f = folder();
  if (!path.endsWith(".md")) return null;
  if (f && !path.startsWith(f + "/")) return null;
  const rel = path.slice(f ? f.length + 1 : 0, -3);
  return parseDate(rel, format());
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Daily notes that exist, by day. */
const existing = () => {
  const m = new Map<string, string>();
  for (const p of notesList()) {
    const d = dailyDate(p);
    if (d) m.set(dayKey(d), p);
  }
  return m;
};

/** Open the daily note for `d`, creating it (from the template) if needed. */
export async function openDaily(d = new Date()) {
  const path = dailyPath(d);
  if (!notesList().includes(path)) {
    try {
      let text = "";
      if (prefs.dailyTemplate.trim()) {
        try {
          // The template's {{date}} is the note's day; {{time}} is now.
          const at = new Date(d);
          const now = new Date();
          at.setHours(now.getHours(), now.getMinutes(), now.getSeconds());
          text = fillTemplate(await ipc.read(prefs.dailyTemplate.trim()), stem(path), at);
        } catch {
          notify(t("Daily note template \"{dailyTemplate}\" not found", { dailyTemplate: prefs.dailyTemplate }), "error");
        }
      }
      await ipc.createNote(path);
      await ipc.write(path, text);
      await refreshTree();
    } catch (e) {
      return notify(String(e), "error");
    }
  }
  await openNote(path);
}

/** The nearest existing daily note before (-1) or after (+1) the active one. */
function step(dir: -1 | 1) {
  const cur = state.active ? dailyDate(state.active) : null;
  const from = cur ?? new Date();
  const days = [...existing().entries()]
    .map(([, p]) => [dailyDate(p)!, p] as const)
    .filter(([d]) => (dir < 0 ? d < from : d > from) && dayKey(d) !== dayKey(from))
    .sort((a, b) => (a[0].getTime() - b[0].getTime()) * dir);
  if (days.length) return openNote(days[0][1]);
  notify(dir < 0 ? t("No earlier daily note") : t("No later daily note"));
}

// ---------------------------------------------------------- quick capture

/** Where quick capture writes (vault path). */
export const captureNote = () => (prefs.captureTarget === "daily" || !prefs.captureTarget.trim() ? dailyPath(new Date()) : prefs.captureTarget.trim().replace(/^\/+/, "").replace(/(?<!\.(md|typ))$/, ".md"));

/** Add captured text to the capture note (created if needed) as one line. */
export async function captureText(text: string) {
  const now = new Date();
  const line = (prefs.captureFormat || "- {{time}} {{text}}")
    .replace(/\{\{\s*text\s*\}\}/g, () => text.replace(/\n/g, "\n  "));
  const entry = fillTemplate(line, "", now);
  const path = captureNote();
  try {
    if (!notesList().includes(path)) {
      if (prefs.captureTarget === "daily") {
        const cur = state.active;
        await openDaily(now);
        if (cur && cur !== path) await openNote(cur);
      } else {
        await ipc.createNote(path);
        await refreshTree();
      }
    }
    const view = editorView();
    if (state.active === path && view) {
      const doc = view.state.doc.toString();
      const sep = doc.length && !doc.endsWith("\n") ? "\n" : "";
      view.dispatch({ changes: { from: doc.length, insert: `${sep}${entry}\n` } });
    } else {
      const doc = state.buffers[path]?.content ?? (await ipc.read(path));
      const next = `${doc}${doc.length && !doc.endsWith("\n") ? "\n" : ""}${entry}\n`;
      if (state.buffers[path]) updateContent(path, next);
      else await ipc.write(path, next);
    }
    notify(t("Captured to {x}", { x: stem(path) }), "success", { label: t("Open"), run: () => void openNote(path) });
  } catch (e) {
    notify(t("Quick capture failed: {error}", { error: e }), "error");
  }
}

// --------------------------------------------------------------- calendar

export function Calendar() {
  const today = new Date();
  const [month, setMonth] = createSignal(new Date(today.getFullYear(), today.getMonth(), 1));
  const notes = createMemo(existing);
  const activeDay = () => (state.active ? dailyDate(state.active) : null);
  const locale = undefined; // the system locale names months and weekdays

  /** 6 rows × 7 days, starting on the configured weekday. */
  const weeks = createMemo(() => {
    const first = month();
    const offset = (first.getDay() - prefs.weekStart + 7) % 7;
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
    return Array.from({ length: 6 }, (_, w) =>
      Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + i)),
    );
  });
  const dayNames = () =>
    Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 7 + ((prefs.weekStart + i) % 7)).toLocaleDateString(locale, { weekday: "narrow" }));
  const move = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const count = () => [...notes().keys()].filter((k) => k.startsWith(`${month().getFullYear()}-${month().getMonth()}-`)).length;

  return (
    <div class="calendar-pane">
      <div class="cal-head">
        <button class="icon-btn small" title={t("Previous month")} onClick={() => move(-1)}>‹</button>
        <div class="cal-title" title={`${count()} daily notes this month`}>
          {month().toLocaleDateString(locale, { month: "long", year: "numeric" })}
        </div>
        <button class="icon-btn small" title={t("Next month")} onClick={() => move(1)}>›</button>
      </div>
      <table class="cal-grid">
        <thead>
          <tr>
            <th class="cal-week" title={t("Week")}>#</th>
            <For each={dayNames()}>{(n) => <th>{n}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <For each={weeks()}>
            {(week) => (
              <tr>
                <td class="cal-week">{isoWeek(week[3])}</td>
                <For each={week}>
                  {(d) => {
                    const path = () => notes().get(dayKey(d));
                    return (
                      <td>
                        <button
                          class="cal-day"
                          classList={{
                            other: d.getMonth() !== month().getMonth(),
                            today: dayKey(d) === dayKey(today),
                            active: !!activeDay() && dayKey(d) === dayKey(activeDay()!),
                            has: !!path(),
                          }}
                          title={path() ?? t("Create {x}", { x: dailyPath(d) })}
                          onClick={() => openDaily(d)}
                        >
                          {d.toLocaleDateString(locale, { day: "numeric" })}
                        </button>
                      </td>
                    );
                  }}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <div class="cal-foot">
        <button class="btn small" onClick={() => (setMonth(new Date(today.getFullYear(), today.getMonth(), 1)), openDaily(today))}>
          {t("Today")}
        </button>
        <Show when={!notesList().some((p) => dailyDate(p))}>
          <span class="muted">{t("Notes go to")} <code>{folder() || "/"}</code></span>
        </Show>
      </div>
    </div>
  );
}

export const CALENDAR_PANEL = "core.daily-notes.calendar";

export const dailyNotesPlugin: BuiltinPlugin = {
  id: "core.daily-notes",
  name: t("Daily notes"),
  description: t("One note per day (Ctrl+Alt+D) and a calendar in the right panel."),
  optional: true,
  onload(api) {
    api.panels.add({
      id: "calendar",
      title: t("Calendar"),
      icon: ICON('<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/>'),
      mount: (el) => render(() => <Calendar />, el),
    });
    api.commands.register({ id: "daily.today", title: t("Open today's daily note"), key: "Mod-Alt-d", run: () => openDaily() });
    api.commands.register({
      id: "daily.yesterday",
      title: t("Open yesterday's daily note"),
      run: () => openDaily(new Date(Date.now() - 86400000)),
    });
    api.commands.register({
      id: "daily.tomorrow",
      title: t("Open tomorrow's daily note"),
      run: () => openDaily(new Date(Date.now() + 86400000)),
    });
    api.commands.register({ id: "daily.prev", title: t("Previous daily note"), key: "Mod-Alt-ArrowLeft", run: () => step(-1) });
    api.commands.register({ id: "daily.next", title: t("Next daily note"), key: "Mod-Alt-ArrowRight", run: () => step(1) });
    api.commands.register({ id: "daily.calendar", title: t("Show calendar"), run: () => (setPrefs("layout", "split"), setRightTab(CALENDAR_PANEL)) });
  },
};
