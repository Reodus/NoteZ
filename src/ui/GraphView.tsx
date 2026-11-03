// Graph view, wired like the Obsidian Waypoint plugin: every folder may have a
// folder note inside it (`Folder/Folder.md`), and that note is the hub for
// everything in the folder — its notes and the folder notes of its
// subfolders. Folders without a folder note pass their children up to the
// nearest ancestor that has one; the vault itself is the root hub.
// Ordinary [[links]] between notes can be shown on top as a second layer.
import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, Simulation, SimulationNodeDatum } from "d3-force";
import { Waypoints, X, Maximize2, Search } from "lucide-solid";
import { basename, dirname, ipc, stem } from "../core/ipc";
import { isDark, notesList, openNote, root, state, prefs } from "../core/store";

export const [graphOpen, setGraphOpen] = createSignal(false);

type Kind = "root" | "hub" | "note";

interface Node extends SimulationNodeDatum {
  id: string; // note path, or "" for the vault
  label: string;
  kind: Kind;
  group: string; // top-level folder (color)
  degree: number;
  r: number;
}

interface Edge {
  source: Node;
  target: Node;
  kind: "waypoint" | "link";
}

const IGNORE = [/(^|\/)_attachments(\/|$)/, /(^|\/)\.notez(\/|$)/];

/** `Folder/Folder.md` (or .typ) — the Waypoint "inside folder" folder note. */
function folderNoteOf(dir: string, all: Set<string>): string | null {
  if (!dir) return null;
  const name = basename(dir);
  for (const ext of [".md", ".typ"]) if (all.has(`${dir}/${name}${ext}`)) return `${dir}/${name}${ext}`;
  return null;
}

/** Nearest folder note at or above `dir` ("" = vault root hub). */
function hubAbove(dir: string, all: Set<string>): string {
  for (let d = dir; d; d = dirname(d)) {
    const f = folderNoteOf(d, all);
    if (f) return f;
  }
  return "";
}

function buildGraph(notes: string[], links: [string, string][], withLinks: boolean) {
  const paths = notes.filter((p) => !IGNORE.some((r) => r.test(p)));
  const all = new Set(paths);
  const nodes = new Map<string, Node>();
  const vaultName = basename(root() ?? "") || "Vault";
  nodes.set("", { id: "", label: vaultName, kind: "root", group: "", degree: 0, r: 0 });
  for (const p of paths) {
    const isHub = folderNoteOf(dirname(p), all) === p;
    nodes.set(p, { id: p, label: stem(p), kind: isHub ? "hub" : "note", group: p.split("/")[0] ?? "", degree: 0, r: 0 });
  }
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const add = (a: string, b: string, kind: Edge["kind"]) => {
    const s = nodes.get(a);
    const t = nodes.get(b);
    if (!s || !t || s === t) return;
    const key = a < b ? `${a}\0${b}` : `${b}\0${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source: s, target: t, kind });
    s.degree++;
    t.degree++;
  };
  // Waypoint tree first, so a link that duplicates it stays a tree edge.
  for (const p of paths) {
    const dir = dirname(p);
    const parent = folderNoteOf(dir, all) === p ? hubAbove(dirname(dir), all) : hubAbove(dir, all);
    add(parent, p, "waypoint");
  }
  if (withLinks) for (const [a, b] of links) add(a, b, "link");
  for (const n of nodes.values()) {
    n.r = n.kind === "root" ? 11 : n.kind === "hub" ? 6.5 + Math.min(6, Math.sqrt(n.degree) * 1.3) : 3.2 + Math.min(4, Math.sqrt(n.degree) * 0.8);
  }
  return { nodes: [...nodes.values()], edges };
}

// Distinct, theme-friendly hues per top-level folder.
const HUES = [262, 200, 330, 150, 28, 180, 300, 95, 0, 225, 50, 125];

export default function GraphView() {
  let canvas!: HTMLCanvasElement;
  let wrap!: HTMLDivElement;
  const [showLinks, setShowLinks] = createSignal(false);
  const [showLabels, setShowLabels] = createSignal(true);
  const [query, setQuery] = createSignal("");
  const [counts, setCounts] = createSignal({ notes: 0, edges: 0 });
  let links: [string, string][] = [];

  let nodes: Node[] = [];
  let edges: Edge[] = [];
  let sim: Simulation<Node, Edge> | null = null;
  let view = { x: 0, y: 0, k: 1 };
  let hover: Node | null = null;
  let neighbors = new Set<Node>();
  let groupHue = new Map<string, number>();
  let frame = 0;

  const colors = () => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string) => cs.getPropertyValue(n).trim();
    return { fg: v("--fg"), muted: v("--fg-muted"), faint: v("--fg-faint"), accent: v("--accent"), bg: v("--canvas"), border: v("--border-strong"), font: getComputedStyle(document.body).fontFamily };
  };
  let pal = colors();

  const nodeColor = (n: Node, alpha = 1) => {
    if (n.kind === "root") return pal.accent;
    const h = groupHue.get(n.group) ?? 230;
    return isDark() ? `hsla(${h}, 70%, ${n.kind === "hub" ? 68 : 62}%, ${alpha})` : `hsla(${h}, 62%, ${n.kind === "hub" ? 46 : 52}%, ${alpha})`;
  };

  function draw() {
    frame = 0;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(w / 2 + view.x, h / 2 + view.y);
    ctx.scale(view.k, view.k);

    const q = query().trim().toLowerCase();
    const match = (n: Node) => !q || n.label.toLowerCase().includes(q);
    const focus = hover;
    const dim = (n: Node) => (focus ? !(n === focus || neighbors.has(n)) : !match(n));

    // Edges
    for (const e of edges) {
      const s = e.source;
      const t = e.target;
      const lit = focus && (s === focus || t === focus);
      const faded = focus ? !lit : q ? !(match(s) || match(t)) : false;
      ctx.beginPath();
      ctx.moveTo(s.x!, s.y!);
      ctx.lineTo(t.x!, t.y!);
      ctx.lineWidth = (e.kind === "waypoint" ? 1.3 : 0.9) / Math.sqrt(view.k);
      ctx.setLineDash(e.kind === "link" ? [4 / view.k, 3 / view.k] : []);
      ctx.strokeStyle = lit ? pal.accent : pal.border;
      ctx.globalAlpha = faded ? 0.12 : lit ? 0.95 : e.kind === "link" ? 0.45 : 0.75;
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Nodes
    const active = state.active;
    for (const n of nodes) {
      ctx.globalAlpha = dim(n) ? 0.18 : 1;
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
      ctx.fillStyle = nodeColor(n);
      ctx.fill();
      if (n.kind !== "note") {
        ctx.lineWidth = 2 / view.k;
        ctx.strokeStyle = pal.bg;
        ctx.stroke();
      }
      if (n.id === active || n === focus) {
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, n.r + 3.5 / view.k + 1, 0, Math.PI * 2);
        ctx.lineWidth = 2 / view.k;
        ctx.strokeStyle = pal.accent;
        ctx.stroke();
      }
    }

    // Labels: hubs always, notes when zoomed in / highlighted.
    if (showLabels()) {
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const n of nodes) {
        const near = focus && (n === focus || neighbors.has(n));
        const show = n.kind !== "note" || view.k > 1.35 || near || (q && match(n));
        if (!show || (focus && !near)) continue;
        const size = (n.kind === "root" ? 14 : n.kind === "hub" ? 12.5 : 11) / Math.max(0.75, Math.min(view.k, 1.6));
        ctx.font = `${n.kind === "note" ? 500 : 650} ${size}px ${pal.font}`;
        ctx.globalAlpha = dim(n) ? 0.25 : 1;
        ctx.lineWidth = 3 / view.k;
        ctx.strokeStyle = pal.bg;
        const label = n.label.length > 34 ? n.label.slice(0, 32) + "…" : n.label;
        ctx.strokeText(label, n.x!, n.y! + n.r + 3);
        ctx.fillStyle = n === focus ? pal.fg : n.kind === "note" ? pal.muted : pal.fg;
        ctx.fillText(label, n.x!, n.y! + n.r + 3);
      }
    }
    ctx.globalAlpha = 1;
  }
  const redraw = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };

  function rebuild() {
    const old = new Map(nodes.map((n) => [n.id, n]));
    const ex = prefs.excludedFolders.map((f) => f.replace(/^\/+|\/+$/g, "")).filter(Boolean);
    const notes = notesList().filter((p) => !ex.some((f) => p === f || p.startsWith(f + "/")));
    const g = buildGraph(notes, links, showLinks());
    // Keep positions of nodes that already exist (toggling links, file changes).
    for (const n of g.nodes) {
      const o = old.get(n.id);
      if (o) Object.assign(n, { x: o.x, y: o.y, vx: o.vx, vy: o.vy });
    }
    nodes = g.nodes;
    edges = g.edges;
    const groups = [...new Set(nodes.map((n) => n.group).filter(Boolean))].sort();
    groupHue = new Map(groups.map((g, i) => [g, HUES[i % HUES.length]]));
    setCounts({ notes: nodes.length - 1, edges: edges.length });
    const rootNode = nodes.find((n) => n.kind === "root")!;
    rootNode.fx = 0;
    rootNode.fy = 0;
    sim?.stop();
    sim = forceSimulation<Node, Edge>(nodes)
      .force(
        "link",
        forceLink<Node, Edge>(edges)
          .distance((e) => (e.kind === "link" ? 90 : e.target.kind === "hub" || e.source.kind === "root" ? 70 : 34))
          .strength((e) => (e.kind === "link" ? 0.05 : 0.9)),
      )
      .force("charge", forceManyBody<Node>().strength((n) => (n.kind === "note" ? -60 : -260)).distanceMax(600))
      .force("collide", forceCollide<Node>((n) => n.r + 3))
      .force("x", forceX<Node>(0).strength(0.03))
      .force("y", forceY<Node>(0).strength(0.03))
      .alpha(old.size ? 0.5 : 1)
      .on("tick", redraw);
  }

  function fit() {
    if (!nodes.length) return;
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const w = canvas.clientWidth - 80;
    const h = canvas.clientHeight - 80;
    const k = Math.max(0.15, Math.min(2.5, Math.min(w / Math.max(1, x1 - x0), h / Math.max(1, y1 - y0))));
    view = { k, x: -((x0 + x1) / 2) * k, y: -((y0 + y1) / 2) * k };
    redraw();
  }

  // Screen → graph coordinates, and hit testing.
  const toGraph = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - r.width / 2 - view.x) / view.k, y: (e.clientY - r.top - r.height / 2 - view.y) / view.k };
  };
  const hit = (e: MouseEvent) => {
    const p = toGraph(e);
    let best: Node | null = null;
    let bd = Infinity;
    for (const n of nodes) {
      const d = Math.hypot(n.x! - p.x, n.y! - p.y);
      if (d < n.r + 4 / view.k && d < bd) (best = n), (bd = d);
    }
    return best;
  };
  const setHover = (n: Node | null) => {
    if (n === hover) return;
    hover = n;
    neighbors = new Set();
    if (n) for (const e of edges) e.source === n ? neighbors.add(e.target) : e.target === n && neighbors.add(e.source);
    canvas.style.cursor = n ? "pointer" : "grab";
    redraw();
  };

  let drag: { node: Node | null; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null = null;
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const n = hit(e);
    drag = { node: n, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    if (n && n.kind !== "root") {
      const p = toGraph(e);
      n.fx = p.x;
      n.fy = p.y;
      sim?.alphaTarget(0.25).restart();
    }
    canvas.style.cursor = "grabbing";
  };
  const onMove = (e: MouseEvent) => {
    if (!drag) return setHover(hit(e));
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 3) drag.moved = true;
    if (drag.node && drag.node.kind !== "root") {
      const p = toGraph(e);
      drag.node.fx = p.x;
      drag.node.fy = p.y;
    } else if (!drag.node) {
      view.x = drag.vx + e.clientX - drag.sx;
      view.y = drag.vy + e.clientY - drag.sy;
      redraw();
    }
  };
  const onUp = () => {
    if (!drag) return;
    const { node, moved } = drag;
    drag = null;
    if (node && node.kind !== "root") {
      node.fx = null;
      node.fy = null;
      sim?.alphaTarget(0);
    }
    canvas.style.cursor = hover ? "pointer" : "grab";
    if (node && !moved && node.id) {
      setGraphOpen(false);
      void openNote(node.id);
    }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left - r.width / 2;
    const my = e.clientY - r.top - r.height / 2;
    const k = Math.max(0.1, Math.min(6, view.k * Math.exp(-e.deltaY * 0.0015)));
    view.x = mx - ((mx - view.x) * k) / view.k;
    view.y = my - ((my - view.y) * k) / view.k;
    view.k = k;
    redraw();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !(e.target as HTMLElement).closest?.("input")) setGraphOpen(false);
  };

  onMount(async () => {
    const ro = new ResizeObserver(redraw);
    ro.observe(wrap);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
      sim?.stop();
      cancelAnimationFrame(frame);
    });
    rebuild();
    // Settle a little before the first paint, then frame the whole graph.
    sim!.tick(120);
    fit();
    links = await ipc.graphLinks([...prefs.excludedFolders]).catch(() => []);
    if (showLinks()) rebuild();
  });

  // Opening a note anywhere (sidebar, tabs, palette) leaves the graph.
  createEffect(on(() => state.active, () => setGraphOpen(false), { defer: true }));
  createEffect(on([showLinks, notesList], () => nodes.length && rebuild(), { defer: true }));
  createEffect(on([showLabels, query, () => state.active], redraw, { defer: true }));
  createEffect(on(isDark, () => ((pal = colors()), redraw()), { defer: true }));

  return (
    <div class="graph-view">
      <div class="graph-bar">
        <span class="graph-title">
          <Waypoints size={16} /> Graph
          <small>
            {counts().notes} notes · {counts().edges} connections
          </small>
        </span>
        <div class="spacer" />
        <label class="graph-search">
          <Search size={14} />
          <input placeholder="Filter…" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} dir="auto" />
        </label>
        <label class="graph-toggle" title="Also draw [[links]] between notes (dashed)">
          <input type="checkbox" checked={showLinks()} onChange={(e) => setShowLinks(e.currentTarget.checked)} /> Note links
        </label>
        <label class="graph-toggle">
          <input type="checkbox" checked={showLabels()} onChange={(e) => setShowLabels(e.currentTarget.checked)} /> Labels
        </label>
        <button class="icon-btn" title="Fit to screen" onClick={fit}>
          <Maximize2 size={15} />
        </button>
        <button class="icon-btn" title="Close graph (Esc)" onClick={() => setGraphOpen(false)}>
          <X size={16} />
        </button>
      </div>
      <div class="graph-canvas" ref={wrap}>
        <canvas ref={canvas} onMouseDown={onDown} onMouseMove={onMove} onMouseLeave={() => !drag && setHover(null)} onWheel={onWheel} />
        <Show when={counts().notes === 0}>
          <div class="graph-empty">No notes in this vault yet</div>
        </Show>
        <div class="graph-legend">
          <span><i class="dot hub" /> Folder note (Waypoint hub)</span>
          <span><i class="line" /> Waypoint</span>
          <Show when={showLinks()}>
            <span><i class="line dashed" /> Link</span>
          </Show>
        </div>
      </div>
    </div>
  );
}
