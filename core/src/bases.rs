//! Databases: Obsidian Bases-compatible `.base` files and ```` ```base ````
//! blocks. A base is YAML:
//!
//! ```yaml
//! filters:                 # which files (an expression, or and/or/not lists)
//!   and:
//!     - file.hasTag("book")
//!     - 'status != "done"'
//! formulas:                # computed columns
//!   per_page: price / pages
//! properties:              # column names
//!   formula.per_page: { displayName: "Price per page" }
//! views:
//!   - type: table          # table | cards | list | board
//!     name: Reading list
//!     filters: …           # this view only
//!     order: [file.name, status, formula.per_page]
//!     sort: [{ property: rating, direction: DESC }]
//!     groupBy: { property: status, direction: ASC }
//!     limit: 50
//!     image: cover         # cards: the cover image property
//! ```
//!
//! Expressions use the Bases syntax: `file.*` (name, basename, path, folder,
//! ext, size, ctime, mtime, tags, links, backlinks, embeds, properties,
//! hasTag(), inFolder(), hasLink(), hasProperty(), asLink()), note
//! properties (`status`, `note.status`, `note["a b"]`), `formula.x`, `this`
//! (the note showing the base), operators `+ - * / % == != < <= > >= && || !`,
//! functions (`if`, `now`, `today`, `date`, `duration`, `link`, `list`,
//! `number`, `min`, `max`, `file`) and methods on strings, numbers, dates,
//! lists, links and files (see docs/DATABASES.md).

mod eval;
mod parser;

use self::eval::Ctx;
use self::parser::{parse, Expr};
use crate::links::{scan_full, Resolver};
use crate::vault::{self, Index};
use chrono::{Datelike, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value as Json};
use std::cell::{OnceCell, RefCell};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

// ================================================================ values

#[derive(Clone, Debug)]
pub enum V {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    /// A moment; `bool` = has a time of day.
    Date(NaiveDateTime, bool),
    /// Milliseconds.
    Dur(i64),
    List(Vec<V>),
    /// A link: the vault path it resolves to (if any), its target text and display text.
    Link { path: Option<String>, target: String, display: Option<String> },
    /// A file of the vault, by index into the file table.
    File(usize),
    Obj(BTreeMap<String, V>),
    Regex(Regex),
}

impl V {
    fn truthy(&self) -> bool {
        match self {
            V::Null => false,
            V::Bool(b) => *b,
            V::Num(n) => *n != 0.0 && !n.is_nan(),
            V::Str(s) => !s.is_empty(),
            V::List(l) => !l.is_empty(),
            V::Obj(o) => !o.is_empty(),
            _ => true,
        }
    }
    fn is_empty(&self) -> bool {
        match self {
            V::Null => true,
            V::Str(s) => s.trim().is_empty(),
            V::List(l) => l.is_empty(),
            V::Obj(o) => o.is_empty(),
            _ => false,
        }
    }
    fn type_name(&self) -> &'static str {
        match self {
            V::Null => "null",
            V::Bool(_) => "boolean",
            V::Num(_) => "number",
            V::Str(_) => "string",
            V::Date(..) => "date",
            V::Dur(_) => "duration",
            V::List(_) => "list",
            V::Link { .. } => "link",
            V::File(_) => "file",
            V::Obj(_) => "object",
            V::Regex(_) => "regexp",
        }
    }
}

fn num_str(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else if n.is_finite() {
        let s = format!("{:.10}", n);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        n.to_string()
    }
}

fn date_str(d: &NaiveDateTime, time: bool) -> String {
    if time { d.format("%Y-%m-%d %H:%M").to_string() } else { d.format("%Y-%m-%d").to_string() }
}

fn dur_str(ms: i64) -> String {
    let neg = ms < 0;
    let mut s = ms.unsigned_abs() / 1000;
    let mut parts = vec![];
    for (unit, n) in [("d", 86400), ("h", 3600), ("m", 60), ("s", 1)] {
        if s >= n {
            parts.push(format!("{}{unit}", s / n));
            s %= n;
        }
    }
    if parts.is_empty() {
        parts.push("0s".into());
    }
    format!("{}{}", if neg { "-" } else { "" }, parts.join(" "))
}

// ================================================================ dates

/// `2026-11-09`, `2026-11-09T14:30`, `2026-11-09 14:30:05`, with an optional `Z`/offset (ignored).
pub fn parse_date(s: &str) -> Option<(NaiveDateTime, bool)> {
    let s = s.trim();
    if s.len() < 10 || !s.as_bytes()[0].is_ascii_digit() {
        return None;
    }
    let d = NaiveDate::parse_from_str(s.get(..10)?, "%Y-%m-%d").ok()?;
    let rest = s[10..].trim_start_matches(['T', ' ']);
    if rest.is_empty() {
        return Some((d.and_time(NaiveTime::MIN), false));
    }
    let rest = rest.trim_end_matches('Z');
    let rest = rest.split(['+']).next().unwrap_or(rest);
    let rest = if rest.len() > 8 && rest[8..].starts_with('-') { &rest[..8] } else { rest };
    let rest = rest.split('.').next().unwrap_or(rest);
    for f in ["%H:%M:%S", "%H:%M"] {
        if let Ok(t) = NaiveTime::parse_from_str(rest, f) {
            return Some((d.and_time(t), true));
        }
    }
    None
}

/// `1d`, `2 weeks`, `3h 30m`, `-1y`: milliseconds. Months are 30 days, years 365.
pub fn parse_duration(s: &str) -> Option<i64> {
    let re = Regex::new(r"(?i)^\s*([+-]?\d+(?:\.\d+)?)\s*([a-z]+)\s*").unwrap();
    let mut rest = s.trim();
    if rest.is_empty() {
        return None;
    }
    let mut total = 0f64;
    while !rest.is_empty() {
        let c = re.captures(rest)?;
        let n: f64 = c[1].parse().ok()?;
        let unit = c[2].to_lowercase();
        let ms = match unit.as_str() {
            "ms" | "millisecond" | "milliseconds" => 1.0,
            "s" | "sec" | "secs" | "second" | "seconds" => 1e3,
            "m" | "min" | "mins" | "minute" | "minutes" => 6e4,
            "h" | "hr" | "hrs" | "hour" | "hours" => 3.6e6,
            "d" | "day" | "days" => 8.64e7,
            "w" | "week" | "weeks" => 6.048e8,
            "mo" | "month" | "months" => 2.592e9,
            "y" | "yr" | "year" | "years" => 3.1536e10,
            _ => return None,
        };
        // "M" alone is months in Obsidian's duration strings.
        let ms = if &c[2] == "M" { 2.592e9 } else { ms };
        total += n * ms;
        rest = &rest[c[0].len()..];
    }
    Some(total as i64)
}

fn add_months(d: NaiveDateTime, months: i32) -> NaiveDateTime {
    let total = d.year() * 12 + d.month0() as i32 + months;
    let (y, m) = (total.div_euclid(12), total.rem_euclid(12) as u32 + 1);
    let mut day = d.day();
    loop {
        if let Some(nd) = NaiveDate::from_ymd_opt(y, m, day) {
            return nd.and_time(d.time());
        }
        day -= 1;
    }
}

/// Date ± a duration string: months and years are calendar months and years.
fn shift(d: NaiveDateTime, s: &str, sign: i64) -> Option<NaiveDateTime> {
    let re = Regex::new(r"^\s*([+-]?\d+)\s*(M|mo|months?|y|yr|years?)\s*$").unwrap();
    if let Some(c) = re.captures(s) {
        let n: i32 = c[1].parse().ok()?;
        let months = if c[2].starts_with('y') { n * 12 } else { n };
        return Some(add_months(d, months * sign as i32));
    }
    Some(d + Duration::milliseconds(parse_duration(s)? * sign))
}

/// Moment.js-style formatting: YYYY YY MMMM MMM MM M DD D dddd ddd HH H hh h mm ss A a, [literal].
pub fn format_date(d: &NaiveDateTime, fmt: &str) -> String {
    const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const DAYS: [&str; 7] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    let mut out = String::new();
    let cs: Vec<char> = fmt.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        if cs[i] == '[' {
            let end = cs[i..].iter().position(|&c| c == ']').map(|p| p + i).unwrap_or(cs.len());
            out.extend(&cs[i + 1..end.min(cs.len())]);
            i = end + 1;
            continue;
        }
        let run = cs[i..].iter().take_while(|&&c| c == cs[i]).count();
        let tok: String = cs[i..i + run].iter().collect();
        let h12 = if d.hour() % 12 == 0 { 12 } else { d.hour() % 12 };
        let s = match tok.as_str() {
            "YYYY" => format!("{:04}", d.year()),
            "YY" => format!("{:02}", d.year() % 100),
            "MMMM" => MONTHS[d.month0() as usize].into(),
            "MMM" => MONTHS[d.month0() as usize][..3].into(),
            "MM" => format!("{:02}", d.month()),
            "M" => d.month().to_string(),
            "DD" => format!("{:02}", d.day()),
            "D" => d.day().to_string(),
            "dddd" => DAYS[d.weekday().num_days_from_monday() as usize].into(),
            "ddd" => DAYS[d.weekday().num_days_from_monday() as usize][..3].into(),
            "HH" => format!("{:02}", d.hour()),
            "H" => d.hour().to_string(),
            "hh" => format!("{:02}", h12),
            "h" => h12.to_string(),
            "mm" => format!("{:02}", d.minute()),
            "ss" => format!("{:02}", d.second()),
            "A" => if d.hour() < 12 { "AM" } else { "PM" }.into(),
            "a" => if d.hour() < 12 { "am" } else { "pm" }.into(),
            _ => {
                // Not a token: emit one character and go on.
                out.push(cs[i]);
                i += 1;
                continue;
            }
        };
        out.push_str(&s);
        i += run;
    }
    out
}

fn relative(d: &NaiveDateTime, now: &NaiveDateTime) -> String {
    let secs = (*now - *d).num_seconds();
    let (a, past) = (secs.unsigned_abs(), secs >= 0);
    let (n, unit) = if a < 45 {
        return "just now".into();
    } else if a < 3600 {
        (a.div_ceil(60).max(1), "minute")
    } else if a < 86400 {
        ((a + 1800) / 3600, "hour")
    } else if a < 86400 * 30 {
        ((a + 43200) / 86400, "day")
    } else if a < 86400 * 365 {
        ((a + 86400 * 15) / (86400 * 30), "month")
    } else {
        ((a + 86400 * 182) / (86400 * 365), "year")
    };
    let unit = if n == 1 { unit.to_string() } else { format!("{unit}s") };
    if past { format!("{n} {unit} ago") } else { format!("in {n} {unit}") }
}

// ================================================================ files

pub struct FileRec {
    pub path: String,
    note: bool,
    size: u64,
    ctime: Option<NaiveDateTime>,
    mtime: Option<NaiveDateTime>,
    props: BTreeMap<String, V>,
    tags: Vec<String>,
    /// (resolved path, target, embed)
    links: OnceCell<Vec<(Option<String>, String, bool)>>,
}

pub struct Files<'a> {
    pub list: Vec<FileRec>,
    by_path: HashMap<String, usize>,
    idx: &'a Index,
    resolver: Resolver<'a>,
    backlinks: OnceCell<HashMap<String, Vec<usize>>>,
}

fn local(t: std::time::SystemTime) -> Option<NaiveDateTime> {
    let d = t.duration_since(std::time::UNIX_EPOCH).ok()?;
    Local.timestamp_opt(d.as_secs() as i64, d.subsec_nanos()).single().map(|x| x.naive_local())
}

fn wiki_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^!?\[\[([^\]|#]*)(#[^\]|]*)?(?:\|([^\]]*))?\]\]$").unwrap())
}

impl<'a> Files<'a> {
    pub fn new(idx: &'a Index, root: &'a Path, exclude: &[String]) -> Self {
        let resolver = Resolver::new(idx, root);
        let mut list = vec![];
        for (p, d) in idx.iter(exclude) {
            list.push(FileRec {
                path: p.clone(),
                note: true,
                size: d.text.len() as u64,
                ctime: None,
                mtime: None,
                props: BTreeMap::new(),
                tags: d.meta.tags.clone(),
                links: OnceCell::new(),
            });
        }
        for p in vault::all_files(root) {
            if !vault::excluded(&p, exclude) {
                list.push(FileRec { path: p, note: false, size: 0, ctime: None, mtime: None, props: BTreeMap::new(), tags: vec![], links: OnceCell::new() });
            }
        }
        list.sort_by(|a, b| a.path.cmp(&b.path));
        for f in &mut list {
            if let Ok(m) = std::fs::metadata(root.join(&f.path)) {
                f.size = m.len();
                f.mtime = m.modified().ok().and_then(local);
                f.ctime = m.created().ok().and_then(local).or(f.mtime);
            }
        }
        let by_path = list.iter().enumerate().map(|(i, f)| (f.path.clone(), i)).collect();
        let mut files = Files { list, by_path, idx, resolver, backlinks: OnceCell::new() };
        // Properties: YAML values, with dates and [[links]] recognised.
        let props: Vec<(usize, BTreeMap<String, V>)> = idx
            .iter(exclude)
            .filter_map(|(p, d)| {
                let i = files.find(p)?;
                Some((i, d.meta.props.iter().map(|(k, v)| (k.clone(), files.from_json(p, v))).collect()))
            })
            .collect();
        for (i, p) in props {
            files.list[i].props = p;
        }
        files
    }

    fn from_json(&self, from: &str, v: &Json) -> V {
        match v {
            Json::Null => V::Null,
            Json::Bool(b) => V::Bool(*b),
            Json::Number(n) => V::Num(n.as_f64().unwrap_or(0.0)),
            Json::String(s) => self.from_str(from, s),
            Json::Array(a) => V::List(a.iter().map(|x| self.from_json(from, x)).collect()),
            Json::Object(o) => V::Obj(o.iter().map(|(k, x)| (k.clone(), self.from_json(from, x))).collect()),
        }
    }

    /// A property string: a date, a `[[link]]`, or text.
    fn from_str(&self, from: &str, s: &str) -> V {
        if let Some((d, t)) = parse_date(s) {
            return V::Date(d, t);
        }
        if let Some(c) = wiki_re().captures(s.trim()) {
            return self.link(from, &c[1], c.get(3).map(|m| m.as_str().to_string()));
        }
        V::Str(s.to_string())
    }

    fn link(&self, from: &str, target: &str, display: Option<String>) -> V {
        let path = if target.is_empty() { Some(from.to_string()) } else { self.resolver.resolve(from, target).map(|(p, _)| p) };
        V::Link { path, target: target.to_string(), display }
    }

    fn links_of(&self, i: usize) -> &Vec<(Option<String>, String, bool)> {
        self.list[i].links.get_or_init(|| {
            let f = &self.list[i];
            let Some(text) = self.idx.text(&f.path) else { return vec![] };
            scan_full(text)
                .into_iter()
                .map(|l| {
                    let raw = text[l.target.clone()].to_string();
                    let to = if raw.trim().is_empty() { None } else { self.resolver.resolve(&f.path, &raw).map(|(p, _)| p) };
                    (to, raw, l.embed)
                })
                .collect()
        })
    }

    fn backlinks_of(&self, i: usize) -> Vec<usize> {
        let map = self.backlinks.get_or_init(|| {
            let mut m: HashMap<String, Vec<usize>> = HashMap::new();
            for j in 0..self.list.len() {
                if !self.list[j].note {
                    continue;
                }
                for (to, _, _) in self.links_of(j) {
                    if let Some(to) = to {
                        let v = m.entry(to.clone()).or_default();
                        if v.last() != Some(&j) {
                            v.push(j);
                        }
                    }
                }
            }
            m
        });
        map.get(&self.list[i].path).cloned().unwrap_or_default()
    }

    fn find(&self, path: &str) -> Option<usize> {
        self.by_path.get(path).copied()
    }
}

/// Case-insensitive comparison with digit runs compared by value ("note 2" < "note 10").
pub fn natural(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(p), Some(q)) if p.is_ascii_digit() && q.is_ascii_digit() => {
                let mut n1 = String::new();
                while let Some(c) = x.peek().filter(|c| c.is_ascii_digit()) {
                    n1.push(*c);
                    x.next();
                }
                let mut n2 = String::new();
                while let Some(c) = y.peek().filter(|c| c.is_ascii_digit()) {
                    n2.push(*c);
                    y.next();
                }
                let (t1, t2) = (n1.trim_start_matches('0'), n2.trim_start_matches('0'));
                let o = t1.len().cmp(&t2.len()).then(t1.cmp(t2));
                if o != Ordering::Equal {
                    return o;
                }
            }
            (Some(p), Some(q)) => {
                if p != q {
                    return p.cmp(&q);
                }
                x.next();
                y.next();
            }
        }
    }
}

// ================================================================ the base

#[derive(Clone, Debug)]
enum Filter {
    Expr(String),
    And(Vec<Filter>),
    Or(Vec<Filter>),
    Not(Vec<Filter>),
}

fn filter_from(v: &Json) -> Result<Option<Filter>, String> {
    Ok(match v {
        Json::Null => None,
        Json::String(s) => Some(Filter::Expr(s.clone())),
        Json::Bool(b) => Some(Filter::Expr(b.to_string())),
        Json::Array(a) => Some(Filter::And(a.iter().map(filter_from).collect::<Result<Vec<_>, _>>()?.into_iter().flatten().collect())),
        Json::Object(o) => {
            let list = |k: &str| -> Result<Vec<Filter>, String> {
                match o.get(k) {
                    Some(Json::Array(a)) => Ok(a.iter().map(filter_from).collect::<Result<Vec<_>, _>>()?.into_iter().flatten().collect()),
                    Some(x) => Ok(filter_from(x)?.into_iter().collect()),
                    None => Ok(vec![]),
                }
            };
            if o.contains_key("and") {
                Some(Filter::And(list("and")?))
            } else if o.contains_key("or") {
                Some(Filter::Or(list("or")?))
            } else if o.contains_key("not") {
                Some(Filter::Not(list("not")?))
            } else {
                return Err(format!("a filter needs and:, or: or not: (found {})", o.keys().cloned().collect::<Vec<_>>().join(", ")));
            }
        }
        Json::Number(n) => Some(Filter::Expr(n.to_string())),
    })
}

fn compile_filter(f: &Filter, out: &mut HashMap<String, Result<Expr, String>>) {
    match f {
        Filter::Expr(s) => {
            out.entry(s.clone()).or_insert_with(|| parse(s));
        }
        Filter::And(l) | Filter::Or(l) | Filter::Not(l) => l.iter().for_each(|x| compile_filter(x, out)),
    }
}

fn test(ctx: &Ctx, f: &Filter, compiled: &HashMap<String, Result<Expr, String>>, errors: &RefCell<Vec<String>>) -> bool {
    match f {
        Filter::Expr(s) => match &compiled[s] {
            Ok(e) => match ctx.eval(e) {
                Ok(v) => v.truthy(),
                Err(err) => {
                    let msg = format!("{s}: {err}");
                    let mut errs = errors.borrow_mut();
                    if errs.len() < 20 && !errs.contains(&msg) {
                        errs.push(msg);
                    }
                    false
                }
            },
            Err(_) => false,
        },
        Filter::And(l) => l.iter().all(|x| test(ctx, x, compiled, errors)),
        Filter::Or(l) => l.is_empty() || l.iter().any(|x| test(ctx, x, compiled, errors)),
        Filter::Not(l) => !l.iter().any(|x| test(ctx, x, compiled, errors)),
    }
}

#[derive(Serialize, Clone)]
pub struct ViewInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Serialize)]
pub struct Column {
    /// `file.name`, `note.status`, `formula.x`.
    pub id: String,
    pub name: String,
    /// A note property (editable in the note's frontmatter).
    pub editable: bool,
}

#[derive(Serialize)]
pub struct Row {
    pub path: String,
    pub cells: Vec<Json>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// The raw group value (board view: what a card dropped in the group gets).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_value: Option<Json>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<Json>,
    /// Query blocks: the matching lines (1-based line, text).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lines: Vec<(usize, String)>,
}

#[derive(Serialize)]
pub struct BaseResult {
    pub views: Vec<ViewInfo>,
    pub view: usize,
    #[serde(rename = "type")]
    pub kind: String,
    pub columns: Vec<Column>,
    pub rows: Vec<Row>,
    /// Matching files before `limit`.
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_by: Option<String>,
    /// Group names in order (board columns), including empty ones the view lists.
    pub groups: Vec<String>,
    pub errors: Vec<String>,
    /// The view's own settings (as written), for the UI.
    pub options: Json,
}

/// A base's spec, parsed from YAML.
struct Spec {
    filters: Option<Filter>,
    formulas: BTreeMap<String, String>,
    names: BTreeMap<String, String>,
    views: Vec<Map<String, Json>>,
}

fn spec(src: &str) -> Result<Spec, String> {
    let y: serde_yaml_ng::Value = if src.trim().is_empty() { serde_yaml_ng::Value::Null } else { serde_yaml_ng::from_str(src).map_err(|e| format!("YAML: {e}"))? };
    let j = serde_json::to_value(y).map_err(|e| e.to_string())?;
    let o = match j {
        Json::Object(o) => o,
        Json::Null => Map::new(),
        _ => return Err("a base is a YAML mapping (filters:, formulas:, views:)".into()),
    };
    let filters = o.get("filters").map(filter_from).transpose()?.flatten();
    let formulas = match o.get("formulas") {
        Some(Json::Object(m)) => m.iter().map(|(k, v)| (k.clone(), v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))).collect(),
        _ => BTreeMap::new(),
    };
    let names = match o.get("properties") {
        Some(Json::Object(m)) => m
            .iter()
            .filter_map(|(k, v)| v.get("displayName").and_then(|d| d.as_str()).map(|d| (normalize_id(k), d.to_string())))
            .collect(),
        _ => BTreeMap::new(),
    };
    let views = match o.get("views") {
        Some(Json::Array(a)) => a.iter().filter_map(|v| v.as_object().cloned()).collect(),
        _ => vec![],
    };
    Ok(Spec { filters, formulas, names, views })
}

/// `status` → `note.status`; `file.x`, `formula.x`, `note.x` stay.
pub fn normalize_id(id: &str) -> String {
    let id = id.trim();
    if id.starts_with("file.") || id.starts_with("formula.") || id.starts_with("note.") { id.to_string() } else { format!("note.{id}") }
}

fn default_name(id: &str) -> String {
    match id {
        "file.name" => "File name".into(),
        "file.basename" => "Name".into(),
        "file.path" => "Path".into(),
        "file.folder" => "Folder".into(),
        "file.ext" => "Extension".into(),
        "file.size" => "Size".into(),
        "file.ctime" => "Created".into(),
        "file.mtime" => "Modified".into(),
        "file.tags" => "Tags".into(),
        "file.links" => "Links".into(),
        "file.backlinks" => "Backlinks".into(),
        _ => id.split_once('.').map(|(_, n)| n.to_string()).unwrap_or_else(|| id.to_string()),
    }
}

/// Values as JSON for the UI: dates `{"date": "…"}`, links `{"link": path, "text": …}`,
/// durations `{"duration": "…"}`.
/// A column's output cell: `file.name` of a note shows as a link to it
/// without ".md" (as Obsidian's views do); everything else as is.
fn cell_json(ctx: &Ctx, id: &str, v: &V) -> Json {
    if id == "file.name" {
        if let V::Str(s) = v {
            let path = &ctx.current_file().path;
            if let Some(b) = s.strip_suffix(".md") {
                return json!({ "link": path, "text": b, "target": b });
            }
        }
    }
    to_json(ctx, v)
}

fn to_json(ctx: &Ctx, v: &V) -> Json {
    match v {
        V::Null => Json::Null,
        V::Bool(b) => Json::Bool(*b),
        V::Num(n) => serde_json::Number::from_f64(*n).map(Json::Number).unwrap_or(Json::Null),
        V::Str(s) => Json::String(s.clone()),
        V::Date(d, t) => json!({ "date": date_str(d, *t) }),
        V::Dur(ms) => json!({ "duration": dur_str(*ms), "ms": ms }),
        V::List(l) => Json::Array(l.iter().map(|x| to_json(ctx, x)).collect()),
        V::Link { path, target, .. } => json!({ "link": path, "target": target, "text": ctx.to_string(v) }),
        V::File(i) => json!({ "link": ctx.file_path(*i), "text": ctx.to_string(v) }),
        V::Obj(o) => Json::Object(o.iter().filter(|(k, _)| !k.starts_with('\u{0}')).map(|(k, x)| (k.clone(), to_json(ctx, x))).collect()),
        V::Regex(r) => Json::String(r.as_str().to_string()),
    }
}

/// Run view `view` (index or name; the first by default) of the base `src`.
/// `this` is the note showing the base (or the .base file).
pub fn query(idx: &Index, root: &Path, src: &str, view: Option<&str>, this: Option<&str>, exclude: &[String]) -> Result<BaseResult, String> {
    let sp = spec(src)?;
    let files = Files::new(idx, root, exclude);
    run(&files, &sp, view, this)
}

fn run(files: &Files, sp: &Spec, view: Option<&str>, this: Option<&str>) -> Result<BaseResult, String> {
    let mut views: Vec<ViewInfo> = sp
        .views
        .iter()
        .enumerate()
        .map(|(i, v)| ViewInfo {
            name: v.get("name").and_then(|n| n.as_str()).map(String::from).unwrap_or_else(|| format!("View {}", i + 1)),
            kind: v.get("type").and_then(|n| n.as_str()).unwrap_or("table").to_string(),
        })
        .collect();
    let empty = Map::new();
    if views.is_empty() {
        views.push(ViewInfo { name: "Table".into(), kind: "table".into() });
    }
    let vi = match view {
        Some(v) => v.parse::<usize>().ok().filter(|i| *i < views.len()).or_else(|| views.iter().position(|x| x.name == v)).unwrap_or(0),
        None => 0,
    };
    let vspec = sp.views.get(vi).unwrap_or(&empty);
    let kind = views[vi].kind.clone();
    let mut errors: Vec<String> = vec![];

    let formulas: BTreeMap<String, Result<Expr, String>> = sp.formulas.iter().map(|(k, v)| (k.clone(), parse(v))).collect();
    for (k, f) in &formulas {
        if let Err(e) = f {
            errors.push(format!("formula {k}: {e}"));
        }
    }
    let vfilter = vspec.get("filters").map(filter_from).transpose()?.flatten();
    let all: Vec<Filter> = sp.filters.iter().chain(vfilter.iter()).cloned().collect();
    let filter = Filter::And(all);
    let mut compiled = HashMap::new();
    compile_filter(&filter, &mut compiled);
    for (s, c) in &compiled {
        if let Err(e) = c {
            errors.push(format!("filter “{s}”: {e}"));
        }
    }

    // Columns: the view's order, else name + every property used by the matches.
    let ids_of = |k: &str| -> Vec<String> {
        match vspec.get(k) {
            Some(Json::Array(a)) => a.iter().filter_map(|x| x.as_str()).map(normalize_id).collect(),
            _ => vec![],
        }
    };
    let order = ids_of("order");
    let sort: Vec<(String, bool)> = match vspec.get("sort") {
        Some(Json::Array(a)) => a
            .iter()
            .filter_map(|s| {
                let p = s.get("property").and_then(|p| p.as_str())?;
                let desc = s.get("direction").and_then(|d| d.as_str()).is_some_and(|d| d.eq_ignore_ascii_case("desc"));
                Some((normalize_id(p), desc))
            })
            .collect(),
        _ => vec![],
    };
    let group: Option<(String, bool)> = vspec.get("groupBy").and_then(|g| {
        let p = g.as_str().or_else(|| g.get("property").and_then(|p| p.as_str()))?;
        let desc = g.get("direction").and_then(|d| d.as_str()).is_some_and(|d| d.eq_ignore_ascii_case("desc"));
        Some((normalize_id(p), desc))
    });
    let image = vspec.get("image").and_then(|i| i.as_str()).map(normalize_id);
    let limit = vspec.get("limit").and_then(|l| l.as_u64()).map(|l| l as usize);

    let this_i = this.and_then(|t| files.find(t));
    let now = Local::now().naive_local();
    let errs = RefCell::new(vec![]);
    struct Hit {
        file: usize,
        sort: Vec<V>,
        group: V,
        cells: Vec<Json>,
        image: Option<Json>,
        gs: String,
    }
    let mut hits: Vec<(usize, Vec<V>, V)> = vec![];
    let new_ctx = |i| Ctx::new(files, i, this_i, &formulas, now);
    let mut seen_props: Vec<String> = vec![];
    for i in 0..files.list.len() {
        let ctx = new_ctx(i);
        if !test(&ctx, &filter, &compiled, &errs) {
            continue;
        }
        if order.is_empty() {
            for k in files.list[i].props.keys() {
                if !seen_props.contains(k) && seen_props.len() < 12 {
                    seen_props.push(k.clone());
                }
            }
        }
        let keys: Vec<V> = sort.iter().map(|(id, _)| ctx.column(id).unwrap_or(V::Null)).collect();
        let g = group.as_ref().map(|(id, _)| ctx.column(id).unwrap_or(V::Null)).unwrap_or(V::Null);
        hits.push((i, keys, g));
    }
    let columns_ids: Vec<String> = if order.is_empty() {
        let mut c = vec!["file.name".to_string()];
        c.extend(seen_props.iter().filter(|k| !matches!(k.as_str(), "tags" | "aliases" | "cssclasses")).map(|k| format!("note.{k}")));
        c
    } else {
        order.clone()
    };
    let cmp_ctx = new_ctx(this_i.unwrap_or(0).min(files.list.len().saturating_sub(1)));
    let cmp = |a: &V, b: &V| if files.list.is_empty() { Ordering::Equal } else { cmp_ctx.compare(a, b) };
    hits.sort_by(|a, b| {
        if let Some((_, desc)) = &group {
            let o = cmp(&a.2, &b.2);
            let o = if *desc { o.reverse() } else { o };
            if o != Ordering::Equal {
                return o;
            }
        }
        for (k, (_, desc)) in sort.iter().enumerate() {
            let (x, y) = (&a.1[k], &b.1[k]);
            // Empty values last, whatever the direction.
            let o = match (matches!(x, V::Null), matches!(y, V::Null)) {
                (true, false) => return Ordering::Greater,
                (false, true) => return Ordering::Less,
                _ => cmp(x, y),
            };
            let o = if *desc { o.reverse() } else { o };
            if o != Ordering::Equal {
                return o;
            }
        }
        if sort.is_empty() {
            natural(&files.list[a.0].path, &files.list[b.0].path)
        } else {
            Ordering::Equal
        }
    });
    let total = hits.len();
    if let Some(l) = limit {
        hits.truncate(l);
    }
    let mut out: Vec<Hit> = vec![];
    for (i, keys, g) in hits {
        let ctx = new_ctx(i);
        let cells = columns_ids
            .iter()
            .map(|id| match ctx.column(id) {
                Ok(v) => cell_json(&ctx, id, &v),
                Err(e) => {
                    let mut errs = errs.borrow_mut();
                    let msg = format!("{id}: {e}");
                    if errs.len() < 20 && !errs.contains(&msg) {
                        errs.push(msg);
                    }
                    json!({ "error": e })
                }
            })
            .collect();
        let img = image.as_ref().map(|id| to_json(&ctx, &ctx.column(id).unwrap_or(V::Null)));
        let gs = ctx.to_string(&g);
        out.push(Hit { file: i, sort: keys, group: g, cells, image: img, gs });
    }
    errors.extend(errs.into_inner());
    let mut groups: Vec<String> = vec![];
    if group.is_some() {
        for h in &out {
            if !groups.contains(&h.gs) {
                groups.push(h.gs.clone());
            }
        }
        // Board columns listed by the view (so an empty column still shows).
        if let Some(Json::Array(extra)) = vspec.get("groups") {
            for g in extra.iter().filter_map(|x| x.as_str()) {
                if !groups.iter().any(|x| x == g) {
                    groups.push(g.to_string());
                }
            }
        }
    }
    let columns = columns_ids
        .iter()
        .map(|id| Column {
            id: id.clone(),
            name: sp.names.get(id).cloned().unwrap_or_else(|| default_name(id)),
            editable: id.starts_with("note."),
        })
        .collect();
    let ctx0 = new_ctx(0);
    let rows = out
        .into_iter()
        .map(|h| {
            let _ = &h.sort;
            Row {
                path: files.list[h.file].path.clone(),
                cells: h.cells,
                group: group.as_ref().map(|_| h.gs.clone()),
                group_value: group.as_ref().map(|_| if files.list.is_empty() { Json::Null } else { to_json(&ctx0, &h.group) }),
                image: h.image,
                lines: vec![],
            }
        })
        .collect();
    Ok(BaseResult {
        views,
        view: vi,
        kind,
        columns,
        rows,
        total,
        group_by: group.map(|g| g.0),
        groups,
        errors,
        options: Json::Object(vspec.clone()),
    })
}

/// The values a property takes in the vault (for completion / board columns).
pub fn property_values(idx: &Index, name: &str, exclude: &[String]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for (_, d) in idx.iter(exclude) {
        let Some(v) = d.meta.props.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v) else { continue };
        let mut add = |s: String| {
            if !s.is_empty() && !out.contains(&s) {
                out.push(s);
            }
        };
        match v {
            Json::Array(a) => a.iter().filter_map(|x| x.as_str().map(String::from).or_else(|| x.as_number().map(|n| n.to_string()))).for_each(&mut add),
            Json::String(s) => add(s.clone()),
            Json::Number(n) => add(n.to_string()),
            Json::Bool(b) => add(b.to_string()),
            _ => {}
        }
    }
    out.sort_by(|a, b| natural(a, b));
    out
}

/// Every property name used in the vault, most used first.
pub fn property_names(idx: &Index, exclude: &[String]) -> Vec<String> {
    let mut count: HashMap<String, usize> = HashMap::new();
    for (_, d) in idx.iter(exclude) {
        for k in d.meta.props.keys() {
            *count.entry(k.clone()).or_default() += 1;
        }
    }
    let mut v: Vec<(String, usize)> = count.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(natural(&a.0, &b.0)));
    v.into_iter().map(|(k, _)| k).collect()
}

/// Evaluate one expression for one note (the formula editor's preview).
pub fn eval_for(idx: &Index, root: &Path, expr: &str, path: &str) -> Result<Json, String> {
    let files = Files::new(idx, root, &[]);
    let i = files.find(path).ok_or("no such note")?;
    let e = parse(expr)?;
    let formulas = BTreeMap::new();
    let ctx = Ctx::new(&files, i, Some(i), &formulas, Local::now().naive_local());
    let v = ctx.eval(&e)?;
    Ok(to_json(&ctx, &v))
}

/// A ```` ```query ```` block: a search (the search box's syntax) plus
/// option lines:
///
/// ```text
/// tag:book -status:done "some phrase"
/// view: list | table | lines | tasks | count
/// columns: status, rating, file.mtime
/// sort: rating desc        (name, path, modified, created or a property)
/// limit: 20
/// ```
pub fn query_block(idx: &Index, root: &Path, src: &str, this: Option<&str>, exclude: &[String]) -> Result<BaseResult, String> {
    let mut q = String::new();
    let (mut view, mut columns, mut sort, mut limit, mut group) = (None::<String>, vec![], None::<(String, bool)>, None::<usize>, None::<String>);
    let opt = Regex::new(r"^\s*(view|columns|sort|limit|group|show)\s*:\s*(.*)$").unwrap();
    for line in src.lines() {
        if let Some(c) = opt.captures(line) {
            let v = c[2].trim();
            match &c[1] {
                "view" | "show" => view = Some(v.to_lowercase()),
                "columns" => columns = v.split(',').map(|x| x.trim()).filter(|x| !x.is_empty()).map(|x| column_alias(x)).collect(),
                "sort" => {
                    let mut it = v.split_whitespace();
                    if let Some(k) = it.next() {
                        sort = Some((column_alias(k), it.next().is_some_and(|d| d.eq_ignore_ascii_case("desc"))));
                    }
                }
                "limit" => limit = v.parse().ok(),
                "group" => group = Some(column_alias(v)),
                _ => {}
            }
        } else if !line.trim().is_empty() {
            q.push_str(line.trim());
            q.push(' ');
        }
    }
    let parsed = crate::query::Query::parse(&q)?;
    if parsed.is_empty() {
        return Err("Write a search on the first line, e.g. tag:book or \"a phrase\".".into());
    }
    let hits = crate::query::search(idx, &q, 5000, exclude)?;
    let line_level = hits.iter().any(|h| h.line > 0);
    let view = view.unwrap_or_else(|| if line_level { "lines".into() } else { "list".into() });
    let mut by_note: Vec<(String, Vec<(usize, String)>)> = vec![];
    for h in hits {
        if this.is_some_and(|t| t == h.path) && line_level {
            continue; // the query's own text matches itself
        }
        match by_note.last_mut() {
            Some((p, l)) if *p == h.path => {
                if h.line > 0 {
                    l.push((h.line, h.snippet));
                }
            }
            _ => by_note.push((h.path.clone(), if h.line > 0 { vec![(h.line, h.snippet)] } else { vec![] })),
        }
    }
    let files = Files::new(idx, root, exclude);
    let formulas = BTreeMap::new();
    let now = Local::now().naive_local();
    let this_i = this.and_then(|t| files.find(t));
    let ctx_for = |i: usize| Ctx::new(&files, i, this_i, &formulas, now);
    let mut col_ids = vec!["file.basename".to_string()];
    col_ids.extend(columns.iter().cloned());
    let mut rows: Vec<(usize, Vec<(usize, String)>, V, V)> = by_note
        .into_iter()
        .filter_map(|(p, lines)| {
            let i = files.find(&p)?;
            let ctx = ctx_for(i);
            let key = sort.as_ref().map(|(id, _)| ctx.column(id).unwrap_or(V::Null)).unwrap_or(V::Null);
            let g = group.as_ref().map(|id| ctx.column(id).unwrap_or(V::Null)).unwrap_or(V::Null);
            Some((i, lines, key, g))
        })
        .collect();
    if !files.list.is_empty() {
        let c = ctx_for(0);
        rows.sort_by(|a, b| {
            let g = c.compare(&a.3, &b.3);
            if g != Ordering::Equal {
                return g;
            }
            match &sort {
                Some((_, desc)) => {
                    let o = c.compare(&a.2, &b.2);
                    if *desc && !matches!(a.2, V::Null) && !matches!(b.2, V::Null) { o.reverse() } else { o }
                }
                None => natural(&files.list[a.0].path, &files.list[b.0].path),
            }
        });
    }
    let total = rows.len();
    if let Some(l) = limit {
        rows.truncate(l);
    }
    let mut groups = vec![];
    let out_rows = rows
        .into_iter()
        .map(|(i, lines, _, g)| {
            let ctx = ctx_for(i);
            let gs = group.as_ref().map(|_| ctx.to_string(&g));
            if let Some(gs) = &gs {
                if !groups.contains(gs) {
                    groups.push(gs.clone());
                }
            }
            Row {
                path: files.list[i].path.clone(),
                cells: col_ids.iter().map(|id| ctx.column(id).map(|v| cell_json(&ctx, id, &v)).unwrap_or_else(|e| json!({ "error": e }))).collect(),
                group: gs,
                group_value: None,
                image: None,
                lines,
            }
        })
        .collect();
    Ok(BaseResult {
        views: vec![ViewInfo { name: view.clone(), kind: view.clone() }],
        view: 0,
        kind: view,
        columns: col_ids.iter().map(|id| Column { id: id.clone(), name: default_name(id), editable: id.starts_with("note.") }).collect(),
        rows: out_rows,
        total,
        group_by: group,
        groups,
        errors: vec![],
        options: Json::Null,
    })
}

/// A cell as plain text (PDF).
fn cell_text(v: &Json) -> String {
    match v {
        Json::Null => String::new(),
        Json::Bool(b) => if *b { "✓".into() } else { "✗".into() },
        Json::Number(n) => n.as_f64().map(num_str).unwrap_or_else(|| n.to_string()),
        Json::String(s) => s.clone(),
        Json::Array(a) => a.iter().map(cell_text).collect::<Vec<_>>().join(", "),
        Json::Object(o) => {
            for k in ["text", "date", "duration", "error"] {
                if let Some(Json::String(s)) = o.get(k) {
                    return s.clone();
                }
            }
            String::new()
        }
    }
}

/// A matched line for the PDF: list markers dropped, tasks as ☐ / ☑.
fn line_typst(t: &str) -> String {
    use crate::render::escape_markup as esc;
    let task = regex::Regex::new(r"^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s*").unwrap();
    if let Some(c) = task.captures(t) {
        let mark = if &c[1] == " " { "☐" } else { "☑" };
        return format!("{mark} {}", esc(&t[c.get(0).unwrap().end()..]));
    }
    let item = regex::Regex::new(r"^\s*(?:[-*+]|\d+[.)])\s+").unwrap();
    esc(item.replace(t, "").trim())
}

/// The result as Typst, for the PDF: a table (table, cards and board views),
/// a list, matching lines, or a count.
pub fn to_typst(r: &BaseResult) -> String {
    use crate::render::escape_markup as esc;
    let mut out = String::new();
    let n = r.columns.len().max(1);
    if !r.errors.is_empty() && r.rows.is_empty() {
        return format!("#block(fill: rgb(\"#fdecec\"), inset: 8pt, radius: 4pt, width: 100%)[#text(fill: rgb(\"#a33\"))[{}]]", esc(&r.errors.join("; ")));
    }
    match r.kind.as_str() {
        "count" => return format!("{}", r.total),
        "list" => {
            for row in &r.rows {
                let first = row.cells.first().map(cell_text).unwrap_or_default();
                let rest: Vec<String> = row.cells.iter().skip(1).map(cell_text).filter(|s| !s.is_empty()).collect();
                out.push_str(&format!("- {}{}\n", esc(&first), if rest.is_empty() { String::new() } else { format!(" — {}", esc(&rest.join(" · "))) }));
            }
        }
        "lines" | "tasks" => {
            for row in &r.rows {
                out.push_str(&format!("*{}*\n", esc(&cell_text(&row.cells[0]))));
                for (_, t) in &row.lines {
                    out.push_str(&format!("- {}\n", line_typst(t)));
                }
                out.push('\n');
            }
        }
        _ => {
            let mut cells = vec![];
            for c in &r.columns {
                cells.push(format!("[*{}*]", esc(&c.name)));
            }
            let mut last_group: Option<&String> = None;
            for row in &r.rows {
                if let Some(g) = &row.group {
                    if last_group != Some(g) {
                        cells.push(format!("table.cell(colspan: {n}, fill: luma(240))[*{}*]", esc(if g.is_empty() { "—" } else { g })));
                        last_group = Some(g);
                    }
                }
                for v in &row.cells {
                    cells.push(format!("[{}]", esc(&cell_text(v))));
                }
            }
            out.push_str(&format!(
                "#table(columns: {n}, stroke: 0.5pt + luma(190), inset: 5pt, align: start, table.header({}), {})\n",
                cells[..r.columns.len()].join(", "),
                cells[r.columns.len()..].join(", ")
            ));
        }
    }
    if r.rows.is_empty() {
        out = "#text(fill: luma(120))[No results.]\n".into();
    }
    if r.total > r.rows.len() && r.kind != "count" {
        out.push_str(&format!("\n#text(size: 0.85em, fill: luma(120))[{} of {}]\n", r.rows.len(), r.total));
    }
    out
}

/// `modified` → `file.mtime`, `name` → `file.basename`, `status` → `note.status`.
fn column_alias(k: &str) -> String {
    match k.trim().to_lowercase().as_str() {
        "name" | "file" | "title" => "file.basename".into(),
        "path" => "file.path".into(),
        "folder" => "file.folder".into(),
        "modified" | "mtime" => "file.mtime".into(),
        "created" | "ctime" => "file.ctime".into(),
        "size" => "file.size".into(),
        "tags" => "file.tags".into(),
        _ => normalize_id(k),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (tempdir::Dir, Index) {
        let d = tempdir::Dir::new();
        let w = |p: &str, t: &str| {
            let f = d.0.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, t).unwrap();
        };
        w("Books/Dune.md", "---\ntags: [book, scifi]\nstatus: reading\nrating: 5\npages: 600\nprice: 12\nstarted: 2026-10-01\nauthor: \"[[Frank Herbert]]\"\n---\n# Dune\nSee [[Foundation]].\n");
        w("Books/Foundation.md", "---\ntags: [book]\nstatus: done\nrating: 4\npages: 250\nprice: 10\nstarted: 2026-09-15\n---\nLinks to [[Dune]] and ![[cover.png]].\n");
        w("Books/Notes on reading.md", "Just a #book note without properties.\n");
        w("Frank Herbert.md", "# Frank Herbert\n");
        w("Ideas.md", "---\nstatus: todo\n---\n#idea about [[Dune]]\n");
        w("Books/cover.png", "png");
        let idx = Index::build(&d.0);
        (d, idx)
    }

    mod tempdir {
        pub struct Dir(pub std::path::PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let p = std::env::temp_dir().join(format!("notez-bases-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
                std::fs::create_dir_all(&p).unwrap();
                Dir(p)
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    fn q(src: &str) -> BaseResult {
        let (d, idx) = vault();
        let r = query(&idx, &d.0, src, None, Some("Ideas.md"), &[]).unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        r
    }
    fn paths(r: &BaseResult) -> Vec<&str> {
        r.rows.iter().map(|r| r.path.as_str()).collect()
    }

    #[test]
    fn filters_sort_and_formulas() {
        let r = q(r#"
filters:
  and:
    - file.hasTag("book")
    - file.ext == "md"
formulas:
  per_page: (price / pages * 100).toFixed(2)
  age: (today() - started).days > 30
views:
  - type: table
    name: Books
    order: [file.name, status, formula.per_page, rating]
    sort:
      - property: rating
        direction: DESC
"#);
        assert_eq!(paths(&r), ["Books/Dune.md", "Books/Foundation.md", "Books/Notes on reading.md"]);
        assert_eq!(r.columns.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["file.name", "note.status", "formula.per_page", "note.rating"]);
        assert_eq!(r.rows[0].cells[2], json!("2.00"));
        assert_eq!(r.rows[1].cells[2], json!("4.00"));
        assert_eq!(r.rows[2].cells[3], Json::Null);
        assert!(r.columns[1].editable && !r.columns[2].editable);
    }

    #[test]
    fn or_not_folders_links_this() {
        let r = q("filters:\n  or:\n    - file.inFolder(\"Books\") && status == \"done\"\n    - file.name == \"Ideas.md\"\n");
        assert_eq!(paths(&r), ["Books/Foundation.md", "Ideas.md"]);
        let r = q("filters:\n  not:\n    - file.inFolder(\"Books\")\n    - file.ext != \"md\"\n");
        assert_eq!(paths(&r), ["Frank Herbert.md", "Ideas.md"]);
        // Notes linking to the note showing the base, and links as values.
        let r = q("filters: 'file.hasLink(\"Dune\")'\n");
        assert_eq!(paths(&r), ["Books/Foundation.md", "Ideas.md"]);
        let r = q("filters: 'this.file.links.contains(file)'\n");
        assert_eq!(paths(&r), ["Books/Dune.md"]);
        let r = q("filters: 'author == link(\"Frank Herbert\")'\nviews:\n  - type: table\n    order: [author, file.backlinks]\n");
        assert_eq!(paths(&r), ["Books/Dune.md"]);
        assert_eq!(r.rows[0].cells[0]["link"], json!("Frank Herbert.md"));
        assert_eq!(r.rows[0].cells[1].as_array().unwrap().len(), 2);
    }

    #[test]
    fn grouping_limit_dates() {
        let r = q("filters: file.hasTag(\"book\")\nviews:\n  - type: board\n    groupBy: { property: status, direction: ASC }\n    limit: 2\n    order: [file.basename, started]\n");
        assert_eq!(r.total, 3);
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.groups, ["done", "reading"]);
        assert_eq!(r.rows[0].cells[1], json!({ "date": "2026-09-15" }));
        let r = q("filters: 'started > date(\"2026-09-20\") || started.format(\"MMM YYYY\") == \"Sep 2026\"'\n");
        assert_eq!(paths(&r), ["Books/Dune.md", "Books/Foundation.md"]);
        let r = q("filters: '(started + \"1M\").month == 11'\n");
        assert_eq!(paths(&r), ["Books/Dune.md"]);
    }

    #[test]
    fn expressions() {
        let (d, idx) = vault();
        let ev = |e: &str| eval_for(&idx, &d.0, e, "Books/Dune.md").unwrap();
        assert_eq!(ev("1 + 2 * 3"), json!(7.0));
        assert_eq!(ev("\"a\" + 1"), json!("a1"));
        assert_eq!(ev("file.tags"), json!(["#book", "#scifi"]));
        assert_eq!(ev("file.tags.map(value.upper()).join(\"|\")"), json!("#BOOK|#SCIFI"));
        assert_eq!(ev("[3, 1, 2].sort().reverse()"), json!([3.0, 2.0, 1.0]));
        assert_eq!(ev("[1, 2, 3, 4].filter(value % 2 == 0).length"), json!(2.0));
        assert_eq!(ev("if(rating >= 5, \"great\", \"ok\")"), json!("great"));
        assert_eq!(ev("rating > 4 ? \"great\" : \"ok\""), json!("great"));
        assert_eq!(ev("note[\"pages\"] / 2"), json!(300.0));
        assert_eq!(ev("/dun/i.matches(file.basename)"), json!(true));
        assert_eq!(ev("\"a,b\".split(\",\").length"), json!(2.0));
        assert_eq!(ev("missing.isEmpty()"), json!(true));
        assert_eq!(ev("date(\"2026-01-31\") + \"1M\""), json!({ "date": "2026-02-28" }));
        assert_eq!(ev("(date(\"2026-01-03\") - date(\"2026-01-01\")).days"), json!(2.0));
        assert_eq!(ev("date(\"2026-03-04 05:06\").format(\"DD/MM/YY HH:mm [at] dddd\")"), json!("04/03/26 05:06 at Wednesday"));
        assert_eq!(ev("max(1, 5, 3) + min([4, 2])"), json!(7.0));
        assert_eq!(ev("file.backlinks.length"), json!(2.0));
        assert_eq!(ev("file.links[1].asFile().status"), json!("done"));
        assert_eq!(ev("12.345.round(1)"), json!(12.3));
        assert!(eval_for(&idx, &d.0, "1 +", "Books/Dune.md").is_err());
        assert!(eval_for(&idx, &d.0, "nosuch()", "Books/Dune.md").is_err());
    }

    #[test]
    fn formula_cycles_and_errors_are_reported() {
        let (d, idx) = vault();
        let r = query(&idx, &d.0, "filters: file.name == \"Ideas.md\"\nformulas:\n  a: formula.b + 1\n  b: formula.a\nviews:\n  - type: table\n    order: [formula.a]\n", None, None, &[]).unwrap();
        assert_eq!(r.rows.len(), 1);
        assert!(r.errors.iter().any(|e| e.contains("refers to itself")), "{:?}", r.errors);
        assert!(query(&idx, &d.0, "filters: [", None, None, &[]).is_err());
    }

    #[test]
    fn query_blocks() {
        let (d, idx) = vault();
        let r = query_block(&idx, &d.0, "tag:book\nsort: rating desc\ncolumns: status, rating\n", None, &[]).unwrap();
        assert_eq!(r.kind, "list");
        assert_eq!(paths(&r), ["Books/Dune.md", "Books/Foundation.md", "Books/Notes on reading.md"]);
        assert_eq!(r.columns.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["file.basename", "note.status", "note.rating"]);
        assert_eq!(r.rows[0].cells[2], json!(5.0));
        let r = query_block(&idx, &d.0, "\"Dune\" -tag:book\nlimit: 5", Some("x.md"), &[]).unwrap();
        assert_eq!(r.kind, "lines");
        assert_eq!(paths(&r), ["Ideas.md"]);
        assert_eq!(r.rows[0].lines.len(), 1);
        assert!(query_block(&idx, &d.0, "limit: 3", None, &[]).is_err());
    }

    #[test]
    fn task_lines_in_pdf() {
        assert_eq!(line_typst("- [ ] buy milk"), "☐ buy milk");
        assert_eq!(line_typst("  * [x] done"), "☑ done");
        assert_eq!(line_typst("1. first"), "first");
    }

    #[test]
    fn natural_order() {
        assert_eq!(natural("note 2", "Note 10"), Ordering::Less);
        assert_eq!(parse_duration("1d 2h"), Some(93_600_000));
        assert_eq!(parse_duration("2 weeks"), Some(1_209_600_000));
        assert_eq!(parse_duration("x"), None);
    }
}
