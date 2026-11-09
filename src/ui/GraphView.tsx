// Graph view. The vault's folder structure is the backbone: every folder is a
// node linked to the notes (and, optionally, attachments) inside it and to its
// subfolders, the vault being the root. On top of that it can draw [[links]]
// between notes and tags as nodes. A local mode shows only what is near the
// open note. Folders collapse with a click.
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, Simulation, SimulationNodeDatum } from "d3-force";
import { Waypoints, X, Maximize2, Search, SlidersHorizontal, RotateCcw, FolderTree, FolderOpen, FileText, ChevronsDownUp, ChevronsUpDown, Crosshair } from "lucide-solid";
import { basename, dirname, Entry, fileKind, ipc, stem } from "../core/ipc";
import { isDark, notesList, openNote, root, state, prefs, setPrefs, tree } from "../core/store";
import { openMenuAt } from "./primitives";
import { revealInTree } from "./Sidebar";

import { t } from "../core/i18n";
export const [graphOpen, setGraphOpen] = createSignal(false);

type Kind = "root" | "folder" | "note" | "file" | "tag";

interface Node extends SimulationNodeDatum {
  /** Note / file path, "dir:<folder>", "tag:<tag>", or "" for the vault. */
  id: string;
  label: string;
  kind: Kind;
  /** Top-level folder (or tag root), for the color. */
  group: string;
  degree: number;
  r: number;
  /** Folders: notes and files below it (shown on collapsed folders). */
  count: number;
  collapsed?: boolean;
  /** Folders: the folder note (`Folder/Folder.md` or `Folder/index.md`). */
  note?: string;
}

interface Edge {
  source: Node;
  target: Node;
  kind: "tree" | "link" | "tag";
}

export interface GraphOptions {
  folders: boolean;
  links: boolean;
  tags: boolean;
  files: boolean;
  orphans: boolean;
  labels: boolean;
  arrows: boolean;
  local: boolean;
  depth: number;
  colorBy: "folder" | "kind" | "none";
  nodeSize: number;
  linkDistance: number;
  repel: number;
  textFade: number;
  collapsed: string[];
}

const DEFAULTS: GraphOptions = {
  folders: true,
  links: true,
  tags: false,
  files: false,
  orphans: true,
  labels: true,
  arrows: false,
  local: false,
  depth: 2,
  colorBy: "folder",
  nodeSize: 1,
  linkDistance: 1,
  repel: 1,
  textFade: 1.2,
  collapsed: [],
};

const opts = (): GraphOptions => ({ ...DEFAULTS, ...(prefs.graph as Partial<GraphOptions>) });
const setOpt = <K extends keyof GraphOptions>(k: K, v: GraphOptions[K]) => setPrefs("graph", { ...(prefs.graph ?? {}), [k]: v });

const IGNORE = [/(^|\/)\.notez(\/|$)/, /(^|\/)\.trash(\/|$)/];

function allFiles(entries: Entry[], out: string[] = []): string[] {
  for (const e of entries) {
    if (e.is_dir) allFiles(e.children, out);
    else out.push(e.path);
  }
  return out;
}

/** The note that stands for a folder: `A/A.md`, `A/index.md` or `A/README.md`. */
function folderNote(dir: string, notes: Set<string>): string | undefined {
  const name = basename(dir);
  for (const n of [name, "index", "README", "_index"]) for (const ext of [".md", ".typ"]) if (notes.has(`${dir}/${n}${ext}`)) return `${dir}/${n}${ext}`;
  return undefined;
}

interface Data {
  notes: string[];
  files: string[];
  links: [string, string][];
  tags: Record<string, string[]>;
}

function buildGraph(d: Data, o: GraphOptions, active: string | null) {
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const collapsed = new Set(o.collapsed);
  const vaultName = basename(root() ?? "") || "Vault";
  const notes = d.notes.filter((p) => !IGNORE.some((r) => r.test(p)));
  const noteSet = new Set(notes);
  const files = o.files ? d.files.filter((p) => !noteSet.has(p) && !IGNORE.some((r) => r.test(p)) && fileKind(p) !== "other") : [];

  const mk = (id: string, label: string, kind: Kind, group: string) => {
    let n = nodes.get(id);
    if (!n) nodes.set(id, (n = { id, label, kind, group, degree: 0, r: 0, count: 0 }));
    return n;
  };
  const edge = (a: Node, b: Node, kind: Edge["kind"]) => {
    if (a === b) return;
    const key = a.id < b.id ? `${a.id}\0${b.id}` : `${b.id}\0${a.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source: a, target: b, kind });
    a.degree++;
    b.degree++;
  };
  const rootNode = mk("", vaultName, "root", "");

  // What a path is drawn as: itself, or the nearest collapsed folder above it.
  const shownAs = new Map<string, Node>();
  const folderNode = (dir: string): Node => {
    if (!dir) return rootNode;
    const id = `dir:${dir}`;
    const existing = nodes.get(id);
    if (existing) return existing;
    const parent = folderNode(dirname(dir));
    // Inside a collapsed folder: the folder stands for everything in it.
    if (parent.kind === "folder" && parent.collapsed) return parent;
    const n = mk(id, basename(dir), "folder", dir.split("/")[0]);
    n.collapsed = collapsed.has(dir);
    n.note = folderNote(dir, noteSet);
    edge(parent, n, "tree");
    return n;
  };
  const place = (p: string, kind: "note" | "file") => {
    const dir = dirname(p);
    if (o.folders) {
      const f = folderNode(dir);
      for (let x: Node | undefined = f; x && x.kind === "folder"; x = nodes.get(`dir:${dirname(x.id.slice(4))}`)) {
        x.count++;
        if (!dirname(x.id.slice(4))) break;
      }
      if (f.kind === "folder" && f.collapsed) {
        shownAs.set(p, f);
        return;
      }
      const n = mk(p, kind === "note" ? stem(p) : basename(p), kind, p.split("/").length > 1 ? p.split("/")[0] : "");
      shownAs.set(p, n);
      edge(f, n, "tree");
    } else {
      shownAs.set(p, mk(p, kind === "note" ? stem(p) : basename(p), kind, p.split("/").length > 1 ? p.split("/")[0] : ""));
    }
  };
  for (const p of notes) place(p, "note");
  for (const p of files) place(p, "file");

  if (o.links) {
    for (const [a, b] of d.links) {
      const s = shownAs.get(a);
      const t = shownAs.get(b);
      if (!s || !t) continue;
      // Attachments only when they are shown; links within a collapsed folder vanish.
      edge(s, t, "link");
    }
  }
  if (o.tags) {
    for (const [p, tags] of Object.entries(d.tags)) {
      const s = shownAs.get(p);
      if (!s) continue;
      for (const t of tags) edge(s, mk(`tag:${t.toLowerCase()}`, `#${t}`, "tag", `#${t.split("/")[0].toLowerCase()}`), "tag");
    }
  }

  let list = [...nodes.values()];
  let es = edges;
  // Local graph: what is within `depth` steps of the open note.
  if (o.local && active) {
    const start = shownAs.get(active);
    if (start) {
      const adj = new Map<Node, Node[]>();
      for (const e of es) {
        (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
        (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push(e.source);
      }
      const keep = new Set<Node>([start]);
      let frontier = [start];
      for (let i = 0; i < o.depth; i++) {
        const next: Node[] = [];
        for (const n of frontier) for (const m of adj.get(n) ?? []) if (!keep.has(m)) (keep.add(m), next.push(m));
        frontier = next;
      }
      list = list.filter((n) => keep.has(n));
      es = es.filter((e) => keep.has(e.source) && keep.has(e.target));
    }
  }
  if (!o.orphans) {
    // Notes and files with no edge but their folder's.
    const linked = new Set<Node>();
    for (const e of es) if (e.kind !== "tree") (linked.add(e.source), linked.add(e.target));
    const drop = new Set(list.filter((n) => (n.kind === "note" || n.kind === "file") && !linked.has(n)));
    list = list.filter((n) => !drop.has(n));
    es = es.filter((e) => !drop.has(e.source) && !drop.has(e.target));
  }
  // Degrees within what is shown.
  for (const n of list) n.degree = 0;
  for (const e of es) (e.source.degree++, e.target.degree++);
  for (const n of list) {
    const base =
      n.kind === "root" ? 11
      : n.kind === "folder" ? 6 + Math.min(7, Math.sqrt(n.collapsed ? n.count : n.degree) * 1.2)
      : n.kind === "tag" ? 4 + Math.min(5, Math.sqrt(n.degree))
      : n.kind === "file" ? 2.8
      : 3.2 + Math.min(4, Math.sqrt(n.degree) * 0.8);
    n.r = base * o.nodeSize;
  }
  return { nodes: list, edges: es };
}

// Distinct, theme-friendly hues per top-level folder.
const HUES = [262, 200, 330, 150, 28, 180, 300, 95, 0, 225, 50, 125];
const KIND_HUE: Record<Kind, number> = { root: 262, folder: 35, note: 215, file: 150, tag: 320 };

export default function GraphView() {
  let canvas!: HTMLCanvasElement;
  let wrap!: HTMLDivElement;
  const [query, setQuery] = createSignal("");
  const [counts, setCounts] = createSignal({ notes: 0, folders: 0, edges: 0 });
  const [panel, setPanel] = createSignal(false);
  const data: Data = { notes: [], files: [], links: [], tags: {} };

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
    const o = opts();
    const h = o.colorBy === "kind" ? KIND_HUE[n.kind] : o.colorBy === "none" ? 230 : (groupHue.get(n.group) ?? 230);
    const sat = o.colorBy === "none" ? (n.kind === "folder" ? 30 : 12) : isDark() ? 70 : 62;
    const big = n.kind === "folder" || n.kind === "tag";
    return isDark() ? `hsla(${h}, ${sat}%, ${big ? 68 : 62}%, ${alpha})` : `hsla(${h}, ${sat}%, ${big ? 46 : 52}%, ${alpha})`;
  };

  function shape(ctx: CanvasRenderingContext2D, n: Node) {
    const { x, y, r } = n as { x: number; y: number; r: number };
    ctx.beginPath();
    if (n.kind === "folder") {
      // Rounded square: a folder.
      const s = r * 1.7;
      ctx.roundRect(x - s / 2, y - s / 2, s, s, r * 0.45);
    } else if (n.kind === "tag") {
      ctx.moveTo(x, y - r * 1.2);
      ctx.lineTo(x + r * 1.2, y);
      ctx.lineTo(x, y + r * 1.2);
      ctx.lineTo(x - r * 1.2, y);
      ctx.closePath();
    } else if (n.kind === "file") {
      ctx.rect(x - r, y - r, r * 2, r * 2);
    } else ctx.arc(x, y, r, 0, Math.PI * 2);
  }

  function draw() {
    frame = 0;
    const o = opts();
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
    const match = (n: Node) => !q || n.label.toLowerCase().includes(q) || n.id.replace(/^dir:/, "").toLowerCase().startsWith(q);
    const focus = hover;
    const dim = (n: Node) => (focus ? !(n === focus || neighbors.has(n)) : !match(n));

    for (const e of edges) {
      const s = e.source;
      const t = e.target;
      const lit = focus && (s === focus || t === focus);
      const faded = focus ? !lit : q ? !(match(s) || match(t)) : false;
      ctx.beginPath();
      ctx.moveTo(s.x!, s.y!);
      ctx.lineTo(t.x!, t.y!);
      ctx.lineWidth = (e.kind === "tree" ? 1.3 : 0.9) / Math.sqrt(view.k);
      ctx.setLineDash(e.kind === "link" ? [4 / view.k, 3 / view.k] : e.kind === "tag" ? [1.5 / view.k, 2.5 / view.k] : []);
      ctx.strokeStyle = lit ? pal.accent : pal.border;
      ctx.globalAlpha = faded ? 0.1 : lit ? 0.95 : e.kind === "tree" ? 0.75 : 0.5;
      ctx.stroke();
      if (o.arrows && e.kind === "link") {
        // Arrowhead at the target's edge.
        const a = Math.atan2(t.y! - s.y!, t.x! - s.x!);
        const ex = t.x! - Math.cos(a) * (t.r + 1.5);
        const ey = t.y! - Math.sin(a) * (t.r + 1.5);
        const len = 5 / Math.sqrt(view.k);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - len * Math.cos(a - 0.45), ey - len * Math.sin(a - 0.45));
        ctx.lineTo(ex - len * Math.cos(a + 0.45), ey - len * Math.sin(a + 0.45));
        ctx.closePath();
        ctx.fillStyle = lit ? pal.accent : pal.border;
        ctx.fill();
      }
    }
    ctx.setLineDash([]);

    const active = state.active;
    for (const n of nodes) {
      ctx.globalAlpha = dim(n) ? 0.16 : 1;
      shape(ctx, n);
      ctx.fillStyle = nodeColor(n);
      ctx.fill();
      if (n.kind === "folder" || n.kind === "root") {
        ctx.lineWidth = 2 / view.k;
        ctx.strokeStyle = pal.bg;
        ctx.stroke();
      }
      if (n.kind === "folder" && n.collapsed) {
        // "+" on a collapsed folder.
        ctx.strokeStyle = pal.bg;
        ctx.lineWidth = 1.6 / Math.sqrt(view.k);
        const s = n.r * 0.45;
        ctx.beginPath();
        ctx.moveTo(n.x! - s, n.y!);
        ctx.lineTo(n.x! + s, n.y!);
        ctx.moveTo(n.x!, n.y! - s);
        ctx.lineTo(n.x!, n.y! + s);
        ctx.stroke();
      }
      if (n.id === active || n === focus || (n.kind === "folder" && n.note && n.note === active)) {
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, n.r * (n.kind === "folder" ? 1.25 : 1) + 3.5 / view.k + 1, 0, Math.PI * 2);
        ctx.lineWidth = 2 / view.k;
        ctx.strokeStyle = pal.accent;
        ctx.stroke();
      }
    }

    if (o.labels) {
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const n of nodes) {
        const near = focus && (n === focus || neighbors.has(n));
        const big = n.kind === "root" || n.kind === "folder" || n.kind === "tag";
        const show = big || view.k > o.textFade || near || (q && match(n)) || n.id === active;
        if (!show || (focus && !near)) continue;
        const size = (n.kind === "root" ? 14 : big ? 12.5 : 11) / Math.max(0.75, Math.min(view.k, 1.6));
        ctx.font = `${big ? 650 : 500} ${size}px ${pal.font}`;
        ctx.globalAlpha = dim(n) ? 0.25 : 1;
        ctx.lineWidth = 3 / view.k;
        ctx.strokeStyle = pal.bg;
        let label = n.label.length > 34 ? n.label.slice(0, 32) + "…" : n.label;
        if (n.kind === "folder" && n.collapsed) label += ` (${n.count})`;
        const dy = n.r * (n.kind === "folder" ? 0.85 : n.kind === "tag" ? 1.2 : 1) + 3;
        ctx.strokeText(label, n.x!, n.y! + dy);
        ctx.fillStyle = n === focus ? pal.fg : big ? pal.fg : pal.muted;
        ctx.fillText(label, n.x!, n.y! + dy);
      }
    }
    ctx.globalAlpha = 1;
  }
  const redraw = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };

  function rebuild() {
    const o = opts();
    const old = new Map(nodes.map((n) => [n.id, n]));
    const ex = prefs.excludedFolders.map((f) => f.replace(/^\/+|\/+$/g, "")).filter(Boolean);
    const keep = (p: string) => !ex.some((f) => p === f || p.startsWith(f + "/"));
    data.notes = notesList().filter(keep);
    data.files = allFiles(tree()).filter(keep);
    const g = buildGraph(data, o, state.active);
    for (const n of g.nodes) {
      const o2 = old.get(n.id);
      if (o2) Object.assign(n, { x: o2.x, y: o2.y, vx: o2.vx, vy: o2.vy });
      else if (n.kind !== "root") {
        // New nodes (an expanded folder's children) start at their parent.
        const p = g.edges.find((e) => e.target === n && old.has(e.source.id))?.source;
        const at = p ? old.get(p.id) : undefined;
        if (at) Object.assign(n, { x: (at.x ?? 0) + (Math.random() - 0.5) * 20, y: (at.y ?? 0) + (Math.random() - 0.5) * 20 });
      }
    }
    nodes = g.nodes;
    edges = g.edges;
    // The hovered node was replaced (or is gone): highlight its successor.
    if (hover) {
      const id = hover.id;
      hover = null;
      setHover(nodes.find((n) => n.id === id) ?? null);
    }
    const groups = [...new Set(nodes.map((n) => n.group).filter(Boolean))].sort();
    groupHue = new Map(groups.map((g, i) => [g, HUES[i % HUES.length]]));
    setCounts({
      notes: nodes.filter((n) => n.kind === "note").length,
      folders: nodes.filter((n) => n.kind === "folder").length,
      edges: edges.length,
    });
    const rootNode = nodes.find((n) => n.kind === "root");
    if (rootNode && o.folders && !o.local) (rootNode.fx = 0), (rootNode.fy = 0);
    else if (rootNode) (rootNode.fx = null), (rootNode.fy = null);
    sim?.stop();
    const dist = o.linkDistance;
    sim = forceSimulation<Node, Edge>(nodes)
      .force(
        "link",
        forceLink<Node, Edge>(edges)
          .distance((e) => dist * (e.kind === "link" ? 90 : e.kind === "tag" ? 60 : e.target.kind === "folder" || e.source.kind === "root" ? 70 : 34))
          .strength((e) => (e.kind === "tree" ? 0.9 : o.folders ? 0.06 : 0.4)),
      )
      .force("charge", forceManyBody<Node>().strength((n) => o.repel * (n.kind === "note" || n.kind === "file" ? -60 : -240)).distanceMax(600))
      .force("collide", forceCollide<Node>((n) => n.r * (n.kind === "folder" ? 1.25 : 1) + 3))
      .force("x", forceX<Node>(0).strength(0.03))
      .force("y", forceY<Node>(0).strength(0.03))
      .alpha(old.size ? 0.5 : 1)
      .on("tick", redraw);
    redraw();
  }

  async function loadExtra() {
    const ex = [...prefs.excludedFolders];
    const [links, meta] = await Promise.all([ipc.graphLinks(ex).catch(() => [] as [string, string][]), ipc.noteMeta().catch(() => ({}))]);
    data.links = links;
    data.tags = Object.fromEntries(Object.entries(meta).map(([p, m]) => [p, m.tags ?? []]).filter(([, t]) => t.length));
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
      const reach = n.r * (n.kind === "folder" || n.kind === "tag" ? 1.2 : 1) + 4 / view.k;
      if (d < reach && d < bd) (best = n), (bd = d);
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

  const toggleFolder = (n: Node) => {
    const dir = n.id.slice(4);
    const c = new Set(opts().collapsed);
    if (c.has(dir)) c.delete(dir);
    else c.add(dir);
    setOpt("collapsed", [...c]);
  };
  const setAllCollapsed = (on: boolean) => {
    if (!on) return setOpt("collapsed", []);
    // Collapse the top-level folders (everything is then inside one).
    const tops = new Set(data.notes.concat(opts().files ? data.files : []).filter((p) => p.includes("/")).map((p) => p.split("/")[0]));
    setOpt("collapsed", [...tops]);
  };
  const activate = (n: Node, e?: MouseEvent) => {
    if (n.kind === "folder") {
      if (e && (e.ctrlKey || e.metaKey) && n.note) return open(n.note);
      return toggleFolder(n);
    }
    if (n.kind === "tag") {
      setQuery(n.label.slice(1));
      return;
    }
    if (n.id) open(n.id);
  };
  const open = (p: string) => {
    setGraphOpen(false);
    void openNote(p);
  };
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    const n = hit(e);
    if (!n) {
      openMenuAt(e.clientX, e.clientY, [
        { label: t("Fit to screen"), icon: <Maximize2 size={15} />, run: fit },
        { label: t("Collapse all folders"), icon: <ChevronsDownUp size={15} />, run: () => setAllCollapsed(true) },
        { label: t("Expand all folders"), icon: <ChevronsUpDown size={15} />, run: () => setAllCollapsed(false) },
      ]);
      return;
    }
    if (n.kind === "folder") {
      const dir = n.id.slice(4);
      openMenuAt(e.clientX, e.clientY, [
        { label: n.collapsed ? t("Expand folder") : t("Collapse folder"), icon: n.collapsed ? <ChevronsUpDown size={15} /> : <ChevronsDownUp size={15} />, run: () => toggleFolder(n) },
        ...(n.note ? [{ label: t("Open folder note"), icon: <FileText size={15} />, run: () => open(n.note!) }] : []),
        { label: t("Reveal in file tree"), icon: <FolderTree size={15} />, run: () => (setGraphOpen(false), revealInTree(dir)) },
        { label: t("Show only this folder"), icon: <Crosshair size={15} />, run: () => setQuery(dir + "/") },
      ]);
    } else if (n.kind === "note" || n.kind === "file") {
      openMenuAt(e.clientX, e.clientY, [
        { label: t("Open"), icon: <FileText size={15} />, run: () => open(n.id) },
        { label: t("Local graph of this note"), icon: <Crosshair size={15} />, run: () => (open(n.id), setOpt("local", true), setGraphOpen(true)) },
        { label: t("Reveal in file tree"), icon: <FolderOpen size={15} />, run: () => (setGraphOpen(false), revealInTree(n.id)) },
      ]);
    }
  };

  let drag: { node: Node | null; sx: number; sy: number; vx: number; vy: number; moved: boolean; ev: MouseEvent } | null = null;
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const n = hit(e);
    drag = { node: n, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false, ev: e };
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
    const { node, moved, ev } = drag;
    drag = null;
    if (node && node.kind !== "root") {
      // A dragged node stays where it was put (Alt-drag lets it go back).
      if (!moved || ev.altKey) (node.fx = null), (node.fy = null);
      sim?.alphaTarget(0);
    }
    canvas.style.cursor = hover ? "pointer" : "grab";
    if (node && !moved) activate(node, ev);
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
    if (e.key === "Escape" && !(e.target as HTMLElement).closest?.("input")) (panel() ? setPanel(false) : setGraphOpen(false));
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
    await loadExtra();
    rebuild();
    sim!.tick(140);
    fit();
  });

  // Opening a note anywhere (sidebar, tabs, palette) leaves the graph.
  createEffect(on(() => state.active, () => setGraphOpen(false), { defer: true }));
  // Structure options rebuild; the rest only redraw.
  createEffect(
    on(
      () => {
        const o = opts();
        return [o.folders, o.links, o.tags, o.files, o.orphans, o.local, o.depth, o.nodeSize, o.linkDistance, o.repel, o.collapsed.join("\n"), notesList(), tree()];
      },
      () => nodes.length && rebuild(),
      { defer: true },
    ),
  );
  createEffect(on([() => JSON.stringify(prefs.graph), query, () => state.active], redraw, { defer: true }));
  createEffect(on(isDark, () => ((pal = colors()), redraw()), { defer: true }));

  const Toggle = (p: { k: "folders" | "links" | "tags" | "files" | "orphans" | "labels" | "arrows" | "local"; label: string; hint?: string }) => (
    <label class="graph-toggle" title={p.hint}>
      <input type="checkbox" checked={opts()[p.k]} onChange={(e) => setOpt(p.k, e.currentTarget.checked)} /> {p.label}
    </label>
  );
  const Slider = (p: { k: "nodeSize" | "linkDistance" | "repel" | "textFade" | "depth"; label: string; min: number; max: number; step: number }) => (
    <label class="graph-slider">
      <span>{p.label} <b>{opts()[p.k]}</b></span>
      <input type="range" min={p.min} max={p.max} step={p.step} value={opts()[p.k]} onInput={(e) => setOpt(p.k, Number(e.currentTarget.value))} />
    </label>
  );

  return (
    <div class="graph-view">
      <div class="graph-bar">
        <span class="graph-title">
          <Waypoints size={16} /> {t("Graph")}
          <small>
            {t("{notes} notes · {folders} folders · {edges} connections", counts())}
          </small>
        </span>
        <div class="spacer" />
        <label class="graph-search">
          <Search size={14} />
          <input placeholder={t("Filter…")} value={query()} onInput={(e) => setQuery(e.currentTarget.value)} dir="auto" />
        </label>
        <Toggle k="local" label={t("Local")} hint={t("Only what is near the open note")} />
        <Toggle k="links" label={t("Links")} hint={t("[[links]] between notes (dashed)")} />
        <Toggle k="labels" label={t("Labels")} />
        <button class="icon-btn" classList={{ active: panel() }} title={t("Graph options")} onClick={() => setPanel(!panel())}>
          <SlidersHorizontal size={15} />
        </button>
        <button class="icon-btn" title={t("Fit to screen")} onClick={fit}>
          <Maximize2 size={15} />
        </button>
        <button class="icon-btn" title={t("Close graph (Esc)")} onClick={() => setGraphOpen(false)}>
          <X size={16} />
        </button>
      </div>
      <div class="graph-canvas" ref={wrap}>
        <canvas ref={canvas} onMouseDown={onDown} onMouseMove={onMove} onMouseLeave={() => !drag && setHover(null)} onWheel={onWheel} onContextMenu={menu} />
        <Show when={counts().notes === 0 && counts().folders === 0}>
          <div class="graph-empty">{opts().local ? t("Open a note to see its local graph") : t("No notes in this vault yet")}</div>
        </Show>
        <Show when={panel()}>
          <div class="graph-panel">
            <h4>{t("Show")}</h4>
            <Toggle k="folders" label={t("Folders")} hint={t("Each folder is a node linked to what is inside it")} />
            <Toggle k="links" label={t("Note links")} />
            <Toggle k="tags" label={t("Tags")} />
            <Toggle k="files" label={t("Attachments (images, PDFs)")} />
            <Toggle k="orphans" label={t("Notes without links")} />
            <Toggle k="arrows" label={t("Link arrows")} />
            <Toggle k="labels" label={t("Labels")} />
            <h4>{t("Local graph")}</h4>
            <Toggle k="local" label={t("Only around the open note")} />
            <Slider k="depth" label={t("Depth")} min={1} max={5} step={1} />
            <h4>{t("Color by")}</h4>
            <div class="segmented small">
              <For each={[["folder", "Folder"], ["kind", "Type"], ["none", "None"]] as const}>
                {([v, l]) => <button classList={{ active: opts().colorBy === v }} onClick={() => setOpt("colorBy", v)}>{l}</button>}
              </For>
            </div>
            <h4>{t("Folders")}</h4>
            <div class="row gap">
              <button class="btn small" onClick={() => setAllCollapsed(true)}><ChevronsDownUp size={13} /> {t("Collapse all")}</button>
              <button class="btn small" onClick={() => setAllCollapsed(false)}><ChevronsUpDown size={13} /> {t("Expand all")}</button>
            </div>
            <h4>{t("Display")}</h4>
            <Slider k="nodeSize" label={t("Node size")} min={0.5} max={2.5} step={0.1} />
            <Slider k="linkDistance" label={t("Link distance")} min={0.4} max={3} step={0.1} />
            <Slider k="repel" label={t("Repel force")} min={0.2} max={4} step={0.1} />
            <Slider k="textFade" label={t("Note labels from zoom")} min={0.3} max={3} step={0.1} />
            <button class="btn small" onClick={() => setPrefs("graph", {})}><RotateCcw size={13} /> {t("Reset options")}</button>
          </div>
        </Show>
        <div class="graph-legend">
          <Show when={opts().folders}>
            <span><i class="dot folder" /> {t("Folder — click to collapse")}</span>
          </Show>
          <span><i class="dot" /> {t("Note")}</span>
          <Show when={opts().links}>
            <span><i class="line dashed" /> {t("Link")}</span>
          </Show>
          <Show when={opts().tags}>
            <span><i class="dot tag" /> {t("Tag")}</span>
          </Show>
        </div>
      </div>
    </div>
  );
}
