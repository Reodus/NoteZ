import { createEffect, onCleanup, onMount, Show, Switch, Match } from "solid-js";
import { Copy } from "lucide-solid";
import { app, notify } from "./core/app";
import {
  root, prefs, isDark, openVault, openNote, dialog, setDialog, sidebarOpen, saveAll, state,
} from "./core/store";
import { ipc } from "./core/ipc";
import { loadBuiltins, loadVaultPlugins } from "./core/plugins";
import { corePlugin, readingTimePlugin } from "./plugins/core";
import { mermaidPlugin } from "./plugins/mermaid";
import Welcome from "./ui/Welcome";
import Sidebar from "./ui/Sidebar";
import TabBar from "./ui/TabBar";
import Toolbar from "./ui/Toolbar";
import RightPanel from "./ui/RightPanel";
import StatusBar from "./ui/StatusBar";
import CommandPalette from "./ui/CommandPalette";
import Settings from "./ui/Settings";
import DiagramGallery from "./ui/DiagramGallery";
import { StyleDialog, PageSetupDialog, ThemesDialog } from "./ui/StyleDialogs";
import { MenuHost, Modal, PromptHost, Toasts } from "./ui/primitives";
import { Logo } from "./ui/Logo";
import Editor from "./editor/Editor";
import GraphView, { graphOpen } from "./ui/GraphView";
import "./styles/app.css";

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function TypstSource(props: { source: string; onClose: () => void }) {
  return (
    <Modal
      title="Generated Typst"
      subtitle="This is exactly what the PDF engine compiles. Useful for learning Typst or debugging."
      width="860px"
      onClose={props.onClose}
      footer={
        <>
          <div class="spacer" />
          <button class="btn" onClick={() => navigator.clipboard.writeText(props.source).then(() => notify("Copied", "success"))}>
            <Copy size={15} /> Copy
          </button>
          <button class="btn primary" onClick={props.onClose}>Close</button>
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
      <h2>No note open</h2>
      <div class="empty-keys">
        <span><kbd>Ctrl</kbd> + <kbd>N</kbd> New note</span>
        <span><kbd>Ctrl</kbd> + <kbd>P</kbd> Quick open</span>
        <span><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> Commands</span>
      </div>
      <button class="btn primary" onClick={() => app.commands.run("note.new")}>Create a note</button>
    </div>
  );
}

export default function App() {
  // Appearance → CSS.
  createEffect(() => {
    const el = document.documentElement;
    el.dataset.theme = isDark() ? "dark" : "light";
    const [r, g, b] = hexToRgb(prefs.accent);
    el.style.setProperty("--accent", prefs.accent);
    el.style.setProperty("--accent-rgb", `${r}, ${g}, ${b}`);
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || dialog()) return;
    app.commands.handleKey(e);
  };
  const onUnload = () => void saveAll();

  onMount(async () => {
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onUnload);
    await loadBuiltins([corePlugin, readingTimePlugin, mermaidPlugin]);
    const args = await ipc.startupArgs().catch(() => [] as string[]);
    const vault = args[0] ?? prefs.lastVault;
    if (vault) await openVault(vault);
    if (args[0] && args[1]) await openNote(args[1].startsWith(args[0]) ? args[1].slice(args[0].length).replace(/^\/+/, "") : args[1]);
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
        <div class="shell" classList={{ "no-sidebar": !sidebarOpen() }}>
          <Show when={sidebarOpen()}>
            <Sidebar />
          </Show>
          <main class="workspace">
            <TabBar />
            <Show when={!graphOpen()} fallback={<GraphView />}>
            <Show when={state.active} fallback={<EmptyState />}>
              <Show when={prefs.layout !== "preview"}>
                <Toolbar />
              </Show>
              <div class="work-area" classList={{ [`layout-${prefs.layout}`]: true }}>
                <Show when={prefs.layout !== "preview"}>
                  <Editor />
                </Show>
                <Show when={prefs.layout !== "editor"}>
                  <RightPanel />
                </Show>
              </div>
            </Show>
            </Show>
            <StatusBar />
          </main>
        </div>
      </Show>

      <Switch>
        <Match when={dialog()?.kind === "palette" && dialog()}>
          {(d) => <CommandPalette mode={(d() as any).mode} onClose={() => setDialog(null)} />}
        </Match>
        <Match when={dialog()?.kind === "settings" && dialog()}>
          {(d) => <Settings tab={(d() as any).tab} onClose={() => setDialog(null)} />}
        </Match>
        <Match when={dialog()?.kind === "style" && dialog()}>
          {(d) => <StyleDialog styleKey={(d() as any).key} scope={(d() as any).scope} onClose={() => setDialog(null)} />}
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
      </Switch>

      <MenuHost />
      <PromptHost />
      <Toasts />
    </>
  );
}
