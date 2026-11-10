import { createEffect, onCleanup, onMount, Show, Switch, Match } from "solid-js";
import { initUpdates } from "./core/updates";
import { Copy, Minimize2, PanelLeft } from "lucide-solid";
import { app, notify } from "./core/app";
import {
  root, prefs, isDark, openVault, openNote, openOsPath, dialog, setDialog, sidebarOpen, setSidebarOpen, saveAll, state,
  focusMode, setFocusMode, viewLayout,
} from "./core/store";
import { fileKind, ipc } from "./core/ipc";
import { setZoom, setSpellcheck, takeOpenedFiles, onOpenPath, onVaultFs, onCapture, setCaptureShortcut } from "./core/native";
import { applyTheme, loadUserCss, themeById } from "./core/uithemes";
import { loadBuiltins, loadVaultPlugins } from "./core/plugins";
import { corePlugin, readingTimePlugin } from "./plugins/core";
import { mermaidPlugin } from "./plugins/mermaid";
import { outlinePlugin, backlinksPlugin, pdfExportPlugin, diagramsPlugin } from "./plugins/builtins";
import { templatesPlugin } from "./plugins/templates";
import { dailyNotesPlugin, captureText, captureNote } from "./plugins/daily";
import Welcome from "./ui/Welcome";
import HistoryDialog from "./ui/HistoryDialog";
import ReviewView from "./ui/ReviewView";
import "./core/safety";
import Sidebar from "./ui/Sidebar";
import TabBar from "./ui/TabBar";
import Toolbar from "./ui/Toolbar";
import RightPanel from "./ui/RightPanel";
import StatusBar from "./ui/StatusBar";
import CommandPalette from "./ui/CommandPalette";
import Settings from "./ui/Settings";
import HelpView from "./ui/HelpView";
import DiagramGallery from "./ui/DiagramGallery";
import { StyleDialog, PageSetupDialog, ThemesDialog } from "./ui/StyleDialogs";
import { MenuHost, Modal, PromptHost, Toasts, modalOpen } from "./ui/primitives";
import { modName } from "./core/keys";
import { Logo } from "./ui/Logo";
import Editor from "./editor/Editor";
import FileView from "./ui/FileView";
import { BaseFile } from "./ui/BaseView";
import { isNotePath } from "./core/ipc";
import GraphView, { graphOpen } from "./ui/GraphView";
import "./styles/app.css";

import { t } from "./core/i18n";
const DEFAULT_ACCENT = "#6d5efc";

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function TypstSource(props: { source: string; onClose: () => void }) {
  return (
    <Modal
      title={t("Generated Typst")}
      subtitle={t("This is exactly what the PDF engine compiles. Useful for learning Typst or debugging.")}
      width="860px"
      onClose={props.onClose}
      footer={
        <>
          <div class="spacer" />
          <button class="btn" onClick={() => navigator.clipboard.writeText(props.source).then(() => notify(t("Copied"), "success"))}>
            <Copy size={15} /> {t("Copy")}
          </button>
          <button class="btn primary" onClick={props.onClose}>{t("Close")}</button>
        </>
      }
    >
      <pre class="typst-source" dir="ltr">{props.source}</pre>
    </Modal>
  );
}

function EmptyState() {
  return (
    <div class="empty-state">
      <Logo size={64} />
      <h2>{t("No note open")}</h2>
      <div class="empty-keys">
        <span><kbd>{modName}</kbd> + <kbd>N</kbd> {t("New note")}</span>
        <span><kbd>{modName}</kbd> + <kbd>P</kbd> {t("Quick open")}</span>
        <span><kbd>{modName}</kbd> + <kbd>{t("Shift")}</kbd> + <kbd>P</kbd> {t("Commands")}</span>
      </div>
      <button class="btn primary" onClick={() => app.commands.run("note.new")}>{t("Create a note")}</button>
    </div>
  );
}

export default function App() {
  // Appearance → CSS.
  createEffect(() => {
    const el = document.documentElement;
    const mode = isDark() ? "dark" : "light";
    const wanted = themeById(mode === "dark" ? prefs.uiThemeDark : prefs.uiThemeLight);
    const theme = wanted?.mode === mode ? wanted : themeById(mode)!;
    applyTheme(theme, [...prefs.enabledSnippets]);
    const accent = prefs.accent || theme.accent || DEFAULT_ACCENT;
    const [r, g, b] = hexToRgb(accent);
    el.style.setProperty("--accent", accent);
    el.style.setProperty("--accent-rgb", `${r}, ${g}, ${b}`);
  });
  // User themes and snippets follow the open vault and changes on disk.
  createEffect(() => void loadUserCss(root()));
  onCleanup(onVaultFs((paths) => {
    if (paths.some((p) => /^\.notez\/(themes|snippets)\//.test(p))) void loadUserCss(root());
  }));

  createEffect(() => setZoom(prefs.uiZoom));
  createEffect(() => document.documentElement.classList.toggle("no-anim", !prefs.animations));
  createEffect(() => void setSpellcheck(prefs.spellcheck, [...prefs.spellcheckLanguages]).catch(() => {}));

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || dialog() || modalOpen()) return;
    if (e.key === "Escape" && focusMode()) {
      e.preventDefault();
      setFocusMode(false);
      return;
    }
    app.commands.handleKey(e);
  };
  const onUnload = () => void saveAll();

  onMount(async () => {
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onUnload);
    initUpdates();
    await loadBuiltins([corePlugin, readingTimePlugin, mermaidPlugin, outlinePlugin, backlinksPlugin, pdfExportPlugin, diagramsPlugin, templatesPlugin, dailyNotesPlugin]);
    const args = await ipc.startupArgs().catch(() => [] as string[]);
    const vault = args[0] ?? prefs.lastVault;
    if (vault) await openVault(vault);
    if (args[0] && args[1]) await openNote(args[1].startsWith(args[0]) ? args[1].slice(args[0].length).replace(/^\/+/, "") : args[1]);
    for (const f of await takeOpenedFiles().catch(() => [] as string[])) await openOsPath(f);
  });
  onCleanup(onOpenPath((p) => void openOsPath(p)));
  onCleanup(onCapture((text) => void captureText(text)));
  createEffect(() => {
    const accel = prefs.captureShortcut;
    void setCaptureShortcut(accel, root() ? captureNote() : "").then((ok) => {
      if (!ok) notify(t("The quick capture shortcut {accel} is used by another app. Choose another in Settings → Daily notes & capture.", { accel }), "error");
    });
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("beforeunload", onUnload);
  });

  // Vault plugins follow the open vault.
  app.events.on("vault:opened", () => void loadVaultPlugins());

  return (
    <>
      <Show when={root()} fallback={<Welcome />}>
        <div class="shell" classList={{ "no-sidebar": !sidebarOpen() || focusMode(), focus: focusMode(), "no-tabbar": !prefs.showTabBar }}>
          {/* Fixed in the top-left corner whether the sidebar is open or not. */}
          <Show when={!focusMode()}>
            <button
              class="icon-btn sidebar-toggle"
              classList={{ active: sidebarOpen() }}
              title={sidebarOpen() ? t("Hide sidebar (Ctrl+\\)") : t("Show sidebar (Ctrl+\\)")}
              aria-expanded={sidebarOpen()}
              onClick={() => setSidebarOpen(!sidebarOpen())}
            >
              <PanelLeft size={17} />
            </button>
          </Show>
          <div
            class="sidebar-slot"
            style={{ width: sidebarOpen() && !focusMode() ? `${prefs.sidebarWidth}px` : "0px" }}
            inert={!sidebarOpen() || focusMode()}
          >
            <Sidebar />
          </div>
          <main class="workspace">
            <Show when={!focusMode() && prefs.showTabBar}>
              <TabBar />
            </Show>
            <Show when={!graphOpen() || focusMode()} fallback={<GraphView />}>
            <Show when={state.active} fallback={<EmptyState />}>
            <Show when={isNotePath(state.active)} fallback={fileKind(state.active!) === "base" ? <BaseFile path={state.active!} /> : <FileView path={state.active!} />}>
              <Show when={viewLayout() !== "preview" && !focusMode()}>
                <Toolbar />
              </Show>
              <div class="work-area" classList={{ [`layout-${viewLayout()}`]: true }}>
                <Show when={viewLayout() !== "preview"}>
                  <Editor />
                </Show>
                <Show when={viewLayout() !== "editor"}>
                  <RightPanel />
                </Show>
              </div>
            </Show>
            </Show>
            </Show>
            <Show when={!focusMode() && prefs.showStatusBar}>
              <StatusBar />
            </Show>
            <Show when={focusMode()}>
              <button class="focus-exit" title={t("Exit focus mode (Esc)")} onClick={() => setFocusMode(false)}>
                <Minimize2 size={15} />
              </button>
            </Show>
          </main>
        </div>
      </Show>

      <Switch>
        <Match when={dialog()?.kind === "palette" && dialog()}>
          {(d) => <CommandPalette mode={(d() as any).mode} onClose={() => setDialog(null)} />}
        </Match>
        <Match when={dialog()?.kind === "pick" && dialog()}>
          {(d) => <CommandPalette mode="pick" pick={d() as any} onClose={() => setDialog(null)} />}
        </Match>
        <Match when={dialog()?.kind === "settings" && dialog()}>
          {(d) => <Settings tab={(d() as any).tab} onClose={() => setDialog(null)} />}
        </Match>
        <Match when={dialog()?.kind === "style" && dialog()}>
          {(d) => <StyleDialog styleKey={(d() as any).key} scope={(d() as any).scope} onClose={() => setDialog(null)} />}
        </Match>
        <Match when={dialog()?.kind === "help" && dialog()}>
          {(d) => <HelpView doc={(d() as any).doc} anchor={(d() as any).anchor} onClose={() => setDialog(null)} />}
        </Match>
        <Match when={dialog()?.kind === "page"}>
          <PageSetupDialog onClose={() => setDialog(null)} />
        </Match>
        <Match when={dialog()?.kind === "themes"}>
          <ThemesDialog onClose={() => setDialog(null)} />
        </Match>
        <Match when={dialog()?.kind === "diagrams"}>
          <DiagramGallery onClose={() => setDialog(null)} />
        </Match>
        <Match when={dialog()?.kind === "typst" && dialog()}>
          {(d) => <TypstSource source={(d() as any).source} onClose={() => setDialog(null)} />}
        </Match>
        <Match when={dialog()?.kind === "history" && dialog()}>
          {(d) => <HistoryDialog tab={(d() as any).tab} path={(d() as any).path} onClose={() => setDialog(null)} />}
        </Match>
        <Match when={dialog()?.kind === "review" && dialog()}>
          {(d) => <ReviewView deck={(d() as any).deck} onClose={() => setDialog(null)} />}
        </Match>
      </Switch>

      <MenuHost />
      <PromptHost />
      <Toasts />
    </>
  );
}
