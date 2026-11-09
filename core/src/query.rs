//! Note metadata (tags, properties, icon, aliases), the search query
//! language and vault-wide find & replace.
//!
//! Query syntax (terms are ANDed; `-` negates one):
//!
//! | term | matches |
//! |---|---|
//! | `word`, `"a phrase"` | lines containing it (case, accents and letter variants ignored) |
//! | `/regex/`, `/regex/i` | lines matching the regular expression |
//! | `tag:x` | notes tagged `#x` or `#x/…` (body or frontmatter `tags`) |
//! | `path:x` | notes whose path contains `x` |
//! | `file:x` | notes whose file name contains `x` |
//! | `prop:key`, `prop:key=value` | notes whose frontmatter has `key` (equal to `value`) |
//! | `type:heading` … | lines of a kind: `heading`, `task`, `todo`, `done`, `code`, `quote`, `link` |

use crate::vault::{normalize_text, Index};
use regex::{Regex, RegexBuilder};
use serde::Serialize;
use serde_json::Value as Json;
use std::collections::BTreeMap;

// ------------------------------------------------------------------ meta

/// What the index knows about a note besides its text.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Meta {
    /// Tags without `#`, in first-seen spelling, de-duplicated (case-insensitive).
    pub tags: Vec<String>,
    /// Frontmatter as JSON (empty when there is none or it is invalid).
    #[serde(skip)]
    pub props: serde_json::Map<String, Json>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
}

/// Frontmatter value as a list of strings (`[a, b]`, `"a, b"`, `a`).
fn string_list(v: Option<&Json>) -> Vec<String> {
    match v {
        Some(Json::Array(a)) => a.iter().filter_map(scalar).collect(),
        Some(Json::String(s)) => s.split([',', ' ']).map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect(),
        Some(v) => scalar(v).into_iter().collect(),
        None => vec![],
    }
}

fn scalar(v: &Json) -> Option<String> {
    match v {
        Json::String(s) => Some(s.clone()),
        Json::Number(n) => Some(n.to_string()),
        Json::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

pub fn meta(text: &str) -> Meta {
    let (yaml, body, _) = crate::render::split_frontmatter(text);
    let props: serde_json::Map<String, Json> = yaml
        .and_then(|y| serde_yaml_ng::from_str::<serde_yaml_ng::Value>(y).ok())
        .and_then(|v| serde_json::to_value(v).ok())
        .and_then(|v| match v {
            Json::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default();
    let mut tags = vec![];
    let mut seen = std::collections::HashSet::new();
    let mut add = |t: &str| {
        let t = t.trim().trim_start_matches('#').trim_end_matches('/');
        if !t.is_empty() && seen.insert(t.to_lowercase()) {
            tags.push(t.to_string());
        }
    };
    for key in ["tags", "tag"] {
        for t in string_list(props.get(key)) {
            add(&t);
        }
    }
    for t in body_tags(body) {
        add(&t);
    }
    let text_prop = |k: &str| props.get(k).and_then(scalar).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let mut aliases = string_list(props.get("aliases"));
    aliases.extend(string_list(props.get("alias")));
    Meta {
        tags,
        icon: text_prop("icon"),
        cover: text_prop("cover").or_else(|| text_prop("banner")),
        title: text_prop("title"),
        aliases,
        props,
    }
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '/') || is_mark(c)
}

fn is_mark(c: char) -> bool {
    // Combining marks (Indic vowel signs, Arabic harakat, ZWNJ) belong to the word.
    matches!(c as u32, 0x0300..=0x036F | 0x0610..=0x061A | 0x064B..=0x065F | 0x0670 | 0x06D6..=0x06ED | 0x0900..=0x0903 | 0x093A..=0x094F | 0x0951..=0x0957 | 0x0962..=0x0963 | 0x0981..=0x0983 | 0x09BC..=0x09D7 | 0x0A01..=0x0D7F | 0x0E31 | 0x0E34..=0x0E3A | 0x0E47..=0x0E4E | 0x200C | 0x200D)
}

/// `#tags` in Markdown text, outside code: `#` at the start or after a space
/// or bracket, then letters, digits, `_`, `-`, `/`, with at least one
/// non-digit (`#123` is not a tag, `#2024/review` is).
pub fn body_tags(body: &str) -> Vec<String> {
    let mut out = vec![];
    let mut fence: Option<String> = None;
    for line in body.lines() {
        let t = line.trim_start();
        if let Some(f) = &fence {
            if t.starts_with(f.as_str()) {
                fence = None;
            }
            continue;
        }
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = Some(t[..3].to_string());
            continue;
        }
        let mut in_code = false;
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c == '`' {
                in_code = !in_code;
            } else if c == '#' && !in_code && (i == 0 || chars[i - 1].is_whitespace() || matches!(chars[i - 1], '(' | '[' | ',')) {
                let start = i + 1;
                let mut j = start;
                while j < chars.len() && is_tag_char(chars[j]) {
                    j += 1;
                }
                let tag: String = chars[start..j].iter().collect();
                let tag = tag.trim_end_matches(['/', '-']).to_string();
                if !tag.is_empty() && tag.chars().any(|c| !c.is_ascii_digit() && c != '/') {
                    out.push(tag);
                }
                i = j;
                continue;
            }
            i += 1;
        }
    }
    out
}

#[derive(Serialize)]
pub struct TagCount {
    pub tag: String,
    /// Notes with this exact tag (nested tags count separately).
    pub count: usize,
}

/// Every tag in the vault with its note count, sorted by name.
pub fn list_tags(idx: &Index, exclude: &[String]) -> Vec<TagCount> {
    let mut m: BTreeMap<String, (String, usize)> = BTreeMap::new();
    for (_, doc) in idx.iter(exclude) {
        for t in &doc.meta.tags {
            let e = m.entry(t.to_lowercase()).or_insert_with(|| (t.clone(), 0));
            e.1 += 1;
        }
    }
    m.into_values().map(|(tag, count)| TagCount { tag, count }).collect()
}

/// Notes that have an icon, cover, title, aliases or tags.
pub fn note_meta(idx: &Index) -> BTreeMap<String, Meta> {
    idx.iter(&[])
        .filter(|(_, d)| d.meta.icon.is_some() || d.meta.cover.is_some() || d.meta.title.is_some() || !d.meta.aliases.is_empty() || !d.meta.tags.is_empty())
        .map(|(p, d)| (p.clone(), d.meta.clone()))
        .collect()
}

/// `tag` renamed when it is `from` or nested under it (`from/x` → `to/x`).
fn renamed(tag: &str, from: &str, to: &str) -> Option<String> {
    let low = tag.to_lowercase();
    let f = from.to_lowercase();
    if low == f {
        Some(to.to_string())
    } else if low.starts_with(&format!("{f}/")) {
        Some(format!("{to}{}", &tag[from.len()..]))
    } else {
        None
    }
}

/// The note's text with tag `from` (and its nested tags) renamed to `to`:
/// `#tags` in the body (not in code) and entries of the frontmatter `tags`
/// / `tag` key (inline list, comma list or one item per line).
pub fn rename_tag_in(text: &str, from: &str, to: &str) -> Option<String> {
    let (yaml, body, _) = crate::render::split_frontmatter(text);
    let mut out = String::with_capacity(text.len() + 16);
    let mut changed = false;
    if let Some(y) = yaml {
        // Everything before the YAML (the opening ---) is kept as is.
        let start = y.as_ptr() as usize - text.as_ptr() as usize;
        out.push_str(&text[..start]);
        let mut in_tags = false;
        for line in y.split_inclusive('\n') {
            let key = line.split(':').next().unwrap_or("");
            let top_level = !line.starts_with([' ', '\t', '-']) && line.contains(':');
            if top_level {
                in_tags = matches!(key.trim(), "tags" | "tag");
            }
            if !in_tags {
                out.push_str(line);
                continue;
            }
            // Replace whole tokens (between separators) that are the tag.
            let (head, rest) = if top_level { line.split_at(key.len() + 1) } else { ("", line) };
            out.push_str(head);
            let mut tok = String::new();
            let flush = |tok: &mut String, out: &mut String, changed: &mut bool| {
                let t = std::mem::take(tok);
                let (hash, bare) = t.strip_prefix('#').map(|b| ("#", b)).unwrap_or(("", t.as_str()));
                let (q, inner) = if bare.len() >= 2 && (bare.starts_with('"') && bare.ends_with('"') || bare.starts_with('\'') && bare.ends_with('\'')) {
                    (&bare[..1], &bare[1..bare.len() - 1])
                } else {
                    ("", bare)
                };
                let (h2, inner2) = inner.strip_prefix('#').map(|b| ("#", b)).unwrap_or(("", inner));
                match renamed(inner2, from, to) {
                    Some(n) if !inner2.is_empty() => {
                        *changed = true;
                        out.push_str(&format!("{hash}{q}{h2}{n}{q}"));
                    }
                    _ => out.push_str(&t),
                }
            };
            for c in rest.chars() {
                if matches!(c, ' ' | '\t' | ',' | '[' | ']' | '\n' | '\r' | '-') && !(c == '-' && !tok.is_empty()) {
                    flush(&mut tok, &mut out, &mut changed);
                    out.push(c);
                } else {
                    tok.push(c);
                }
            }
            flush(&mut tok, &mut out, &mut changed);
        }
        let body_start = body.as_ptr() as usize - text.as_ptr() as usize;
        out.push_str(&text[start + y.len()..body_start]);
    }
    // Body: walk like body_tags, rewriting the tag spans.
    let mut fence: Option<String> = None;
    for line in body.split_inclusive('\n') {
        let t = line.trim_start();
        if let Some(f) = &fence {
            if t.starts_with(f.as_str()) {
                fence = None;
            }
            out.push_str(line);
            continue;
        }
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = Some(t[..3].to_string());
            out.push_str(line);
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        let mut in_code = false;
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c == '`' {
                in_code = !in_code;
            } else if c == '#' && !in_code && (i == 0 || chars[i - 1].is_whitespace() || matches!(chars[i - 1], '(' | '[' | ',')) {
                let mut j = i + 1;
                while j < chars.len() && is_tag_char(chars[j]) {
                    j += 1;
                }
                let tag: String = chars[i + 1..j].iter().collect();
                let trimmed = tag.trim_end_matches(['/', '-']);
                if let Some(n) = renamed(trimmed, from, to) {
                    changed = true;
                    out.push('#');
                    out.push_str(&n);
                    out.push_str(&tag[trimmed.len()..]);
                    i = j;
                    continue;
                }
                out.extend(&chars[i..j]);
                i = j;
                continue;
            }
            out.push(c);
            i += 1;
        }
    }
    changed.then_some(out)
}

/// Rename a tag in every note; returns `(path, new text)` to write.
pub fn rename_tag(idx: &Index, from: &str, to: &str) -> Vec<(String, String)> {
    let from = from.trim().trim_start_matches('#');
    let to = to.trim().trim_start_matches('#');
    if from.is_empty() || to.is_empty() {
        return vec![];
    }
    idx.iter(&[])
        .filter(|(_, d)| d.meta.tags.iter().any(|t| renamed(t, from, to).is_some()))
        .filter_map(|(p, d)| rename_tag_in(&d.text, from, to).map(|t| (p.clone(), t)))
        .collect()
}

// ------------------------------------------------------------------ query

#[derive(Clone, Copy, Debug, PartialEq)]
enum LineKind {
    Heading,
    Task,
    Todo,
    Done,
    Code,
    Quote,
    Link,
}

enum Term {
    Text(String),
    Regex(Regex),
    Tag(String),
    Path(String),
    File(String),
    Prop(String, Option<String>),
    Kind(LineKind),
}

struct Clause {
    term: Term,
    neg: bool,
}

impl Term {
    fn note_level(&self) -> bool {
        matches!(self, Term::Tag(_) | Term::Path(_) | Term::File(_) | Term::Prop(..))
    }
}

pub struct Query {
    clauses: Vec<Clause>,
}

/// Split on spaces, keeping `"quoted phrases"` and `/regex with spaces/` whole.
fn tokens(q: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let chars: Vec<char> = q.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match quote {
            Some(qc) => {
                cur.push(c);
                if c == qc && !(qc == '/' && i > 0 && chars[i - 1] == '\\') {
                    quote = None;
                }
            }
            None if c.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            None => {
                let at_start = cur.is_empty() || cur == "-" || cur.ends_with(':');
                if (c == '"' || c == '/') && at_start {
                    quote = Some(c);
                }
                cur.push(c);
            }
        }
        i += 1;
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn unquote(s: &str) -> &str {
    s.strip_prefix('"').map(|s| s.strip_suffix('"').unwrap_or(s)).unwrap_or(s)
}

impl Query {
    pub fn parse(q: &str) -> Result<Query, String> {
        let mut clauses = vec![];
        for tok in tokens(q) {
            let (neg, t) = match tok.strip_prefix('-') {
                Some(rest) if !rest.is_empty() => (true, rest.to_string()),
                _ => (false, tok.clone()),
            };
            let term = if let Some(body) = t.strip_prefix('/').filter(|b| b.len() > 1 && (b.ends_with('/') || b.ends_with("/i"))) {
                let (pat, ci) = match body.strip_suffix("/i") {
                    Some(p) => (p, true),
                    None => (&body[..body.len() - 1], false),
                };
                Term::Regex(RegexBuilder::new(pat).case_insensitive(ci).build().map_err(|e| format!("regex: {e}"))?)
            } else if let Some((key, val)) = t.split_once(':').filter(|(k, v)| !v.is_empty() && matches!(*k, "tag" | "path" | "file" | "prop" | "type")) {
                let val = unquote(val);
                match key {
                    "tag" => Term::Tag(val.trim_start_matches('#').to_lowercase()),
                    "path" => Term::Path(normalize_text(val)),
                    "file" => Term::File(normalize_text(val)),
                    "prop" => match val.split_once('=') {
                        Some((k, v)) => Term::Prop(k.to_string(), Some(normalize_text(unquote(v)))),
                        None => Term::Prop(val.to_string(), None),
                    },
                    _ => Term::Kind(match val {
                        "heading" | "h" => LineKind::Heading,
                        "task" => LineKind::Task,
                        "todo" => LineKind::Todo,
                        "done" => LineKind::Done,
                        "code" => LineKind::Code,
                        "quote" => LineKind::Quote,
                        "link" => LineKind::Link,
                        other => return Err(format!("unknown type `{other}` (heading, task, todo, done, code, quote, link)")),
                    }),
                }
            } else if t.starts_with('#') && t.len() > 1 && !t[1..].starts_with('#') {
                Term::Tag(t[1..].to_lowercase())
            } else {
                let s = normalize_text(unquote(&t));
                if s.is_empty() {
                    continue;
                }
                Term::Text(s)
            };
            clauses.push(Clause { term, neg });
        }
        Ok(Query { clauses })
    }

    pub fn is_empty(&self) -> bool {
        self.clauses.is_empty()
    }

    /// Whether the note passes every note-level term (and no negated term
    /// occurs anywhere in it).
    fn note_ok(&self, rel: &str, doc: &crate::vault::Doc) -> bool {
        self.clauses.iter().all(|c| {
            let hit = match &c.term {
                Term::Tag(t) => doc.meta.tags.iter().any(|x| {
                    let x = x.to_lowercase();
                    x == *t || x.starts_with(&format!("{t}/"))
                }),
                Term::Path(p) => normalize_text(rel).contains(p.as_str()),
                Term::File(f) => normalize_text(rel.rsplit('/').next().unwrap_or(rel)).contains(f.as_str()),
                Term::Prop(k, v) => match (doc.meta.props.get(k), v) {
                    (None | Some(Json::Null), _) => false,
                    (Some(_), None) => true,
                    (Some(Json::Array(a)), Some(v)) => a.iter().filter_map(scalar).any(|s| normalize_text(&s) == *v),
                    (Some(x), Some(v)) => scalar(x).is_some_and(|s| normalize_text(&s) == *v),
                },
                // Line terms: negated ones exclude notes that contain them.
                Term::Text(s) if c.neg => doc.norm.iter().any(|l| l.contains(s.as_str())),
                Term::Regex(r) if c.neg => r.is_match(&doc.text),
                _ => return true,
            };
            hit != c.neg
        })
    }

    fn line_terms(&self) -> impl Iterator<Item = &Term> {
        self.clauses.iter().filter(|c| !c.neg && !c.term.note_level()).map(|c| &c.term)
    }
}

#[derive(Serialize)]
pub struct Hit {
    pub path: String,
    /// 1-based; 0 means the note itself (file name or filters matched).
    pub line: usize,
    pub snippet: String,
    /// Matched text inside the snippet, for highlighting.
    pub marks: Vec<String>,
}

fn classify(line: &str, in_code: bool) -> Vec<LineKind> {
    if in_code {
        return vec![LineKind::Code];
    }
    let t = line.trim_start();
    let mut k = vec![];
    let hashes = t.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hashes) && t[hashes..].starts_with(' ') {
        k.push(LineKind::Heading);
    }
    let item = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")).or_else(|| t.strip_prefix("+ ")).or_else(|| {
        let d = t.chars().take_while(char::is_ascii_digit).count();
        (d > 0).then(|| t[d..].strip_prefix(". ").or_else(|| t[d..].strip_prefix(") "))).flatten()
    });
    if let Some(rest) = item {
        if rest.starts_with("[ ]") {
            k.extend([LineKind::Task, LineKind::Todo]);
        } else if rest.len() >= 3 && rest.starts_with('[') && rest.as_bytes().get(2) == Some(&b']') {
            k.extend([LineKind::Task, LineKind::Done]);
        }
    }
    if t.starts_with('>') {
        k.push(LineKind::Quote);
    }
    if t.contains("[[") || t.contains("](") {
        k.push(LineKind::Link);
    }
    k
}

/// A window of the line around its first match (lines can be very long).
fn snippet(line: &str, first: Option<usize>) -> String {
    let line = line.trim();
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= 160 {
        return line.to_string();
    }
    let at = first.map(|b| line[..b.min(line.len())].chars().count()).unwrap_or(0);
    let start = at.saturating_sub(50);
    let end = (start + 160).min(chars.len());
    let mut s: String = chars[start..end].iter().collect();
    if start > 0 {
        s.insert(0, '…');
    }
    if end < chars.len() {
        s.push('…');
    }
    s
}

pub fn search(idx: &Index, query: &str, limit: usize, exclude: &[String]) -> Result<Vec<Hit>, String> {
    let q = Query::parse(query)?;
    if q.is_empty() {
        return Ok(vec![]);
    }
    let line_terms: Vec<&Term> = q.line_terms().collect();
    let words: Vec<&str> = line_terms.iter().filter_map(|t| if let Term::Text(s) = t { Some(s.as_str()) } else { None }).collect();
    let mut hits = vec![];
    for (rel, doc) in idx.iter(exclude) {
        if !q.note_ok(rel, doc) {
            continue;
        }
        if line_terms.is_empty() {
            let title = doc.meta.title.clone().unwrap_or_else(|| rel.clone());
            hits.push(Hit { path: rel.clone(), line: 0, snippet: title, marks: vec![] });
        } else {
            // Plain words that all occur in the file name: the note itself.
            if words.len() == line_terms.len() && words.iter().all(|w| normalize_text(rel).contains(w)) {
                hits.push(Hit { path: rel.clone(), line: 0, snippet: rel.clone(), marks: vec![] });
            }
            let mut fence: Option<&str> = None;
            for (i, (line, norm)) in doc.text.lines().zip(&doc.norm).enumerate() {
                let t = line.trim_start();
                let opener = t.starts_with("```") || t.starts_with("~~~");
                let kinds = classify(line, fence.is_some() || opener);
                match fence {
                    Some(f) if t.starts_with(f) => fence = None,
                    None if opener => fence = Some(&t[..3]),
                    _ => {}
                }
                let mut marks = vec![];
                let mut first = None;
                let ok = line_terms.iter().all(|term| match term {
                    Term::Text(s) => norm.contains(s.as_str()),
                    Term::Regex(r) => match r.find(line) {
                        Some(m) => {
                            first = first.or(Some(m.start()));
                            marks.push(m.as_str().to_string());
                            true
                        }
                        None => false,
                    },
                    Term::Kind(k) => kinds.contains(k),
                    _ => true,
                });
                if ok {
                    for w in &words {
                        // Highlight the original spelling when it is a plain case-insensitive match.
                        if let Some(p) = line.to_lowercase().find(w) {
                            first = first.or(Some(p));
                            marks.push(line.chars().skip(line.to_lowercase()[..p].chars().count()).take(w.chars().count()).collect());
                        } else {
                            marks.push(w.to_string());
                        }
                    }
                    hits.push(Hit { path: rel.clone(), line: i + 1, snippet: snippet(line, first), marks });
                }
                if hits.len() >= limit {
                    return Ok(hits);
                }
            }
        }
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

// ------------------------------------------------------------------ replace

#[derive(serde::Deserialize)]
pub struct ReplaceOpts {
    pub find: String,
    #[serde(default)]
    pub replace: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case: bool,
    #[serde(default)]
    pub word: bool,
    /// Note filters limiting where to replace (`path:… tag:…`).
    #[serde(default)]
    pub scope: String,
}

#[derive(Serialize)]
pub struct LineChange {
    pub line: usize,
    pub before: String,
    pub after: String,
    pub count: usize,
    /// Each match: where it starts in `before` (in UTF-16 units, for the
    /// UI), the text removed and the text put in.
    pub edits: Vec<Edit>,
}

#[derive(Serialize)]
pub struct Edit {
    pub at: usize,
    pub old: String,
    pub new: String,
}

#[derive(Serialize)]
pub struct FileChanges {
    pub path: String,
    pub lines: Vec<LineChange>,
    pub count: usize,
}

fn replace_regex(o: &ReplaceOpts) -> Result<Regex, String> {
    if o.find.is_empty() {
        return Err("nothing to find".into());
    }
    let mut pat = if o.regex { o.find.clone() } else { regex::escape(&o.find) };
    if o.word {
        pat = format!(r"\b(?:{pat})\b");
    }
    RegexBuilder::new(&pat).case_insensitive(!o.case).build().map_err(|e| format!("regex: {e}"))
}

/// The text with every match replaced, and the per-line changes.
fn replace_text(re: &Regex, o: &ReplaceOpts, text: &str) -> (String, Vec<LineChange>) {
    let mut changes = vec![];
    let mut out = String::with_capacity(text.len());
    for (i, line) in text.split_inclusive('\n').enumerate() {
        let (body, nl) = match line.strip_suffix('\n') {
            Some(b) => match b.strip_suffix('\r') {
                Some(bb) => (bb, "\r\n"),
                None => (b, "\n"),
            },
            None => (line, ""),
        };
        let edits: Vec<Edit> = re
            .captures_iter(body)
            .map(|c| {
                let m = c.get(0).unwrap();
                let mut new = String::new();
                if o.regex {
                    c.expand(&o.replace, &mut new);
                } else {
                    new.push_str(&o.replace);
                }
                Edit { at: body[..m.start()].encode_utf16().count(), old: m.as_str().to_string(), new }
            })
            .collect();
        let count = edits.len();
        if count == 0 {
            out.push_str(line);
            continue;
        }
        let after = if o.regex { re.replace_all(body, o.replace.as_str()) } else { re.replace_all(body, regex::NoExpand(&o.replace)) };
        changes.push(LineChange { line: i + 1, before: body.to_string(), after: after.to_string(), count, edits });
        out.push_str(&after);
        out.push_str(nl);
    }
    (out, changes)
}

/// What a replace would change, file by file (nothing is written).
pub fn replace_preview(idx: &Index, o: &ReplaceOpts, exclude: &[String]) -> Result<Vec<FileChanges>, String> {
    let re = replace_regex(o)?;
    let scope = Query::parse(&o.scope)?;
    let mut out = vec![];
    for (rel, doc) in idx.iter(exclude) {
        if !scope.note_ok(rel, doc) || !re.is_match(&doc.text) {
            continue;
        }
        let (_, lines) = replace_text(&re, o, &doc.text);
        let count = lines.iter().map(|l| l.count).sum();
        if count > 0 {
            out.push(FileChanges { path: rel.clone(), lines, count });
        }
    }
    Ok(out)
}

/// Replace in `paths` (from a preview); returns `(path, new text)` to write.
pub fn replace_apply(idx: &Index, o: &ReplaceOpts, paths: &[String]) -> Result<Vec<(String, String)>, String> {
    let re = replace_regex(o)?;
    let mut out = vec![];
    for p in paths {
        let Some(text) = idx.text(p) else { continue };
        let (new, lines) = replace_text(&re, o, text);
        if !lines.is_empty() {
            out.push((p.clone(), new));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idx(notes: &[(&str, &str)]) -> Index {
        let mut i = Index::default();
        for (p, t) in notes {
            i.put(p, t);
        }
        i
    }

    #[test]
    fn tags_from_body_and_frontmatter() {
        let m = meta("---\ntags: [project, \"#Work/Q1\"]\naliases: Proj\nicon: 🚀\n---\n# Heading\nText #idea and #área/sub, not #123 or a#b.\n`#code` here\n#late\n```\n#fenced\n```\n#مقاله");
        assert_eq!(m.tags, ["project", "Work/Q1", "idea", "área/sub", "late", "مقاله"]);
        assert_eq!(m.aliases, ["Proj"]);
        assert_eq!(m.icon.as_deref(), Some("🚀"));
    }

    #[test]
    fn rename_tags() {
        let text = "---\ntitle: x\ntags: [work, \"Work/q1\", other]\nkeywords: [work]\n---\n#work and #work/q2 #workshop `#work`\n- work item\n```\n#work\n```\n";
        assert_eq!(
            rename_tag_in(text, "work", "job").unwrap(),
            "---\ntitle: x\ntags: [job, \"job/q1\", other]\nkeywords: [work]\n---\n#job and #job/q2 #workshop `#work`\n- work item\n```\n#work\n```\n"
        );
        let list = "---\ntags:\n  - work\n  - home\n---\nbody";
        assert_eq!(rename_tag_in(list, "work", "job").unwrap(), "---\ntags:\n  - job\n  - home\n---\nbody");
        assert_eq!(rename_tag_in("---\ntags: work, home\n---\n", "home", "house").unwrap(), "---\ntags: work, house\n---\n");
        assert!(rename_tag_in("no tags here", "work", "job").is_none());
    }

    #[test]
    fn query_filters_and_lines() {
        let i = idx(&[
            ("work/a.md", "---\nstatus: done\ntags: [work]\n---\n# Plan\n- [ ] write report\n- [x] call Bob\nThe café is open.\n```\nreport()\n```"),
            ("home/b.md", "#home/garden notes\nreport on roses"),
        ]);
        let paths = |q: &str| search(&i, q, 100, &[]).unwrap().into_iter().map(|h| format!("{}:{}", h.path, h.line)).collect::<Vec<_>>();
        assert_eq!(paths("report"), ["home/b.md:2", "work/a.md:6", "work/a.md:10"]);
        assert_eq!(paths("report type:todo"), ["work/a.md:6"]);
        assert_eq!(paths("report type:code"), ["work/a.md:10"]);
        assert_eq!(paths("type:done"), ["work/a.md:7"]);
        assert_eq!(paths("type:heading"), ["work/a.md:5"]);
        assert_eq!(paths("tag:home"), ["home/b.md:0"]);
        assert_eq!(paths("#work report -roses"), ["work/a.md:6", "work/a.md:10"]);
        assert_eq!(paths("prop:status=done cafe"), ["work/a.md:8"]);
        assert_eq!(paths("path:home roses"), ["home/b.md:2"]);
        assert_eq!(paths("/c[a-z]ll/"), ["work/a.md:7"]);
        assert_eq!(paths("\"call bob\""), ["work/a.md:7"]);
        assert!(Query::parse("/(/").is_err());
        assert!(Query::parse("type:nope").is_err());
    }

    #[test]
    fn replace_preview_and_apply() {
        let i = idx(&[("a.md", "Foo foo food\r\nfoo\n"), ("b/c.md", "no match"), ("d.md", "foo")]);
        let o = ReplaceOpts { find: "foo".into(), replace: "bar".into(), regex: false, case: false, word: true, scope: "-path:d.md".into() };
        let p = replace_preview(&i, &o, &[]).unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].count, 3);
        assert_eq!(p[0].lines[0].after, "bar bar food");
        assert_eq!(p[0].lines[0].edits.iter().map(|e| e.at).collect::<Vec<_>>(), [0, 4]);
        let w = replace_apply(&i, &o, &["a.md".into()]).unwrap();
        assert_eq!(w[0].1, "bar bar food\r\nbar\n");
        let re = ReplaceOpts { find: r"(\w+)@(\w+)".into(), replace: "$2 at $1".into(), regex: true, case: true, word: false, scope: String::new() };
        let i = idx(&[("x.md", "mail me@home")]);
        assert_eq!(replace_apply(&i, &re, &["x.md".into()]).unwrap()[0].1, "mail home at me");
    }
}
