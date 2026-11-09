//! Blocks of a Markdown note: paragraphs, headings, list items, quotes,
//! tables, code and math, with their line ranges and Obsidian `^block-id`s.
//! Used by `((` block search, `[[Note#^id]]` / `[[Note#Heading]]` embeds and
//! previews, block-level backlinks and unlinked mentions.
use serde::Serialize;

use crate::links::Resolver;
use crate::vault::{normalize_text, Index};
use std::path::Path;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Block {
    /// paragraph, heading, item, task, quote, callout, table, code, math
    pub kind: &'static str,
    /// First and last line (0-based, inclusive).
    pub start: usize,
    pub end: usize,
    /// Heading level (1–6), or the list item's indentation.
    pub level: usize,
    pub id: Option<String>,
    /// Line that holds the `^id` (the block's own line or a line of its own after it).
    #[serde(skip)]
    pub id_line: Option<usize>,
    /// Last line of the item's own text (before nested items); list items only.
    #[serde(skip)]
    pub own_end: usize,
}

/// `^id` at the end of `line` (after a space): the id.
pub fn trailing_id(line: &str) -> Option<&str> {
    let t = line.trim_end();
    let i = t.rfind('^')?;
    let id = &t[i + 1..];
    let ok = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    let before = &t[..i];
    (ok && (before.is_empty() || before.ends_with(char::is_whitespace))).then_some(id)
}

fn indent(line: &str) -> usize {
    line.chars().take_while(|c| *c == ' ' || *c == '\t').map(|c| if c == '\t' { 4 } else { 1 }).sum()
}

fn list_marker(line: &str) -> Option<bool> {
    let t = line.trim_start();
    let rest = if let Some(r) = t.strip_prefix(['-', '*', '+']) {
        r
    } else {
        let d = t.chars().take_while(|c| c.is_ascii_digit()).count();
        if d == 0 || d > 9 {
            return None;
        }
        t[d..].strip_prefix(['.', ')'])?
    };
    if !(rest.is_empty() || rest.starts_with(' ') || rest.starts_with('\t')) {
        return None;
    }
    let r = rest.trim_start();
    Some(r.starts_with("[ ]") || r.starts_with("[x]") || r.starts_with("[X]") || r.starts_with("[/]") || r.starts_with("[-]"))
}

fn heading_level(line: &str) -> Option<usize> {
    let n = line.chars().take_while(|c| *c == '#').count();
    (1..=6).contains(&n).then_some(n).filter(|&n| line[n..].is_empty() || line[n..].starts_with([' ', '\t']))
}

fn fence_of(line: &str) -> Option<(char, usize)> {
    let t = line.trim_start();
    let c = t.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let n = t.chars().take_while(|x| *x == c).count();
    (n >= 3).then_some((c, n))
}

/// Line where the body starts (after the frontmatter).
pub fn body_start(lines: &[&str]) -> usize {
    if lines.first().map(|l| l.trim_end()) == Some("---") {
        if let Some(i) = lines.iter().skip(1).position(|l| matches!(l.trim_end(), "---" | "...")) {
            return i + 2;
        }
    }
    0
}

/// Every block of a Markdown note, in order. List items are blocks of their
/// own (nested items too, overlapping their parent).
pub fn parse(text: &str) -> Vec<Block> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<Block> = Vec::new();
    let mut i = body_start(&lines);
    let blank = |l: &str| l.trim().is_empty();
    let mk = |kind, start, end, level| Block { kind, start, end, level, id: None, id_line: None, own_end: end };
    while i < lines.len() {
        let line = lines[i];
        if blank(line) {
            i += 1;
            continue;
        }
        // `^id` alone on a line: names the block before it.
        if let Some(id) = trailing_id(line).filter(|_| line.trim().starts_with('^')) {
            // (After a list: its last top-level item.)
            if let Some(b) = out.iter_mut().rev().find(|b| b.end < i && b.level == 0) {
                if b.id.is_none() {
                    b.id = Some(id.to_string());
                    b.id_line = Some(i);
                }
            }
            i += 1;
            continue;
        }
        if let Some((fc, n)) = fence_of(line) {
            let mut j = i + 1;
            while j < lines.len() && !fence_of(lines[j]).is_some_and(|(c, m)| c == fc && m >= n && lines[j].trim_start()[m..].trim().is_empty()) {
                j += 1;
            }
            out.push(mk("code", i, j.min(lines.len() - 1), 0));
            i = j + 1;
            continue;
        }
        if line.trim_start().starts_with("$$") {
            let one = line.trim().len() > 2 && line.trim().ends_with("$$");
            let mut j = i;
            if !one {
                j += 1;
                while j < lines.len() && !lines[j].trim_end().ends_with("$$") {
                    j += 1;
                }
            }
            out.push(mk("math", i, j.min(lines.len() - 1), 0));
            i = j + 1;
            continue;
        }
        if let Some(level) = heading_level(line) {
            let mut b = mk("heading", i, i, level);
            if let Some(id) = trailing_id(line) {
                b.id = Some(id.into());
                b.id_line = Some(i);
            }
            out.push(b);
            i += 1;
            continue;
        }
        if line.trim_start().starts_with('>') {
            let mut j = i;
            while j + 1 < lines.len() && lines[j + 1].trim_start().starts_with('>') {
                j += 1;
            }
            let kind = if line.trim_start().trim_start_matches('>').trim_start().starts_with("[!") { "callout" } else { "quote" };
            out.push(mk(kind, i, j, 0));
            i = j + 1;
            continue;
        }
        if line.trim_start().starts_with('|') {
            let mut j = i;
            while j + 1 < lines.len() && lines[j + 1].trim_start().starts_with('|') {
                j += 1;
            }
            out.push(mk("table", i, j, 0));
            i = j + 1;
            continue;
        }
        if list_marker(line).is_some() {
            // A run of list lines; each item becomes a block.
            let mut j = i;
            loop {
                let next = j + 1;
                if next >= lines.len() {
                    break;
                }
                if blank(lines[next]) {
                    // A blank line continues the list only before an indented line or another item.
                    let k = (next..lines.len()).find(|&k| !blank(lines[k]));
                    match k {
                        Some(k) if indent(lines[k]) > 0 || list_marker(lines[k]).is_some() => j = next,
                        _ => break,
                    }
                    continue;
                }
                let l = lines[next];
                if heading_level(l).is_some() || fence_of(l).is_some() && indent(l) == 0 || l.trim_start().starts_with('>') && indent(l) == 0 {
                    break;
                }
                j = next;
            }
            let items: Vec<usize> = (i..=j).filter(|&k| list_marker(lines[k]).is_some()).collect();
            for &s in &items {
                let ind = indent(lines[s]);
                let mut e = s;
                let mut own_end = s;
                let mut own = true;
                for k in s + 1..=j {
                    if blank(lines[k]) {
                        continue;
                    }
                    if indent(lines[k]) <= ind {
                        break;
                    }
                    if list_marker(lines[k]).is_some() {
                        own = false;
                    }
                    e = k;
                    if own {
                        own_end = k;
                    }
                }
                let task = list_marker(lines[s]) == Some(true);
                let mut b = mk(if task { "task" } else { "item" }, s, e, ind);
                b.own_end = own_end;
                if let Some((k, id)) = (s..=own_end).rev().find_map(|k| trailing_id(lines[k]).map(|id| (k, id))) {
                    b.id = Some(id.into());
                    b.id_line = Some(k);
                }
                out.push(b);
            }
            i = j + 1;
            continue;
        }
        // Paragraph: until a blank line or the start of another block.
        let mut j = i;
        while j + 1 < lines.len() {
            let l = lines[j + 1];
            if blank(l) || heading_level(l).is_some() || fence_of(l).is_some() || l.trim_start().starts_with('>') || list_marker(l).is_some() && indent(l) == 0 {
                break;
            }
            if trailing_id(l).is_some() && l.trim().starts_with('^') {
                break;
            }
            j += 1;
        }
        let mut b = mk("paragraph", i, j, 0);
        if let Some(id) = trailing_id(lines[j]) {
            b.id = Some(id.into());
            b.id_line = Some(j);
        }
        out.push(b);
        i = j + 1;
    }
    out
}

fn norm_heading(s: &str) -> String {
    let s: String = s.chars().filter(|c| !matches!(c, '#' | '*' | '_' | '`' | '=' | '~' | '[' | ']')).collect();
    s.split(|c: char| c.is_whitespace() || c == '-' || c == '\u{200c}').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ").to_lowercase()
}

fn heading_text(line: &str) -> &str {
    let t = line.trim_start_matches('#').trim();
    let t = trailing_id(t).map(|id| t[..t.len() - id.len() - 1].trim_end()).unwrap_or(t);
    let t = t.trim_end_matches('#').trim_end();
    // `{#custom-id}` attributes
    match t.rfind(" {") {
        Some(i) if t.ends_with('}') => &t[..i],
        _ => t,
    }
}

/// The lines (0-based, inclusive) that `sub` names in `text`: `^id` for a
/// block, or a heading (`Heading`, or `A#B` for B under A) for its section.
pub fn find(text: &str, sub: &str) -> Option<(usize, usize)> {
    let sub = sub.trim().trim_start_matches('#');
    let blocks = parse(text);
    if let Some(id) = sub.strip_prefix('^') {
        let b = blocks.iter().find(|b| b.id.as_deref() == Some(id))?;
        // The id's own line is part of the block for `^id` after a table.
        return Some((b.start, b.end.max(b.id_line.unwrap_or(0))));
    }
    let lines: Vec<&str> = text.lines().collect();
    let parts: Vec<String> = sub.split('#').map(norm_heading).filter(|p| !p.is_empty()).collect();
    let heads: Vec<&Block> = blocks.iter().filter(|b| b.kind == "heading").collect();
    let mut from = 0;
    let mut found: Option<&Block> = None;
    for p in &parts {
        let h = heads.iter().filter(|h| h.start >= from).find(|h| norm_heading(heading_text(lines[h.start])) == *p)?;
        from = h.start + 1;
        found = Some(h);
    }
    let h = found?;
    let end = heads.iter().find(|x| x.start > h.start && x.level <= h.level).map(|x| x.start - 1).unwrap_or(lines.len().saturating_sub(1));
    // Trailing blank lines are not part of the section.
    let mut end = end;
    while end > h.start && lines[end].trim().is_empty() {
        end -= 1;
    }
    Some((h.start, end))
}

/// Text of `[start, end]` lines (0-based, inclusive).
pub fn slice(text: &str, start: usize, end: usize) -> String {
    text.lines().skip(start).take(end + 1 - start).collect::<Vec<_>>().join("\n")
}

/// Short plain text of a block, for lists and completion.
fn summary(lines: &[&str], b: &Block) -> String {
    let mut s = String::new();
    let last = if matches!(b.kind, "item" | "task") { b.own_end } else { b.end };
    for k in b.start..=last {
        let mut l = lines[k].trim();
        if b.kind == "code" && (k == b.start || k == b.end) {
            continue;
        }
        if k == b.start {
            l = l.trim_start_matches('#').trim_start_matches('>').trim_start();
            if list_marker(l).is_some() {
                l = l.trim_start_matches(['-', '*', '+']).trim_start_matches(|c: char| c.is_ascii_digit()).trim_start_matches(['.', ')']).trim_start();
                for t in ["[ ]", "[x]", "[X]", "[/]", "[-]"] {
                    l = l.strip_prefix(t).unwrap_or(l);
                }
            }
        }
        let l = l.trim_start_matches('>').trim();
        let l = trailing_id(l).map(|id| &l[..l.len() - id.len() - 1]).unwrap_or(l).trim_end();
        if l.is_empty() {
            continue;
        }
        if !s.is_empty() {
            s.push(' ');
        }
        s.push_str(l);
        if s.len() > 400 {
            break;
        }
    }
    let s: String = s.chars().take(240).collect();
    s
}

#[derive(Serialize)]
pub struct BlockHit {
    pub path: String,
    /// 1-based first line.
    pub line: usize,
    pub kind: &'static str,
    pub id: Option<String>,
    pub text: String,
}

/// Blocks whose text contains every word of `q` (for `((` completion), best
/// first: the whole phrase, word starts, blocks of note `from`, blocks that
/// already have an id, shorter blocks.
pub fn search(idx: &Index, q: &str, from: &str, exclude: &[String], limit: usize) -> Vec<BlockHit> {
    let phrase = normalize_text(q).split_whitespace().collect::<Vec<_>>().join(" ");
    let words: Vec<&str> = phrase.split(' ').filter(|w| !w.is_empty()).collect();
    let starts_word = |norm: &str, w: &str| {
        norm.match_indices(w).any(|(i, _)| i == 0 || !norm[..i].chars().next_back().is_some_and(char::is_alphanumeric))
    };
    let mut out: Vec<(i64, BlockHit)> = Vec::new();
    for (path, doc) in idx.iter(exclude) {
        if !path.ends_with(".md") {
            continue;
        }
        let lines: Vec<&str> = doc.text.lines().collect();
        for b in parse(&doc.text) {
            if b.kind == "code" && words.is_empty() {
                continue;
            }
            let text = summary(&lines, &b);
            if text.is_empty() {
                continue;
            }
            let norm = normalize_text(&text);
            if !words.iter().all(|w| norm.contains(w)) {
                continue;
            }
            let mut score = (text.chars().count() as i64 / 8).min(120);
            if !phrase.is_empty() && !norm.contains(&phrase) {
                score += 300;
            }
            score -= 25 * words.iter().filter(|w| starts_word(&norm, w)).count() as i64;
            if path == from {
                score -= 150;
            }
            if b.id.is_some() {
                score -= 40;
            }
            out.push((score, BlockHit { path: path.clone(), line: b.start + 1, kind: b.kind, id: b.id.clone(), text }));
        }
    }
    out.sort_by_key(|(s, _)| *s);
    out.into_iter().take(limit).map(|(_, h)| h).collect()
}

/// A fresh id for a block of `text`: six letters and digits, unused in the note.
fn fresh_id(text: &str, seed: u64) -> String {
    const CH: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut x = seed ^ 0x9e37_79b9_7f4a_7c15;
    loop {
        let mut id = String::new();
        for _ in 0..6 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            id.push(CH[(x % CH.len() as u64) as usize] as char);
        }
        if !text.contains(&format!("^{id}")) && id.chars().any(|c| c.is_ascii_alphabetic()) {
            return id;
        }
    }
}

/// The id of the block at `line` (0-based), adding one when it has none:
/// returns the id and the note's new text when it changed.
pub fn ensure_id(text: &str, line: usize, seed: u64, want: Option<&str>) -> Option<(String, Option<String>)> {
    let blocks = parse(text);
    // The innermost block on that line (a nested item rather than its parent).
    let b = blocks
        .iter()
        .filter(|b| {
            let last = if matches!(b.kind, "item" | "task") { b.own_end } else { b.end };
            b.start <= line && line <= last.max(b.id_line.unwrap_or(0))
        })
        .min_by_key(|b| b.end - b.start)?;
    if let Some(id) = &b.id {
        return Some((id.clone(), None));
    }
    let valid = |w: &&str| !w.is_empty() && w.len() <= 64 && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    let id = match want.filter(valid) {
        Some(w) if !text.contains(&format!("^{w}")) => w.to_string(),
        _ => fresh_id(text, seed),
    };
    let mut lines: Vec<String> = text.lines().map(String::from).collect();
    match b.kind {
        "paragraph" | "heading" | "item" | "task" => {
            let at = if matches!(b.kind, "item" | "task") { b.own_end } else { b.end };
            let l = lines[at].trim_end().to_string();
            lines[at] = format!("{l} ^{id}");
        }
        _ => {
            // Tables, quotes, code: the id goes on a line of its own after the block.
            let mut add = vec![String::new(), format!("^{id}")];
            if lines.get(b.end + 1).is_some_and(|l| !l.trim().is_empty()) {
                add.push(String::new());
            }
            lines.splice(b.end + 1..b.end + 1, add);
        }
    }
    let mut out = lines.join("\n");
    if text.ends_with('\n') {
        out.push('\n');
    }
    Some((id, Some(out)))
}

// ------------------------------------------------------------ backlinks

#[derive(Serialize, Debug)]
pub struct Backlink {
    pub path: String,
    /// 1-based line of the link.
    pub line: usize,
    /// The block that holds the link (plain text, shortened).
    pub snippet: String,
    /// `^id` or heading the link points at inside the target, if any.
    pub sub: Option<String>,
    pub embed: bool,
}

/// Every link to `target` in the vault, with the block it sits in.
pub fn backlinks(idx: &Index, root: &Path, target: &str, exclude: &[String]) -> Vec<Backlink> {
    let r = Resolver::new(idx, root);
    let mut out = Vec::new();
    for (from, doc) in idx.iter(exclude) {
        if from == target {
            continue;
        }
        let text = &doc.text;
        let links = crate::links::scan_full(text);
        if links.is_empty() {
            continue;
        }
        let lines: Vec<&str> = text.lines().collect();
        let mut blocks: Option<Vec<Block>> = None;
        let mut starts = vec![0];
        starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
        for l in links {
            let raw = &text[l.target.clone()];
            if !l.wiki && !crate::links::has_ext(raw.trim()) {
                continue;
            }
            let Some((to, _)) = r.resolve(from, raw) else { continue };
            if to != target {
                continue;
            }
            let line = starts.partition_point(|&s| s <= l.target.start) - 1;
            let blocks = blocks.get_or_insert_with(|| parse(text));
            let snippet = blocks
                .iter()
                .filter(|b| b.start <= line && line <= b.end && b.kind != "heading")
                .min_by_key(|b| b.end - b.start)
                .map(|b| summary(&lines, b))
                .unwrap_or_else(|| lines[line].trim().chars().take(240).collect());
            out.push(Backlink { path: from.clone(), line: line + 1, snippet, sub: l.sub.clone(), embed: l.embed });
        }
    }
    out
}

#[derive(Serialize, Debug)]
pub struct Mention {
    pub path: String,
    /// 1-based line.
    pub line: usize,
    /// The line, shortened around the match.
    pub snippet: String,
    /// The matched text and its position in the line (UTF-16 units).
    pub text: String,
    pub at: usize,
    pub len: usize,
}

/// Byte ranges of `line` that are links, code or URLs (mentions there don't count).
fn masked(line: &str) -> Vec<(usize, usize)> {
    let mut m = Vec::new();
    for re in [r"!?\[\[[^\]]*\]\]", r"!?\[[^\]]*\]\([^)]*\)", r"`[^`]*`", r"https?://\S+", r"\$[^$]+\$", r"#[^\s#]+"] {
        let re = regex::Regex::new(re).unwrap();
        m.extend(re.find_iter(line).map(|x| (x.start(), x.end())));
    }
    m
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Text in other notes that names `target` (its file name or an alias)
/// without linking to it.
pub fn unlinked(idx: &Index, target: &str, exclude: &[String], limit: usize) -> Vec<Mention> {
    let stem = crate::links::stem_of(target);
    let stem = stem.rsplit('/').next().unwrap_or(&stem).to_string();
    let mut names = vec![stem.clone()];
    if let Some(doc) = idx.iter(&[]).find(|(p, _)| *p == target).map(|(_, d)| d) {
        names.extend(doc.meta.aliases.iter().cloned());
    }
    // Longest first, so "Machine learning" wins over "Machine".
    names.retain(|n| n.chars().count() >= 3);
    names.sort_by_key(|n| std::cmp::Reverse(n.len()));
    names.dedup();
    if names.is_empty() {
        return vec![];
    }
    let pat = names.iter().map(|n| regex::escape(n)).collect::<Vec<_>>().join("|");
    let Ok(re) = regex::RegexBuilder::new(&format!("(?i)(?:{pat})")).build() else { return vec![] };
    let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    let mut out = Vec::new();
    for (path, doc) in idx.iter(exclude) {
        if path == target || !path.ends_with(".md") {
            continue;
        }
        let lines: Vec<&str> = doc.text.lines().collect();
        let mut fence: Option<(char, usize)> = None;
        for (i, line) in lines.iter().enumerate().skip(body_start(&lines)) {
            if let Some((c, n)) = fence_of(line) {
                match fence {
                    None => fence = Some((c, n)),
                    Some((fc, fnn)) if fc == c && n >= fnn => fence = None,
                    _ => {}
                }
                continue;
            }
            if fence.is_some() || heading_level(line).is_some() {
                continue;
            }
            let mut mask: Option<Vec<(usize, usize)>> = None;
            for m in re.find_iter(line) {
                if word(line[..m.start()].chars().next_back()) || word(line[m.end()..].chars().next()) {
                    continue;
                }
                let mask = mask.get_or_insert_with(|| masked(line));
                if mask.iter().any(|&(a, b)| m.start() < b && a < m.end()) {
                    continue;
                }
                let from = line[..m.start()].char_indices().rev().nth(60).map(|(k, _)| k).unwrap_or(0);
                let to = line[m.end()..].char_indices().nth(80).map(|(k, _)| m.end() + k).unwrap_or(line.len());
                let snippet = format!("{}{}{}", if from > 0 { "…" } else { "" }, line[from..to].trim(), if to < line.len() { "…" } else { "" });
                out.push(Mention {
                    path: path.clone(),
                    line: i + 1,
                    snippet,
                    text: m.as_str().to_string(),
                    at: utf16_len(&line[..m.start()]),
                    len: utf16_len(m.as_str()),
                });
                if out.len() >= limit {
                    return out;
                }
            }
        }
    }
    out
}

/// Turn mentions into links to `target` (`link` is the link text to use, e.g.
/// the note name). Each item is (path, 1-based line, UTF-16 column, UTF-16
/// length, the text expected there). Returns the new texts of the notes that
/// change (nothing is written).
pub fn link_mentions(idx: &Index, link: &str, items: &[(String, usize, usize, usize, String)]) -> Vec<(String, String)> {
    let mut by_path: std::collections::BTreeMap<&str, Vec<&(String, usize, usize, usize, String)>> = Default::default();
    for it in items {
        by_path.entry(it.0.as_str()).or_default().push(it);
    }
    let mut changed = Vec::new();
    for (path, mut its) in by_path {
        let Some(text) = idx.text(path).map(String::from) else { continue };
        let mut lines: Vec<String> = text.lines().map(String::from).collect();
        // Right to left inside a line keeps earlier columns valid.
        its.sort_by(|a, b| (b.1, b.2).cmp(&(a.1, a.2)));
        let mut any = false;
        for (_, line, at, len, expect) in its {
            let Some(l) = lines.get_mut(line.wrapping_sub(1)) else { continue };
            let u: Vec<u16> = l.encode_utf16().collect();
            if at + len > u.len() {
                continue;
            }
            let found = String::from_utf16_lossy(&u[*at..at + len]);
            if found != *expect {
                continue;
            }
            let rep = if found == link { format!("[[{link}]]") } else { format!("[[{link}|{found}]]") };
            let mut nu: Vec<u16> = u[..*at].to_vec();
            nu.extend(rep.encode_utf16());
            nu.extend_from_slice(&u[at + len..]);
            *l = String::from_utf16_lossy(&nu);
            any = true;
        }
        if any {
            let mut out = lines.join("\n");
            if text.ends_with('\n') {
                out.push('\n');
            }
            changed.push((path.to_string(), out));
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE: &str = "---\ntitle: x\n---\n# Intro\n\nFirst para\nsecond line ^p1\n\n- item one ^i1\n  - nested\n- [ ] task\n\n| a | b |\n|---|---|\n\n^tbl\n\n## Sub\n\n> quote\n> more\n\n```js\nx ^no\n```\n# Next\ntext\n";

    #[test]
    fn parses_blocks_and_ids() {
        let b = parse(NOTE);
        let kinds: Vec<_> = b.iter().map(|b| (b.kind, b.start, b.end, b.id.clone())).collect();
        assert_eq!(kinds[0], ("heading", 3, 3, None));
        assert_eq!(kinds[1], ("paragraph", 5, 6, Some("p1".into())));
        assert_eq!(kinds[2], ("item", 8, 9, Some("i1".into())));
        assert_eq!(kinds[3], ("item", 9, 9, None));
        assert_eq!(kinds[4], ("task", 10, 10, None));
        assert_eq!(kinds[5], ("table", 12, 13, Some("tbl".into())));
        assert_eq!(kinds[6].0, "heading");
        assert_eq!(kinds[7], ("quote", 19, 20, None));
        assert_eq!(kinds[8], ("code", 22, 24, None));
    }

    #[test]
    fn finds_sections_and_blocks() {
        assert_eq!(find(NOTE, "^p1"), Some((5, 6)));
        assert_eq!(find(NOTE, "^tbl"), Some((12, 15)));
        assert_eq!(find(NOTE, "intro"), Some((3, 24)));
        assert_eq!(find(NOTE, "Intro#Sub"), Some((17, 24)));
        assert_eq!(find(NOTE, "Next"), Some((25, 26)));
        assert_eq!(find(NOTE, "^nope"), None);
        assert_eq!(find(NOTE, "^no"), None, "ids in code don't count");
    }

    #[test]
    fn adds_ids() {
        let (id, t) = ensure_id(NOTE, 6, 1, None).unwrap();
        assert_eq!((id.as_str(), t), ("p1", None));
        let (id, t) = ensure_id(NOTE, 9, 1, None).unwrap();
        let t = t.unwrap();
        assert!(t.contains(&format!("  - nested ^{id}\n")), "{t}");
        let (id, t) = ensure_id(NOTE, 19, 7, None).unwrap();
        assert!(t.unwrap().contains(&format!("> more\n\n^{id}\n\n```")));
        let (id, t) = ensure_id(NOTE, 26, 3, Some("mine")).unwrap();
        assert_eq!(id, "mine");
        assert!(t.unwrap().ends_with("text ^mine\n"));
    }

    #[test]
    fn backlinks_and_mentions() {
        let dir = std::env::temp_dir().join(format!("nz-blocks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Target.md"), "---\naliases: [Goal]\n---\nhi ^b1\n").unwrap();
        std::fs::write(
            dir.join("a.md"),
            "See [[Target#^b1]] here.\n\n![[Target]]\n\nThe target is near. And the goal too.\n`Target` and [[Target]] and targets.\n",
        )
        .unwrap();
        let mut idx = Index::build(&dir);
        let bl = backlinks(&idx, &dir, "Target.md", &[]);
        assert_eq!(bl.len(), 3, "{bl:?}");
        assert_eq!((bl[0].line, bl[0].sub.as_deref(), bl[0].embed), (1, Some("^b1"), false));
        assert!(bl[1].embed);
        let m = unlinked(&idx, "Target.md", &[], 50);
        assert_eq!(m.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), ["target", "goal"], "{m:?}");
        let items: Vec<_> = m.iter().map(|m| (m.path.clone(), m.line, m.at, m.len, m.text.clone())).collect();
        let writes = link_mentions(&idx, "Target", &items);
        assert_eq!(writes.len(), 1);
        let t = writes[0].1.clone();
        idx.put("a.md", &t);
        assert!(t.contains("The [[Target|target]] is near. And the [[Target|goal]] too."), "{t}");
        assert!(unlinked(&idx, "Target.md", &[], 50).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn searches_blocks() {
        let mut idx = Index::default();
        idx.put("n.md", NOTE);
        let hits = search(&idx, "second", "", &[], 10);
        assert_eq!(hits.len(), 1);
        assert_eq!((hits[0].line, hits[0].id.as_deref(), hits[0].text.as_str()), (6, Some("p1"), "First para second line"));
        let hits = search(&idx, "nested", "", &[], 10);
        assert_eq!(hits[0].text, "nested");
    }
}
