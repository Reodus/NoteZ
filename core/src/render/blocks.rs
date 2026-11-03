//! Special fenced code blocks → Typst.
//!
//! | lang            | content                                   | engine   |
//! |-----------------|-------------------------------------------|----------|
//! | `chart`         | YAML: bar/hbar/line/scatter/area/pie/donut | Lilaq/CeTZ |
//! | `flow`          | `A[Start] -> B{Ok?}`, `B -> C : yes`       | Fletcher (auto layout) |
//! | `diagram`       | raw Fletcher: `node(..), edge(..)`         | Fletcher |
//! | `mindmap`       | indented list                             | Fletcher |
//! | `timeline`      | `1402: event` per line                    | CeTZ     |
//! | `draw` / `cetz` | raw CeTZ draw commands                     | CeTZ     |
//! | `math` / `latex`| LaTeX display math                        | MiTeX    |
//! | `typst`         | passed through verbatim                   | —        |
//!
//! Text inside blocks may be Persian or English; each label is shaped by
//! Typst, while the drawing itself is laid out left-to-right.

use serde_yaml_ng::Value;
use std::collections::HashMap;

use super::{escape_markup as esc, typst_str as q};

#[derive(Default)]
pub struct BlockCtx {
    pub count: usize,
}

pub type BlockResult = Result<(String, Vec<&'static str>), String>;

pub const PALETTE: &[&str] =
    &["#4e79d6", "#f28e2b", "#3fb68b", "#e15759", "#9467bd", "#edc948", "#17becf", "#ff9da7", "#8c6d31", "#79706e"];

/// Wrap a drawing: centered, laid out LTR (labels still shape correctly).
fn figure(body: &str, caption: Option<&str>) -> String {
    let inner = format!("block(breakable: false)[#set text(dir: ltr)\n#{body}]");
    match caption {
        Some(c) if !c.trim().is_empty() => {
            format!("#figure({inner}, caption: [{}], kind: image)", esc(c))
        }
        _ => format!("#align(center, {inner})"),
    }
}

pub fn render(lang: &str, code: &str, ctx: &mut BlockCtx) -> Option<BlockResult> {
    ctx.count += 1;
    Some(match lang {
        "typst" | "typ" => Ok((code.to_string(), vec![])),
        "math" | "latex" | "tex" => Ok((format!("#mitex({})", q(code.trim())), vec!["mitex"])),
        "chart" | "plot" => chart(code),
        "flow" | "flowchart" => flow(code),
        "diagram" | "fletcher" => Ok((
            figure(&format!("diagram(node-stroke: 0.7pt, spacing: (2.4em, 2em), edge-stroke: 0.7pt, {})", code.trim()), None),
            vec!["fletcher"],
        )),
        "mindmap" => mindmap(code),
        "timeline" => timeline(code),
        "draw" | "cetz" => Ok((
            figure(&format!("cetz.canvas({{\nimport cetz.draw: *\n{}\n}})", code.trim()), None),
            vec!["cetz"],
        )),
        _ => return None,
    })
}

pub fn error_box(lang: &str, msg: &str) -> String {
    format!(
        "#block(width: 100%, inset: 10pt, radius: 4pt, fill: rgb(\"#fdecec\"), stroke: 0.6pt + rgb(\"#d13c3c\"))[#set text(dir: ltr, size: 0.85em, fill: rgb(\"#a02020\"))\n*{} block:* {}]",
        esc(lang),
        esc(msg)
    )
}

// ------------------------------------------------------------------ chart

fn as_str(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn as_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().replace(',', "").parse().ok(),
        _ => None,
    }
}

fn nums(v: Option<&Value>) -> Option<Vec<f64>> {
    v?.as_sequence()?.iter().map(as_f64).collect()
}

fn strs(v: Option<&Value>) -> Option<Vec<String>> {
    v?.as_sequence()?.iter().map(as_str).collect()
}

fn arr(xs: &[f64]) -> String {
    let mut s = xs.iter().map(|x| format!("{x}")).collect::<Vec<_>>().join(", ");
    if xs.len() == 1 {
        s.push(',');
    }
    format!("({s})")
}

fn length_or(v: Option<&Value>, default: &str) -> String {
    v.and_then(as_str).filter(|s| super::is_length(s)).unwrap_or_else(|| default.to_string())
}

struct Series {
    name: Option<String>,
    values: Vec<f64>,
    color: String,
}

fn chart(code: &str) -> BlockResult {
    let spec: Value = serde_yaml_ng::from_str(code).map_err(|e| format!("invalid YAML: {e}"))?;
    let map = spec.as_mapping().ok_or("expected key: value pairs")?;
    let get = |k: &str| map.get(Value::String(k.into()));
    let kind = get("type").and_then(as_str).unwrap_or_else(|| "bar".into()).to_lowercase();
    let title = get("title").and_then(as_str);
    let caption = get("caption").and_then(as_str);
    let colors: Vec<String> = strs(get("colors"))
        .unwrap_or_default()
        .into_iter()
        .filter(|c| super::styles::color(c).is_some())
        .collect();
    let color_at = |i: usize| colors.get(i).cloned().unwrap_or_else(|| PALETTE[i % PALETTE.len()].to_string());

    // Categories + series, from either `data:` map or `labels:` + `series:`/`values:`.
    let mut labels: Vec<String> = strs(get("labels")).unwrap_or_default();
    let mut series: Vec<Series> = Vec::new();
    if let Some(Value::Mapping(data)) = get("data") {
        let mut vals = Vec::new();
        for (k, v) in data {
            labels.push(as_str(k).ok_or("data keys must be text")?);
            vals.push(as_f64(v).ok_or("data values must be numbers")?);
        }
        series.push(Series { name: None, values: vals, color: color_at(0) });
    }
    if let Some(Value::Sequence(list)) = get("series") {
        for (i, s) in list.iter().enumerate() {
            let m = s.as_mapping().ok_or("each series needs name + values")?;
            let values = nums(m.get(Value::String("values".into()))).ok_or("series values must be numbers")?;
            let name = m.get(Value::String("name".into())).and_then(as_str);
            let color = m
                .get(Value::String("color".into()))
                .and_then(as_str)
                .filter(|c| super::styles::color(c).is_some())
                .unwrap_or_else(|| color_at(i));
            series.push(Series { name, values, color });
        }
    }
    if let Some(v) = nums(get("values")) {
        series.push(Series { name: None, values: v, color: color_at(series.len()) });
    }
    let xs = nums(get("x"));
    if let Some(y) = nums(get("y")) {
        series.push(Series { name: get("name").and_then(as_str), values: y, color: color_at(series.len()) });
    }
    if series.is_empty() {
        return Err("no data — use `data:`, `values:`, `series:` or `x:`/`y:`".into());
    }

    if kind == "pie" || kind == "donut" {
        return pie(&labels, &series[0].values, &series, kind == "donut", title.as_deref(), caption.as_deref(), &color_at);
    }

    let width = length_or(get("width"), "12cm");
    let height = length_or(get("height"), "6.5cm");
    let mut args = vec![format!("width: {width}"), format!("height: {height}")];
    if let Some(t) = &title {
        args.push(format!("title: [{}]", esc(t)));
    }
    if let Some(l) = get("xlabel").and_then(as_str) {
        args.push(format!("xlabel: [{}]", esc(&l)));
    }
    if let Some(l) = get("ylabel").and_then(as_str) {
        args.push(format!("ylabel: [{}]", esc(&l)));
    }
    let n = series.iter().map(|s| s.values.len()).max().unwrap_or(0);
    let tick_labels = |axis: &str| -> Option<String> {
        if labels.is_empty() {
            return None;
        }
        let l: Vec<String> = labels.iter().take(n).map(|l| format!("[{}]", esc(l))).collect();
        Some(format!("{axis}: (ticks: ({},).enumerate(), subticks: none)", l.join(", ")))
    };
    let label_of = |s: &Series| s.name.as_ref().map(|n| format!(", label: [{}]", esc(n))).unwrap_or_default();
    let has_legend = series.iter().any(|s| s.name.is_some());
    if !has_legend {
        args.push("legend: none".into());
    }

    let mut plots = Vec::new();
    match kind.as_str() {
        "bar" | "column" | "hbar" => {
            let horizontal = kind == "hbar";
            if let Some(t) = tick_labels(if horizontal { "yaxis" } else { "xaxis" }) {
                args.push(t);
            }
            let k = series.len() as f64;
            let w = 0.8 / k;
            for (i, s) in series.iter().enumerate() {
                let offset = -0.4 + w * (i as f64 + 0.5);
                let pos = format!("range({})", s.values.len());
                let common = format!(
                    "offset: {offset:.3}, width: {w:.3}, fill: rgb(\"{}\"){}",
                    s.color,
                    label_of(s)
                );
                plots.push(if horizontal {
                    format!("lq.hbar({}, {pos}, {common})", arr(&s.values))
                } else {
                    format!("lq.bar({pos}, {}, {common})", arr(&s.values))
                });
            }
        }
        "line" | "area" | "scatter" => {
            let smooth = get("smooth").and_then(Value::as_bool).unwrap_or(false);
            let x_expr = |len: usize| match &xs {
                Some(x) => arr(x),
                None => format!("range({len})"),
            };
            if xs.is_none() {
                if let Some(t) = tick_labels("xaxis") {
                    args.push(t);
                }
            }
            for s in &series {
                let x = x_expr(s.values.len());
                let y = arr(&s.values);
                let c = format!("rgb(\"{}\")", s.color);
                match kind.as_str() {
                    "scatter" => plots.push(format!("lq.scatter({x}, {y}, color: {c}, mark: \"o\", size: 6pt{})", label_of(s))),
                    "area" => {
                        plots.push(format!("lq.fill-between({x}, {y}, fill: {c}.transparentize(70%))"));
                        plots.push(format!("lq.plot({x}, {y}, color: {c}, mark: none, smooth: {smooth}{})", label_of(s)));
                    }
                    _ => plots.push(format!("lq.plot({x}, {y}, color: {c}, smooth: {smooth}{})", label_of(s))),
                }
            }
        }
        other => return Err(format!("unknown chart type `{other}` (bar, hbar, line, area, scatter, pie, donut)")),
    }
    args.extend(plots);
    let body = format!("lq.diagram({})", args.join(",\n  "));
    Ok((figure(&body, caption.as_deref()), vec!["lilaq"]))
}

#[allow(clippy::too_many_arguments)]
fn pie(
    labels: &[String],
    values: &[f64],
    _series: &[Series],
    donut: bool,
    title: Option<&str>,
    caption: Option<&str>,
    color_at: &dyn Fn(usize) -> String,
) -> BlockResult {
    let total: f64 = values.iter().filter(|v| **v > 0.0).sum();
    if total <= 0.0 {
        return Err("pie values must be positive".into());
    }
    let mut draw = String::from("import cetz.draw: *\n");
    let mut angle = 90.0f64;
    let r = 2.2;
    for (i, v) in values.iter().enumerate().filter(|(_, v)| **v > 0.0) {
        let delta = v / total * 360.0;
        let c = color_at(i);
        draw.push_str(&format!(
            "arc((0, 0), start: {angle:.3}deg, delta: {:.3}deg, radius: {r}, mode: \"PIE\", anchor: \"origin\", fill: rgb(\"{c}\"), stroke: white + 1.2pt)\n",
            -delta
        ));
        let mid = (angle - delta / 2.0).to_radians();
        let pct = v / total * 100.0;
        if pct >= 4.0 {
            let lr = if donut { r * 0.78 } else { r * 0.62 };
            draw.push_str(&format!(
                "content(({:.3}, {:.3}), text(fill: white, weight: \"bold\", size: 0.8em)[{:.0}%])\n",
                lr * mid.cos(),
                lr * mid.sin(),
                pct
            ));
        }
        angle -= delta;
    }
    if donut {
        draw.push_str(&format!("circle((0, 0), radius: {:.2}, fill: white, stroke: none)\n", r * 0.52));
    }
    let legend: Vec<String> = values
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let name = labels.get(i).cloned().unwrap_or_else(|| format!("#{}", i + 1));
            format!(
                "box(width: 0.8em, height: 0.8em, radius: 2pt, fill: rgb(\"{}\")), [{} #text(fill: luma(110))[({})]]",
                color_at(i),
                esc(&name),
                esc(&format_num(*v))
            )
        })
        .collect();
    let mut body = format!(
        "grid(columns: 2, column-gutter: 1.6em, align: horizon, cetz.canvas({{\n{draw}}}), grid(columns: 2, gutter: 0.55em, align: horizon, {}))",
        legend.join(", ")
    );
    if let Some(t) = title {
        body = format!("stack(spacing: 0.8em, align(center, text(weight: \"bold\")[{}]), {body})", esc(t));
    }
    Ok((figure(&body, caption), vec!["cetz"]))
}

fn format_num(v: f64) -> String {
    if v.fract() == 0.0 { format!("{v:.0}") } else { format!("{v}") }
}

// ------------------------------------------------------------------- flow

#[derive(Clone)]
struct FlowNode {
    label: String,
    shape: &'static str,
}

/// Parse `A`, `A[Text]`, `A(Text)`, `A((Text))`, `A{Text}`, `A([Text])`.
fn parse_node(s: &str) -> Option<(String, Option<FlowNode>)> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let id_end = s.find(['[', '(', '{']).unwrap_or(s.len());
    let id = s[..id_end].trim().to_string();
    if id.is_empty() {
        return None;
    }
    let rest = s[id_end..].trim();
    if rest.is_empty() {
        return Some((id, None));
    }
    let (shape, inner) = if let Some(x) = rest.strip_prefix("((").and_then(|r| r.strip_suffix("))")) {
        ("circle", x)
    } else if let Some(x) = rest.strip_prefix("([").and_then(|r| r.strip_suffix("])")) {
        ("pill", x)
    } else if let Some(x) = rest.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
        ("rect", x)
    } else if let Some(x) = rest.strip_prefix('(').and_then(|r| r.strip_suffix(')')) {
        ("round", x)
    } else if let Some(x) = rest.strip_prefix('{').and_then(|r| r.strip_suffix('}')) {
        ("diamond", x)
    } else {
        ("rect", rest)
    };
    Some((id, Some(FlowNode { label: inner.trim().trim_matches('"').to_string(), shape })))
}

const ARROWS: &[(&str, &str)] = &[
    ("<-->", "<--|>"),
    ("<->", "<|-|>"),
    ("-->", "--|>"),
    ("==>", "=|>"),
    ("->", "-|>"),
    ("---", "--"),
    ("--", "-"),
];

fn flow(code: &str) -> BlockResult {
    let mut order: Vec<String> = Vec::new();
    let mut nodes: HashMap<String, FlowNode> = HashMap::new();
    let mut edges: Vec<(String, String, &'static str, Option<String>)> = Vec::new();
    let mut vertical = true;
    let mut caption = None;

    let mut declare = |id: String, n: Option<FlowNode>, order: &mut Vec<String>| {
        if !nodes.contains_key(&id) {
            order.push(id.clone());
            nodes.insert(id.clone(), FlowNode { label: id.clone(), shape: "rect" });
        }
        if let Some(n) = n {
            nodes.insert(id, n);
        }
    };

    for raw in code.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with("//") || line.starts_with('#') {
            continue;
        }
        if let Some(d) = line.strip_prefix("direction:") {
            vertical = !matches!(d.trim(), "right" | "horizontal" | "LR" | "lr");
            continue;
        }
        if let Some(c) = line.strip_prefix("caption:") {
            caption = Some(c.trim().to_string());
            continue;
        }
        // Edge label after " : " (only outside brackets).
        let (chain, label) = match line.rfind(" : ") {
            Some(i) if !line[i..].contains(']') && !line[i..].contains(')') && !line[i..].contains('}') => {
                (&line[..i], Some(line[i + 3..].trim().to_string()))
            }
            _ => (line, None),
        };
        // Split a chain A -> B --> C into parts and arrows.
        let mut parts: Vec<(String, Option<&'static str>)> = Vec::new();
        let mut rest = chain;
        'outer: loop {
            let mut best: Option<(usize, &str, &'static str)> = None;
            for (pat, mark) in ARROWS {
                // Only match arrows outside brackets.
                let mut depth = 0i32;
                for (i, ch) in rest.char_indices() {
                    match ch {
                        '[' | '(' | '{' => depth += 1,
                        ']' | ')' | '}' => depth -= 1,
                        _ => {}
                    }
                    if depth == 0 && rest[i..].starts_with(pat) {
                        if best.is_none_or(|(bi, bp, _)| i < bi || (i == bi && pat.len() > bp.len())) {
                            best = Some((i, pat, mark));
                        }
                        break;
                    }
                }
            }
            match best {
                Some((i, pat, mark)) => {
                    parts.push((rest[..i].to_string(), Some(mark)));
                    rest = &rest[i + pat.len()..];
                }
                None => {
                    parts.push((rest.to_string(), None));
                    break 'outer;
                }
            }
        }
        let mut prev: Option<(String, &'static str)> = None;
        for (text, arrow) in parts {
            let Some((id, node)) = parse_node(&text) else {
                return Err(format!("cannot read node in `{line}`"));
            };
            declare(id.clone(), node, &mut order);
            if let Some((from, mark)) = prev.take() {
                edges.push((from, id.clone(), mark, if arrow.is_none() { label.clone() } else { None }));
            }
            if let Some(a) = arrow {
                prev = Some((id, a));
            }
        }
    }
    if order.is_empty() {
        return Err("empty flowchart — try `A[Start] -> B{OK?}`".into());
    }

    // Layered layout: rank = longest path from a source (cycles tolerated).
    let idx: HashMap<&str, usize> = order.iter().enumerate().map(|(i, n)| (n.as_str(), i)).collect();
    // Edges pointing back to an earlier-declared node are loops: they don't
    // influence ranking (and are drawn bent).
    let is_back = |a: &str, b: &str| idx[b] <= idx[a];
    let mut rank = vec![0usize; order.len()];
    for _ in 0..order.len() {
        let mut changed = false;
        for (a, b, _, _) in &edges {
            let (ia, ib) = (idx[a.as_str()], idx[b.as_str()]);
            if !is_back(a, b) && rank[ib] < rank[ia] + 1 {
                rank[ib] = rank[ia] + 1;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let mut per_rank: HashMap<usize, Vec<usize>> = HashMap::new();
    for (i, r) in rank.iter().enumerate() {
        per_rank.entry(*r).or_default().push(i);
    }
    let mut pos = vec![(0.0f64, 0.0f64); order.len()];
    for (r, members) in &per_rank {
        let k = members.len() as f64;
        for (j, &i) in members.iter().enumerate() {
            let across = j as f64 - (k - 1.0) / 2.0;
            pos[i] = if vertical { (across * 1.4, *r as f64) } else { (*r as f64, across) };
        }
    }

    let mut items = Vec::new();
    for (i, id) in order.iter().enumerate() {
        let n = &nodes[id];
        let (x, y) = pos[i];
        let shape = match n.shape {
            "diamond" => ", shape: fletcher.shapes.diamond, fill: rgb(\"#fff4e0\"), stroke: rgb(\"#d08a1e\")",
            "circle" => ", shape: circle, fill: rgb(\"#e8f6ef\"), stroke: rgb(\"#2f9d6a\")",
            "pill" => ", shape: fletcher.shapes.pill, fill: rgb(\"#efe9fd\"), stroke: rgb(\"#6b4fd8\")",
            "round" => ", corner-radius: 8pt, fill: rgb(\"#e9f1fd\"), stroke: rgb(\"#3b6fd6\")",
            _ => ", corner-radius: 2pt, fill: rgb(\"#f3f5f9\"), stroke: rgb(\"#5d6b85\")",
        };
        items.push(format!("node(({x:.2}, {y:.2}), [{}]{shape})", esc(&n.label)));
    }
    let max_across = pos.iter().map(|p| if vertical { p.0 } else { p.1 }).fold(0.0f64, f64::max);
    let mut detour = 0.0;
    for (a, b, mark, label) in &edges {
        let (pa, pb) = (pos[idx[a.as_str()]], pos[idx[b.as_str()]]);
        let lbl = |pos: &str| {
            label
                .as_ref()
                .map(|l| format!(", [{}], label-pos: {pos}, label-side: center, label-fill: white", esc(l)))
                .unwrap_or_default()
        };
        let pt = |p: (f64, f64)| format!("({:.2}, {:.2})", p.0, p.1);
        if a == b {
            items.push(format!("edge({}, {}, {}{}, bend: 130deg)", pt(pa), pt(pb), q(mark), lbl("0.5")));
        } else if is_back(a, b) {
            // Route loops around the outside of the chart with right angles.
            detour += 0.55;
            let (c1, c2) = if vertical {
                let x = max_across + 0.4 + detour;
                ((x, pa.1), (x, pb.1))
            } else {
                let y = max_across + 0.4 + detour;
                ((pa.0, y), (pb.0, y))
            };
            items.push(format!(
                "edge({}, {}, {}, {}, {}{}, corner-radius: 6pt)",
                pt(pa),
                pt(c1),
                pt(c2),
                pt(pb),
                q(mark),
                lbl("0.5")
            ));
        } else {
            items.push(format!("edge({}, {}, {}{})", pt(pa), pt(pb), q(mark), lbl("0.5")));
        }
    }
    let body = format!(
        "diagram(node-stroke: 0.8pt, node-inset: 8pt, spacing: ({}), edge-stroke: 0.8pt + rgb(\"#4a5468\"), {})",
        if vertical { "2.2em, 2.4em" } else { "3em, 1.8em" },
        items.join(",\n  ")
    );
    Ok((figure(&body, caption.as_deref()), vec!["fletcher"]))
}

// ---------------------------------------------------------------- mindmap

fn mindmap(code: &str) -> BlockResult {
    // (depth, text) from indentation; bullets optional.
    let mut rows: Vec<(usize, String)> = Vec::new();
    for line in code.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let text = line.trim().trim_start_matches(['-', '*', '+']).trim().to_string();
        rows.push((indent, text));
    }
    if rows.is_empty() {
        return Err("empty mindmap — one item per line, indent children".into());
    }
    // Normalise indentation levels.
    let mut levels: Vec<usize> = rows.iter().map(|r| r.0).collect();
    levels.sort_unstable();
    levels.dedup();
    let depth_of = |indent: usize| levels.iter().position(|&l| l == indent).unwrap_or(0);

    // Build parent links.
    let mut parent: Vec<Option<usize>> = vec![None; rows.len()];
    let mut stack: Vec<(usize, usize)> = Vec::new(); // (depth, index)
    for (i, (ind, _)) in rows.iter().enumerate() {
        let d = depth_of(*ind);
        while stack.last().is_some_and(|&(sd, _)| sd >= d) {
            stack.pop();
        }
        parent[i] = stack.last().map(|&(_, p)| p);
        stack.push((d, i));
    }
    let roots: Vec<usize> = (0..rows.len()).filter(|&i| parent[i].is_none()).collect();

    // Tidy tree: leaves get consecutive y; parents centered over children.
    let mut y = vec![0.0f64; rows.len()];
    let mut depth = vec![0usize; rows.len()];
    fn place(
        n: usize,
        d: usize,
        next: &mut f64,
        y: &mut [f64],
        depth: &mut [usize],
        kids: &dyn Fn(usize) -> Vec<usize>,
    ) {
        depth[n] = d;
        let ks = kids(n);
        if ks.is_empty() {
            y[n] = *next;
            *next += 1.0;
        } else {
            for &k in &ks {
                place(k, d + 1, next, y, depth, kids);
            }
            y[n] = (y[ks[0]] + y[*ks.last().unwrap()]) / 2.0;
        }
    }
    let kids = |p: usize| (0..rows.len()).filter(|&i| parent[i] == Some(p)).collect::<Vec<_>>();
    let mut next = 0.0;
    for &r in &roots {
        place(r, 0, &mut next, &mut y, &mut depth, &kids);
    }

    let mut items = Vec::new();
    for (i, (_, text)) in rows.iter().enumerate() {
        let d = depth[i];
        let color = PALETTE[(if d == 0 { 0 } else { top_branch(i, &parent) }) % PALETTE.len()];
        let style = match d {
            0 => format!(", fill: rgb(\"{color}\"), stroke: none, corner-radius: 10pt, inset: 10pt"),
            1 => format!(", fill: rgb(\"{color}\").lighten(80%), stroke: rgb(\"{color}\"), corner-radius: 8pt"),
            _ => ", stroke: none, fill: none".to_string(),
        };
        let label = if d == 0 {
            format!("text(fill: white, weight: \"bold\")[{}]", esc(text))
        } else {
            format!("[{}]", esc(text))
        };
        items.push(format!("node(({}, {:.2}), {label}{style})", d as f64 * 1.0, y[i] * 0.55));
        if let Some(p) = parent[i] {
            let pc = PALETTE[top_branch(i, &parent) % PALETTE.len()];
            items.push(format!(
                "edge(({}, {:.2}), ({}, {:.2}), stroke: 1.2pt + rgb(\"{pc}\"), bend: 0deg)",
                depth[p],
                y[p] * 0.55,
                d,
                y[i] * 0.55
            ));
        }
    }
    let body = format!("diagram(spacing: (2.8em, 1em), node-inset: 6pt, {})", items.join(",\n  "));
    Ok((figure(&body, None), vec!["fletcher"]))
}

/// Index of the depth-1 ancestor (for branch colors).
fn top_branch(mut i: usize, parent: &[Option<usize>]) -> usize {
    while let Some(p) = parent[i] {
        if parent[p].is_none() {
            return i;
        }
        i = p;
    }
    i
}

// --------------------------------------------------------------- timeline

fn timeline(code: &str) -> BlockResult {
    let events: Vec<(String, String)> = code
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| match l.split_once(':') {
            Some((d, t)) => (d.trim().to_string(), t.trim().to_string()),
            None => (String::new(), l.trim().to_string()),
        })
        .collect();
    if events.is_empty() {
        return Err("empty timeline — one `date: event` per line".into());
    }
    let n = events.len();
    let step = 2.6;
    let mut d = String::from("import cetz.draw: *\n");
    d.push_str(&format!(
        "line((-0.6, 0), ({:.2}, 0), stroke: 1.4pt + luma(170), mark: (end: \">\", fill: luma(170)))\n",
        (n - 1) as f64 * step + 0.8
    ));
    for (i, (date, text)) in events.iter().enumerate() {
        let x = i as f64 * step;
        let c = PALETTE[i % PALETTE.len()];
        let up = i % 2 == 0;
        let (yd, yt, anchor_d, anchor_t) =
            if up { (-0.45, 0.45, "north", "south") } else { (0.45, -0.45, "south", "north") };
        d.push_str(&format!("circle(({x:.2}, 0), radius: 0.16, fill: rgb(\"{c}\"), stroke: white + 1.5pt)\n"));
        d.push_str(&format!(
            "content(({x:.2}, {yd}), anchor: \"{anchor_d}\", text(weight: \"bold\", fill: rgb(\"{c}\"), size: 0.85em)[{}])\n",
            esc(date)
        ));
        d.push_str(&format!(
            "content(({x:.2}, {yt}), anchor: \"{anchor_t}\", box(width: {:.1}cm, align(center, text(size: 0.85em)[{}])))\n",
            step * 0.95,
            esc(text)
        ));
    }
    let body = format!("cetz.canvas({{\n{d}}})");
    Ok((figure(&body, None), vec!["cetz"]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flow_parses_chain_and_shapes() {
        let (t, p) = flow("A[شروع] -> B{درسته؟} -> C((پایان)) : بله\nB --> A : نه").unwrap();
        assert_eq!(p, vec!["fletcher"]);
        assert!(t.contains("[شروع]"));
        assert!(t.contains("fletcher.shapes.diamond"));
        assert!(t.contains("shape: circle"));
        assert!(t.contains("\"--|>\""));
        assert!(t.contains("[بله]"));
    }

    #[test]
    fn chart_from_map() {
        let (t, _) = chart("type: bar\ntitle: فروش\ndata:\n  بهار: 10\n  تابستان: 14\n").unwrap();
        assert!(t.contains("lq.bar(range(2), (10, 14)"), "{t}");
        assert!(t.contains("[بهار]"));
    }

    #[test]
    fn chart_errors_are_readable() {
        assert!(chart("type: radar\nvalues: [1,2]").unwrap_err().contains("unknown chart type"));
        assert!(chart("title: x").unwrap_err().contains("no data"));
    }

    #[test]
    fn mindmap_tree() {
        let (t, _) = mindmap("Root\n  A\n    A1\n  B").unwrap();
        assert_eq!(t.matches("node(").count(), 4);
        assert_eq!(t.matches("edge(").count(), 3);
    }
}
