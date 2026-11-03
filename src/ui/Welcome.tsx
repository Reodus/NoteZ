import { For, Show } from "solid-js";
import { openDialog as pickFolder } from "../core/native";
import { FolderOpen, FolderPlus, Clock, X, FileText, Sparkles, Languages, PenTool } from "lucide-solid";
import { prefs, setPrefs, openVault } from "../core/store";
import { ipc } from "../core/ipc";
import { notify } from "../core/app";
import { Logo } from "./Logo";

export async function chooseVault() {
  const picked = await pickFolder({ directory: true, title: "Open vault folder" });
  if (typeof picked === "string") await openVault(picked);
}

async function createVault() {
  const picked = await pickFolder({ directory: true, title: "Choose an (empty) folder for the new vault" });
  if (typeof picked !== "string") return;
  try {
    await ipc.openVault(picked);
    const notes = await ipc.notes();
    if (!notes.length) {
      await ipc.write(
        "Welcome.md",
        `---\ntitle: به NoteZ خوش آمدید\ntheme: default\n---\n\n# شروع\n\nاین اولین یادداشت شماست. از نوار ابزار بالا برای قالب‌بندی استفاده کنید و با **Export PDF** خروجی بگیرید.\n\nThis is your first note — English and فارسی can be mixed freely.\n\n\`\`\`chart\ntype: bar\ntitle: نمونه نمودار\ndata:\n  الف: 4\n  ب: 7\n  ج: 5\n\`\`\`\n`,
      );
    }
  } catch (e) {
    notify(String(e), "error");
    return;
  }
  await openVault(picked);
}

export default function Welcome() {
  const name = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
  return (
    <div class="welcome">
      <div class="welcome-glow" />
      <div class="welcome-card">
        <div class="welcome-brand">
          <Logo size={56} />
          <div>
            <h1>NoteZ</h1>
            <p>Notes in Markdown & Typst · فارسی و English · beautiful PDFs</p>
          </div>
        </div>

        <div class="welcome-actions">
          <button class="big-action" onClick={chooseVault}>
            <FolderOpen size={22} />
            <span>
              <b>Open vault</b>
              <small>Use an existing folder of notes (works with Obsidian vaults)</small>
            </span>
          </button>
          <button class="big-action" onClick={createVault}>
            <FolderPlus size={22} />
            <span>
              <b>Create vault</b>
              <small>Start fresh in a new folder with a welcome note</small>
            </span>
          </button>
        </div>

        <Show when={prefs.recentVaults.length}>
          <div class="recent">
            <h3>
              <Clock size={14} /> Recent
            </h3>
            <For each={prefs.recentVaults}>
              {(p) => (
                <div class="recent-item" onClick={() => openVault(p)} title={p}>
                  <FileText size={16} />
                  <span class="recent-name" dir="auto">{name(p)}</span>
                  <span class="recent-path">{p}</span>
                  <button
                    class="icon-btn small"
                    title="Remove from list"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPrefs("recentVaults", (r) => r.filter((x) => x !== p));
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div class="welcome-features">
          <span><Languages size={15} /> Persian ⇄ English bidi</span>
          <span><Sparkles size={15} /> Typst-powered PDF</span>
          <span><PenTool size={15} /> Charts & diagrams</span>
        </div>
      </div>
    </div>
  );
}
