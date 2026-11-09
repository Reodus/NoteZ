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

// ================================================================ parser

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Num(f64),
    Str(String),
    Ident(String),
    Op(&'static str),
    Regex(String, String),
}

fn lex(src: &str) -> Result<Vec<Tok>, String> {
    let cs: Vec<char> = src.chars().collect();
    let mut out = vec![];
    let mut i = 0;
    const OPS: [&str; 22] = ["==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "<", ">", "!", "(", ")", "[", "]", ",", ".", "?", ":"];
    while i < cs.len() {
        let c = cs[i];
        if c.is_whitespace() {
            i += 1;
        } else if c.is_ascii_digit() || (c == '.' && cs.get(i + 1).is_some_and(|d| d.is_ascii_digit())) {
            let start = i;
            let mut dot = false;
            while i < cs.len() && (cs[i].is_ascii_digit() || cs[i] == '_' || (cs[i] == '.' && !dot && cs.get(i + 1).is_some_and(|d| d.is_ascii_digit()))) {
                dot |= cs[i] == '.';
                i += 1;
            }
            let s: String = cs[start..i].iter().filter(|&&c| c != '_').collect();
            out.push(Tok::Num(s.parse().map_err(|_| format!("bad number {s}"))?));
        } else if c == '"' || c == '\'' || c == '`' {
            let mut s = String::new();
            i += 1;
            while i < cs.len() && cs[i] != c {
                if cs[i] == '\\' && i + 1 < cs.len() {
                    i += 1;
                    s.push(match cs[i] {
                        'n' => '\n',
                        't' => '\t',
                        x => x,
                    });
                } else {
                    s.push(cs[i]);
                }
                i += 1;
            }
            if i >= cs.len() {
                return Err("unclosed string".into());
            }
            i += 1;
            out.push(Tok::Str(s));
        } else if c == '/' && !matches!(out.last(), Some(Tok::Num(_) | Tok::Str(_) | Tok::Ident(_) | Tok::Op(")" | "]"))) {
            // A regular expression literal: /pattern/flags.
            let mut s = String::new();
            i += 1;
            while i < cs.len() && cs[i] != '/' {
                if cs[i] == '\\' && i + 1 < cs.len() {
                    s.push('\\');
                    i += 1;
                }
                s.push(cs[i]);
                i += 1;
            }
            if i >= cs.len() {
                return Err("unclosed regular expression".into());
            }
            i += 1;
            let start = i;
            while i < cs.len() && cs[i].is_ascii_alphabetic() {
                i += 1;
            }
            out.push(Tok::Regex(s, cs[start..i].iter().collect()));
        } else if c.is_alphabetic() || c == '_' || c == '$' {
            let start = i;
            while i < cs.len() && (cs[i].is_alphanumeric() || cs[i] == '_' || cs[i] == '$' || cs[i] == '-' && cs.get(i + 1).is_some_and(|n| n.is_alphabetic())) {
                i += 1;
            }
            let w: String = cs[start..i].iter().collect();
            match w.as_str() {
                "and" => out.push(Tok::Op("&&")),
                "or" => out.push(Tok::Op("||")),
                "not" => out.push(Tok::Op("!")),
                _ => out.push(Tok::Ident(w)),
            }
        } else {
            let rest: String = cs[i..cs.len().min(i + 2)].iter().collect();
            let op = OPS.iter().find(|o| rest.starts_with(**o)).ok_or_else(|| format!("unexpected “{c}”"))?;
            // `=` alone means `==` (a common slip).
            out.push(Tok::Op(op));
            i += op.chars().count();
        }
        if i < cs.len() && cs[i] == '=' && !matches!(out.last(), Some(Tok::Op("==" | "!=" | "<=" | ">="))) && cs.get(i + 1) != Some(&'=') {
            out.push(Tok::Op("=="));
            i += 1;
        }
    }
    Ok(out)
}

#[derive(Clone, Debug)]
enum E {
    Lit(V),
    Ident(String),
    Member(Box<E>, String),
    Index(Box<E>, Box<E>),
    Call(Box<E>, Vec<E>),
    Unary(&'static str, Box<E>),
    Bin(&'static str, Box<E>, Box<E>),
    Cond(Box<E>, Box<E>, Box<E>),
}

struct Parser {
    toks: Vec<Tok>,
    i: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.i)
    }
    fn eat(&mut self, op: &str) -> bool {
        if matches!(self.peek(), Some(Tok::Op(o)) if *o == op) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn expect(&mut self, op: &str) -> Result<(), String> {
        if self.eat(op) { Ok(()) } else { Err(format!("expected “{op}”")) }
    }
    fn expr(&mut self) -> Result<E, String> {
        let c = self.bin(0)?;
        if self.eat("?") {
            let a = self.expr()?;
            self.expect(":")?;
            let b = self.expr()?;
            return Ok(E::Cond(Box::new(c), Box::new(a), Box::new(b)));
        }
        Ok(c)
    }
    fn prec(op: &str) -> Option<u8> {
        Some(match op {
            "||" => 1,
            "&&" => 2,
            "==" | "!=" => 3,
            "<" | "<=" | ">" | ">=" => 4,
            "+" | "-" => 5,
            "*" | "/" | "%" => 6,
            _ => return None,
        })
    }
    fn bin(&mut self, min: u8) -> Result<E, String> {
        let mut lhs = self.unary()?;
        loop {
            let Some(Tok::Op(op)) = self.peek().cloned() else { break };
            let Some(p) = Self::prec(op) else { break };
            if p <= min {
                break;
            }
            self.i += 1;
            let rhs = self.bin(p)?;
            lhs = E::Bin(op, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }
    fn unary(&mut self) -> Result<E, String> {
        if self.eat("!") {
            return Ok(E::Unary("!", Box::new(self.unary()?)));
        }
        if self.eat("-") {
            return Ok(E::Unary("-", Box::new(self.unary()?)));
        }
        if self.eat("+") {
            return self.unary();
        }
        self.postfix()
    }
    fn postfix(&mut self) -> Result<E, String> {
        let mut e = self.primary()?;
        loop {
            if self.eat(".") {
                match self.peek().cloned() {
                    Some(Tok::Ident(n)) => {
                        self.i += 1;
                        e = E::Member(Box::new(e), n);
                    }
                    _ => return Err("expected a name after “.”".into()),
                }
            } else if self.eat("[") {
                let idx = self.expr()?;
                self.expect("]")?;
                e = E::Index(Box::new(e), Box::new(idx));
            } else if self.eat("(") {
                let mut args = vec![];
                if !self.eat(")") {
                    loop {
                        args.push(self.expr()?);
                        if self.eat(")") {
                            break;
                        }
                        self.expect(",")?;
                    }
                }
                e = E::Call(Box::new(e), args);
            } else {
                break;
            }
        }
        Ok(e)
    }
    fn primary(&mut self) -> Result<E, String> {
        let t = self.peek().cloned().ok_or("unexpected end of expression")?;
        self.i += 1;
        Ok(match t {
            Tok::Num(n) => E::Lit(V::Num(n)),
            Tok::Str(s) => E::Lit(V::Str(s)),
            Tok::Regex(p, f) => {
                let pat = if f.contains('i') { format!("(?i){p}") } else { p };
                E::Lit(V::Regex(Regex::new(&pat).map_err(|e| e.to_string())?))
            }
            Tok::Ident(w) => match w.as_str() {
                "true" => E::Lit(V::Bool(true)),
                "false" => E::Lit(V::Bool(false)),
                "null" => E::Lit(V::Null),
                _ => E::Ident(w),
            },
            Tok::Op("(") => {
                let e = self.expr()?;
                self.expect(")")?;
                e
            }
            Tok::Op("[") => {
                let mut items = vec![];
                if !self.eat("]") {
                    loop {
                        items.push(self.expr()?);
                        if self.eat("]") {
                            break;
                        }
                        self.expect(",")?;
                    }
                }
                E::Call(Box::new(E::Ident("list".into())), items)
            }
            Tok::Op(o) => return Err(format!("unexpected “{o}”")),
        })
    }
}

fn parse(src: &str) -> Result<E, String> {
    let mut p = Parser { toks: lex(src)?, i: 0 };
    let e = p.expr()?;
    if p.i < p.toks.len() {
        return Err(format!("unexpected text after the expression: {:?}", p.toks[p.i]));
    }
    Ok(e)
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

// ================================================================ evaluation

struct Ctx<'a, 'b> {
    files: &'b Files<'a>,
    file: usize,
    this: Option<usize>,
    formulas: &'b BTreeMap<String, Result<E, String>>,
    cache: RefCell<HashMap<String, V>>,
    depth: std::cell::Cell<u32>,
    now: NaiveDateTime,
    /// `value` / `index` inside list.filter()/map().
    locals: RefCell<Vec<(String, V)>>,
}

type R = Result<V, String>;

fn want_num(v: &V) -> Option<f64> {
    match v {
        V::Num(n) => Some(*n),
        V::Bool(b) => Some(*b as u8 as f64),
        V::Str(s) => s.trim().parse().ok(),
        V::Dur(ms) => Some(*ms as f64),
        V::Date(d, _) => Some(d.and_utc().timestamp_millis() as f64),
        _ => None,
    }
}

impl<'a, 'b> Ctx<'a, 'b> {
    fn f(&self) -> &FileRec {
        &self.files.list[self.file]
    }

    pub fn to_string(&self, v: &V) -> String {
        match v {
            V::Null => String::new(),
            V::Bool(b) => b.to_string(),
            V::Num(n) => num_str(*n),
            V::Str(s) => s.clone(),
            V::Date(d, t) => date_str(d, *t),
            V::Dur(ms) => dur_str(*ms),
            V::List(l) => l.iter().map(|x| self.to_string(x)).collect::<Vec<_>>().join(", "),
            V::Link { path, target, display } => display.clone().unwrap_or_else(|| path.as_deref().map(crate::links::stem_of).unwrap_or_else(|| target.clone())),
            V::File(i) => crate::links::stem_of(&self.files.list[*i].path),
            V::Obj(o) => serde_json::to_string(&o.iter().map(|(k, v)| (k.clone(), self.to_string(v))).collect::<BTreeMap<_, _>>()).unwrap_or_default(),
            V::Regex(r) => format!("/{}/", r.as_str()),
        }
    }

    fn prop(&self, file: usize, name: &str) -> V {
        let f = &self.files.list[file];
        f.props.get(name).cloned().or_else(|| f.props.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone())).unwrap_or(V::Null)
    }

    fn formula(&self, name: &str) -> R {
        if let Some(v) = self.cache.borrow().get(name) {
            return Ok(v.clone());
        }
        let e = match self.formulas.get(name) {
            Some(Ok(e)) => e,
            Some(Err(err)) => return Err(format!("formula {name}: {err}")),
            None => return Ok(V::Null),
        };
        if self.depth.get() > 32 {
            return Err(format!("formula {name} refers to itself"));
        }
        self.depth.set(self.depth.get() + 1);
        let v = self.eval(e);
        self.depth.set(self.depth.get() - 1);
        let v = v?;
        self.cache.borrow_mut().insert(name.to_string(), v.clone());
        Ok(v)
    }

    /// The value of a column id: `file.name`, `note.status`, `status`, `formula.x`.
    pub fn column(&self, id: &str) -> R {
        if let Some(n) = id.strip_prefix("formula.") {
            return self.formula(n);
        }
        if let Some(n) = id.strip_prefix("note.") {
            return Ok(self.prop(self.file, n));
        }
        if let Some(n) = id.strip_prefix("file.") {
            return self.file_member(self.file, n);
        }
        Ok(self.prop(self.file, id))
    }

    fn file_member(&self, i: usize, name: &str) -> R {
        let f = &self.files.list[i];
        let name_of = |p: &str| p.rsplit('/').next().unwrap_or(p).to_string();
        Ok(match name {
            "name" => V::Str(name_of(&f.path)),
            "basename" => V::Str(crate::links::stem_of(&f.path)),
            "path" => V::Str(f.path.clone()),
            "folder" => V::Str(f.path.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default()),
            "ext" => V::Str(name_of(&f.path).rsplit_once('.').map(|(_, e)| e.to_string()).unwrap_or_default()),
            "size" => V::Num(f.size as f64),
            "ctime" => f.ctime.map(|d| V::Date(d, true)).unwrap_or(V::Null),
            "mtime" => f.mtime.map(|d| V::Date(d, true)).unwrap_or(V::Null),
            "tags" => V::List(f.tags.iter().map(|t| V::Str(format!("#{t}"))).collect()),
            "links" | "embeds" => {
                let embeds = name == "embeds";
                let mut seen = std::collections::HashSet::new();
                V::List(
                    self.files
                        .links_of(i)
                        .iter()
                        .filter(|(_, _, e)| *e == embeds || !embeds)
                        .filter(|(p, t, _)| seen.insert(p.clone().unwrap_or_else(|| t.clone())))
                        .map(|(p, t, _)| V::Link { path: p.clone(), target: t.clone(), display: None })
                        .collect(),
                )
            }
            "backlinks" => V::List(self.files.backlinks_of(i).into_iter().map(|j| V::Link { path: Some(self.files.list[j].path.clone()), target: self.files.list[j].path.clone(), display: None }).collect()),
            "properties" => V::Obj(f.props.clone()),
            "file" => V::File(i),
            _ => return Err(format!("file.{name} is unknown")),
        })
    }

    fn lookup(&self, name: &str) -> R {
        if let Some((_, v)) = self.locals.borrow().iter().rev().find(|(n, _)| n == name) {
            return Ok(v.clone());
        }
        Ok(match name {
            "file" => V::File(self.file),
            "note" => V::Obj(self.f().props.clone()),
            "this" => match self.this {
                Some(t) => V::Obj(BTreeMap::from([("\u{0}this".to_string(), V::File(t))])),
                None => V::Null,
            },
            _ => self.prop(self.file, name),
        })
    }

    fn eval(&self, e: &E) -> R {
        match e {
            E::Lit(v) => Ok(v.clone()),
            E::Ident(n) => self.lookup(n),
            E::Member(obj, name) => {
                // formula.x, note.x, this.x
                if let E::Ident(base) = &**obj {
                    if base == "formula" && self.locals.borrow().iter().all(|(n, _)| n != "formula") {
                        return self.formula(name);
                    }
                    if base == "note" {
                        return Ok(self.prop(self.file, name));
                    }
                    if base == "this" {
                        let Some(t) = self.this else { return Ok(V::Null) };
                        return Ok(match name.as_str() {
                            "file" => V::File(t),
                            "note" => V::Obj(self.files.list[t].props.clone()),
                            _ => self.prop(t, name),
                        });
                    }
                }
                let v = self.eval(obj)?;
                self.member(&v, name)
            }
            E::Index(obj, idx) => {
                let v = self.eval(obj)?;
                let i = self.eval(idx)?;
                Ok(match (&v, &i) {
                    (V::List(l), _) => {
                        let n = want_num(&i).unwrap_or(0.0) as i64;
                        let n = if n < 0 { l.len() as i64 + n } else { n };
                        l.get(n as usize).cloned().unwrap_or(V::Null)
                    }
                    (V::Obj(o), _) => o.get(&self.to_string(&i)).cloned().unwrap_or(V::Null),
                    (V::Str(s), _) => s.chars().nth(want_num(&i).unwrap_or(0.0) as usize).map(|c| V::Str(c.to_string())).unwrap_or(V::Null),
                    (V::File(f), _) => self.prop(*f, &self.to_string(&i)),
                    _ => V::Null,
                })
            }
            E::Call(callee, args) => match &**callee {
                E::Ident(name) => self.global(name, args),
                E::Member(obj, name) => {
                    if let E::Ident(base) = &**obj {
                        if base == "this" && self.this.is_none() {
                            return Ok(V::Null);
                        }
                    }
                    let v = self.eval(obj)?;
                    self.method(&v, name, args)
                }
                _ => Err("this can't be called".into()),
            },
            E::Unary(op, x) => {
                let v = self.eval(x)?;
                Ok(match *op {
                    "!" => V::Bool(!v.truthy()),
                    _ => match v {
                        V::Dur(d) => V::Dur(-d),
                        v => V::Num(-want_num(&v).unwrap_or(f64::NAN)),
                    },
                })
            }
            E::Cond(c, a, b) => {
                if self.eval(c)?.truthy() { self.eval(a) } else { self.eval(b) }
            }
            E::Bin(op, a, b) => {
                if *op == "&&" {
                    let l = self.eval(a)?;
                    return if l.truthy() { Ok(V::Bool(self.eval(b)?.truthy())) } else { Ok(V::Bool(false)) };
                }
                if *op == "||" {
                    let l = self.eval(a)?;
                    return if l.truthy() { Ok(l) } else { self.eval(b) };
                }
                let l = self.eval(a)?;
                let r = self.eval(b)?;
                self.binary(op, l, r)
            }
        }
    }

    fn binary(&self, op: &str, l: V, r: V) -> R {
        match op {
            "==" => return Ok(V::Bool(self.equal(&l, &r))),
            "!=" => return Ok(V::Bool(!self.equal(&l, &r))),
            "<" | "<=" | ">" | ">=" => {
                if matches!(l, V::Null) || matches!(r, V::Null) {
                    return Ok(V::Bool(false));
                }
                let o = self.compare(&l, &r);
                return Ok(V::Bool(match op {
                    "<" => o == Ordering::Less,
                    "<=" => o != Ordering::Greater,
                    ">" => o == Ordering::Greater,
                    _ => o != Ordering::Less,
                }));
            }
            _ => {}
        }
        Ok(match (op, &l, &r) {
            ("+", V::Date(d, t), V::Str(s)) => shift(*d, s, 1).map(|x| V::Date(x, *t)).unwrap_or(V::Null),
            ("-", V::Date(d, t), V::Str(s)) if parse_date(s).is_none() => shift(*d, s, -1).map(|x| V::Date(x, *t)).unwrap_or(V::Null),
            ("+", V::Date(d, t), V::Dur(ms)) => V::Date(*d + Duration::milliseconds(*ms), *t),
            ("-", V::Date(d, t), V::Dur(ms)) => V::Date(*d - Duration::milliseconds(*ms), *t),
            ("-", V::Date(a, _), V::Date(b, _)) => V::Dur((*a - *b).num_milliseconds()),
            ("-", V::Date(a, _), V::Str(s)) => parse_date(s).map(|(b, _)| V::Dur((*a - b).num_milliseconds())).unwrap_or(V::Null),
            ("+", V::Dur(a), V::Dur(b)) => V::Dur(a + b),
            ("-", V::Dur(a), V::Dur(b)) => V::Dur(a - b),
            ("+", V::List(a), V::List(b)) => V::List(a.iter().chain(b).cloned().collect()),
            ("+", V::List(a), x) => V::List(a.iter().cloned().chain([x.clone()]).collect()),
            ("+", V::Str(_), _) | ("+", _, V::Str(_)) if want_num(&l).is_none() || want_num(&r).is_none() || matches!((&l, &r), (V::Str(_), V::Str(_))) => {
                V::Str(format!("{}{}", self.to_string(&l), self.to_string(&r)))
            }
            _ => {
                let (Some(a), Some(b)) = (want_num(&l), want_num(&r)) else { return Ok(V::Null) };
                if matches!(l, V::Null) || matches!(r, V::Null) {
                    return Ok(V::Null);
                }
                V::Num(match op {
                    "+" => a + b,
                    "-" => a - b,
                    "*" => a * b,
                    "/" => a / b,
                    _ => a % b,
                })
            }
        })
    }

    fn path_of(&self, v: &V) -> Option<String> {
        match v {
            V::File(i) => Some(self.files.list[*i].path.clone()),
            V::Link { path, .. } => path.clone(),
            V::Str(s) => {
                if let Some(c) = wiki_re().captures(s.trim()) {
                    return self.files.resolver.resolve(&self.f().path, &c[1]).map(|(p, _)| p);
                }
                self.files.resolver.resolve(&self.f().path, s).map(|(p, _)| p)
            }
            _ => None,
        }
    }

    fn equal(&self, a: &V, b: &V) -> bool {
        match (a, b) {
            (V::Null, x) | (x, V::Null) => x.is_empty(),
            (V::Num(x), V::Num(y)) => x == y,
            (V::Bool(x), V::Bool(y)) => x == y,
            (V::Str(x), V::Str(y)) => x == y,
            (V::Date(x, _), V::Date(y, _)) => x == y,
            (V::Date(x, t), V::Str(s)) | (V::Str(s), V::Date(x, t)) => parse_date(s).is_some_and(|(y, ty)| if *t && ty { *x == y } else { x.date() == y.date() }),
            (V::List(x), V::List(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| self.equal(a, b)),
            (V::Link { .. } | V::File(_), V::Link { .. } | V::File(_)) => self.path_of(a).is_some() && self.path_of(a) == self.path_of(b),
            (V::Link { .. } | V::File(_), V::Str(s)) | (V::Str(s), V::Link { .. } | V::File(_)) => {
                let l = if matches!(a, V::Str(_)) { b } else { a };
                self.path_of(l).is_some_and(|p| Some(p.clone()) == self.path_of(&V::Str(s.clone())) || crate::links::stem_of(&p) == *s)
            }
            (V::Num(n), V::Str(s)) | (V::Str(s), V::Num(n)) => s.trim().parse::<f64>().is_ok_and(|x| x == *n),
            (V::Bool(x), V::Str(s)) | (V::Str(s), V::Bool(x)) => s.trim().eq_ignore_ascii_case(if *x { "true" } else { "false" }),
            (V::Dur(x), V::Dur(y)) => x == y,
            _ => false,
        }
    }

    /// Sort order: numbers, dates and durations by value, text naturally
    /// (case-insensitive, numbers inside text by value); empty values last.
    fn compare(&self, a: &V, b: &V) -> Ordering {
        match (a, b) {
            (V::Null, V::Null) => Ordering::Equal,
            (V::Null, _) => Ordering::Greater,
            (_, V::Null) => Ordering::Less,
            (V::Num(x), V::Num(y)) => x.partial_cmp(y).unwrap_or(Ordering::Equal),
            (V::Date(x, _), V::Date(y, _)) => x.cmp(y),
            (V::Date(x, _), V::Str(s)) => parse_date(s).map(|(y, _)| x.cmp(&y)).unwrap_or(Ordering::Less),
            (V::Str(s), V::Date(y, _)) => parse_date(s).map(|(x, _)| x.cmp(y)).unwrap_or(Ordering::Greater),
            (V::Dur(x), V::Dur(y)) => x.cmp(y),
            (V::Bool(x), V::Bool(y)) => x.cmp(y),
            (V::Num(_), V::Str(_)) | (V::Str(_), V::Num(_)) | (V::Bool(_), _) | (_, V::Bool(_)) if want_num(a).is_some() && want_num(b).is_some() => {
                want_num(a).unwrap().partial_cmp(&want_num(b).unwrap()).unwrap_or(Ordering::Equal)
            }
            (V::List(x), V::List(y)) => {
                for (p, q) in x.iter().zip(y) {
                    let o = self.compare(p, q);
                    if o != Ordering::Equal {
                        return o;
                    }
                }
                x.len().cmp(&y.len())
            }
            _ => natural(&self.to_string(a), &self.to_string(b)),
        }
    }

    fn arg(&self, args: &[E], i: usize) -> R {
        args.get(i).map(|e| self.eval(e)).unwrap_or(Ok(V::Null))
    }

    fn global(&self, name: &str, args: &[E]) -> R {
        let a = |i| self.arg(args, i);
        Ok(match name {
            "if" => {
                if a(0)?.truthy() { a(1)? } else { a(2)? }
            }
            "now" => V::Date(self.now, true),
            "today" => V::Date(self.now.date().and_time(NaiveTime::MIN), false),
            "date" => match a(0)? {
                V::Date(d, t) => V::Date(d, t),
                V::Str(s) => parse_date(&s).map(|(d, t)| V::Date(d, t)).unwrap_or(V::Null),
                V::Num(n) => chrono::DateTime::from_timestamp_millis(n as i64).map(|d| V::Date(d.naive_utc(), true)).unwrap_or(V::Null),
                _ => V::Null,
            },
            "duration" => match a(0)? {
                V::Str(s) => parse_duration(&s).map(V::Dur).unwrap_or(V::Null),
                V::Num(n) => V::Dur(n as i64),
                v => v,
            },
            "number" => match a(0)? {
                V::Date(d, _) => V::Num(d.and_utc().timestamp_millis() as f64),
                v => want_num(&v).map(V::Num).unwrap_or(V::Null),
            },
            "string" => V::Str(self.to_string(&a(0)?)),
            "list" => {
                if args.len() == 1 {
                    match a(0)? {
                        V::List(l) => V::List(l),
                        V::Null => V::List(vec![]),
                        v => V::List(vec![v]),
                    }
                } else {
                    V::List(args.iter().map(|e| self.eval(e)).collect::<Result<_, _>>()?)
                }
            }
            "link" => {
                let target = a(0)?;
                let display = match a(1)? {
                    V::Null => None,
                    d => Some(self.to_string(&d)),
                };
                match target {
                    V::File(i) => V::Link { path: Some(self.files.list[i].path.clone()), target: self.files.list[i].path.clone(), display },
                    V::Link { path, target, .. } => V::Link { path, target, display },
                    t => {
                        let s = self.to_string(&t);
                        let s = wiki_re().captures(s.trim()).map(|c| c[1].to_string()).unwrap_or(s);
                        if s.contains("://") {
                            V::Link { path: None, target: s, display }
                        } else {
                            self.files.link(&self.f().path, &s, display)
                        }
                    }
                }
            }
            "file" => {
                let v = a(0)?;
                self.path_of(&v).and_then(|p| self.files.find(&p)).map(V::File).unwrap_or(V::Null)
            }
            "image" | "icon" | "html" | "escapeHTML" => a(0)?,
            "min" | "max" => {
                let mut vals: Vec<V> = vec![];
                for e in args {
                    match self.eval(e)? {
                        V::List(l) => vals.extend(l),
                        v => vals.push(v),
                    }
                }
                let vals: Vec<V> = vals.into_iter().filter(|v| !matches!(v, V::Null)).collect();
                let pick = vals.into_iter().reduce(|x, y| {
                    let o = self.compare(&x, &y);
                    if (name == "min") == (o == Ordering::Greater) { y } else { x }
                });
                pick.unwrap_or(V::Null)
            }
            _ => return Err(format!("unknown function {name}()")),
        })
    }

    fn member(&self, v: &V, name: &str) -> R {
        Ok(match (v, name) {
            (V::Obj(o), _) if o.contains_key("\u{0}this") => {
                let V::File(t) = o["\u{0}this"] else { return Ok(V::Null) };
                match name {
                    "file" => V::File(t),
                    "note" => V::Obj(self.files.list[t].props.clone()),
                    _ => self.prop(t, name),
                }
            }
            (V::File(i), _) => match self.file_member(*i, name) {
                Ok(v) => v,
                Err(_) => self.prop(*i, name),
            },
            (V::Link { path, .. }, _) if name != "length" => match path.as_ref().and_then(|p| self.files.find(p)) {
                Some(i) => self.file_member(i, name).unwrap_or_else(|_| self.prop(i, name)),
                None => V::Null,
            },
            (V::Str(s), "length") => V::Num(s.chars().count() as f64),
            (V::List(l), "length") => V::Num(l.len() as f64),
            (V::Date(d, _), "year") => V::Num(d.year() as f64),
            (V::Date(d, _), "month") => V::Num(d.month() as f64),
            (V::Date(d, _), "day") => V::Num(d.day() as f64),
            (V::Date(d, _), "hour") => V::Num(d.hour() as f64),
            (V::Date(d, _), "minute") => V::Num(d.minute() as f64),
            (V::Date(d, _), "second") => V::Num(d.second() as f64),
            (V::Date(d, _), "millisecond") => V::Num((d.and_utc().timestamp_subsec_millis()) as f64),
            (V::Dur(ms), "days") => V::Num(*ms as f64 / 8.64e7),
            (V::Dur(ms), "hours") => V::Num(*ms as f64 / 3.6e6),
            (V::Dur(ms), "minutes") => V::Num(*ms as f64 / 6e4),
            (V::Dur(ms), "seconds") => V::Num(*ms as f64 / 1e3),
            (V::Dur(ms), "milliseconds") => V::Num(*ms as f64),
            (V::Obj(o), _) => o.get(name).cloned().unwrap_or(V::Null),
            _ => V::Null,
        })
    }

    fn method(&self, v: &V, name: &str, args: &[E]) -> R {
        let a = |i| self.arg(args, i);
        let s_arg = |i| -> Result<String, String> { Ok(self.to_string(&self.arg(args, i)?)) };
        // Any type.
        match name {
            "isEmpty" => return Ok(V::Bool(v.is_empty())),
            "isTruthy" => return Ok(V::Bool(v.truthy())),
            "isType" => return Ok(V::Bool(v.type_name() == s_arg(0)?.to_lowercase())),
            "toString" => return Ok(V::Str(self.to_string(v))),
            _ => {}
        }
        Ok(match v {
            V::File(i) => {
                let f = &self.files.list[*i];
                match name {
                    "hasTag" => {
                        let mut want = vec![];
                        for e in args {
                            match self.eval(e)? {
                                V::List(l) => want.extend(l.iter().map(|x| self.to_string(x))),
                                x => want.push(self.to_string(&x)),
                            }
                        }
                        V::Bool(want.iter().any(|w| {
                            let w = w.trim_start_matches('#').to_lowercase();
                            f.tags.iter().any(|t| {
                                let t = t.to_lowercase();
                                t == w || t.starts_with(&format!("{w}/"))
                            })
                        }))
                    }
                    "inFolder" => {
                        let d = s_arg(0)?.trim_matches('/').to_string();
                        V::Bool(d.is_empty() || f.path.starts_with(&format!("{d}/")))
                    }
                    "hasProperty" => {
                        let p = s_arg(0)?;
                        V::Bool(f.props.keys().any(|k| k.eq_ignore_ascii_case(&p)))
                    }
                    "hasLink" | "linksTo" => {
                        let to = self.path_of(&a(0)?);
                        V::Bool(to.is_some_and(|to| self.files.links_of(*i).iter().any(|(p, _, _)| p.as_deref() == Some(&to))))
                    }
                    "asLink" => V::Link {
                        path: Some(f.path.clone()),
                        target: f.path.clone(),
                        display: match a(0)? {
                            V::Null => None,
                            d => Some(self.to_string(&d)),
                        },
                    },
                    _ => return Err(format!("file.{name}() is unknown")),
                }
            }
            V::Link { path, target, display } => match name {
                "asFile" => path.as_ref().and_then(|p| self.files.find(p)).map(V::File).unwrap_or(V::Null),
                "linksTo" => {
                    let to = self.path_of(&a(0)?);
                    let from = path.as_ref().and_then(|p| self.files.find(p));
                    V::Bool(matches!((to, from), (Some(to), Some(i)) if self.files.links_of(i).iter().any(|(p, _, _)| p.as_deref() == Some(&to))))
                }
                _ => {
                    let s = display.clone().unwrap_or_else(|| path.as_deref().map(crate::links::stem_of).unwrap_or_else(|| target.clone()));
                    return self.method(&V::Str(s), name, args);
                }
            },
            V::Str(s) => match name {
                "contains" => V::Bool(s.contains(&s_arg(0)?)),
                "containsAll" => V::Bool(args.iter().all(|e| self.eval(e).map(|x| s.contains(&self.to_string(&x))).unwrap_or(false))),
                "containsAny" => V::Bool(args.iter().any(|e| self.eval(e).map(|x| s.contains(&self.to_string(&x))).unwrap_or(false))),
                "startsWith" => V::Bool(s.starts_with(&s_arg(0)?)),
                "endsWith" => V::Bool(s.ends_with(&s_arg(0)?)),
                "lower" => V::Str(s.to_lowercase()),
                "upper" => V::Str(s.to_uppercase()),
                "title" => V::Str(s.split(' ').map(|w| {
                    let mut c = w.chars();
                    c.next().map(|f| f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase()).unwrap_or_default()
                }).collect::<Vec<_>>().join(" ")),
                "trim" => V::Str(s.trim().to_string()),
                "reverse" => V::Str(s.chars().rev().collect()),
                "repeat" => V::Str(s.repeat(want_num(&a(0)?).unwrap_or(0.0).max(0.0) as usize)),
                "slice" => {
                    let cs: Vec<char> = s.chars().collect();
                    let (st, en) = slice_bounds(cs.len(), want_num(&a(0)?), want_num(&a(1)?));
                    V::Str(cs[st..en].iter().collect())
                }
                "split" => {
                    let sep = a(0)?;
                    let parts: Vec<V> = match &sep {
                        V::Regex(r) => r.split(s).map(|x| V::Str(x.to_string())).collect(),
                        _ => {
                            let sep = self.to_string(&sep);
                            if sep.is_empty() { s.chars().map(|c| V::Str(c.to_string())).collect() } else { s.split(sep.as_str()).map(|x| V::Str(x.to_string())).collect() }
                        }
                    };
                    V::List(parts)
                }
                "replace" | "replaceAll" => {
                    let with = s_arg(1)?;
                    match a(0)? {
                        V::Regex(r) => V::Str(r.replace_all(s, with.as_str()).into_owned()),
                        p => {
                            let p = self.to_string(&p);
                            V::Str(if name == "replace" { s.replacen(&p, &with, 1) } else { s.replace(&p, &with) })
                        }
                    }
                }
                "matches" => match a(0)? {
                    V::Regex(r) => V::Bool(r.is_match(s)),
                    p => V::Bool(Regex::new(&self.to_string(&p)).map(|r| r.is_match(s)).unwrap_or(false)),
                },
                "date" | "format" | "relative" | "time" => match parse_date(s) {
                    Some((d, t)) => return self.method(&V::Date(d, t), name, args),
                    None => V::Null,
                },
                "toFixed" | "round" | "floor" | "ceil" | "abs" => match s.trim().parse::<f64>() {
                    Ok(n) => return self.method(&V::Num(n), name, args),
                    Err(_) => V::Null,
                },
                _ => return Err(format!("text has no .{name}()")),
            },
            V::Num(n) => match name {
                "abs" => V::Num(n.abs()),
                "ceil" => V::Num(n.ceil()),
                "floor" => V::Num(n.floor()),
                "round" => {
                    let d = want_num(&a(0)?).unwrap_or(0.0) as i32;
                    let f = 10f64.powi(d);
                    V::Num((n * f).round() / f)
                }
                "toFixed" => V::Str(format!("{:.*}", want_num(&a(0)?).unwrap_or(0.0).max(0.0) as usize, n)),
                _ => return Err(format!("a number has no .{name}()")),
            },
            V::Date(d, t) => match name {
                "format" => V::Str(format_date(d, &s_arg(0)?)),
                "date" => V::Date(d.date().and_time(NaiveTime::MIN), false),
                "time" => V::Str(d.format("%H:%M:%S").to_string()),
                "relative" => V::Str(relative(d, &self.now)),
                _ => {
                    let _ = t;
                    return Err(format!("a date has no .{name}()"));
                }
            },
            V::Dur(ms) => match name {
                "format" => V::Str(dur_str(*ms)),
                _ => return Err(format!("a duration has no .{name}()")),
            },
            V::List(l) => match name {
                "contains" => {
                    let x = a(0)?;
                    V::Bool(l.iter().any(|y| self.equal(y, &x)))
                }
                "containsAll" | "containsAny" => {
                    let mut want = vec![];
                    for e in args {
                        match self.eval(e)? {
                            V::List(x) => want.extend(x),
                            x => want.push(x),
                        }
                    }
                    let has = |x: &V| l.iter().any(|y| self.equal(y, x));
                    V::Bool(if name == "containsAll" { want.iter().all(has) } else { want.iter().any(has) })
                }
                "join" => V::Str(l.iter().map(|x| self.to_string(x)).collect::<Vec<_>>().join(&match a(0)? {
                    V::Null => ", ".to_string(),
                    s => self.to_string(&s),
                })),
                "reverse" => V::List(l.iter().rev().cloned().collect()),
                "sort" => {
                    let mut v = l.clone();
                    v.sort_by(|x, y| self.compare(x, y));
                    V::List(v)
                }
                "unique" => {
                    let mut out: Vec<V> = vec![];
                    for x in l {
                        if !out.iter().any(|y| self.equal(x, y)) {
                            out.push(x.clone());
                        }
                    }
                    V::List(out)
                }
                "flat" => V::List(l.iter().flat_map(|x| match x {
                    V::List(i) => i.clone(),
                    x => vec![x.clone()],
                }).collect()),
                "slice" => {
                    let (st, en) = slice_bounds(l.len(), want_num(&a(0)?), want_num(&a(1)?));
                    V::List(l[st..en].to_vec())
                }
                "filter" | "map" => {
                    let Some(body) = args.first() else { return Ok(v.clone()) };
                    let mut out = vec![];
                    for (i, x) in l.iter().enumerate() {
                        self.locals.borrow_mut().push(("value".into(), x.clone()));
                        self.locals.borrow_mut().push(("index".into(), V::Num(i as f64)));
                        let r = self.eval(body);
                        {
                            let mut l = self.locals.borrow_mut();
                            let n = l.len() - 2;
                            l.truncate(n);
                        }
                        let r = r?;
                        if name == "map" {
                            out.push(r);
                        } else if r.truthy() {
                            out.push(x.clone());
                        }
                    }
                    V::List(out)
                }
                _ => return Err(format!("a list has no .{name}()")),
            },
            V::Obj(o) => match name {
                "keys" => V::List(o.keys().filter(|k| !k.starts_with('\u{0}')).map(|k| V::Str(k.clone())).collect()),
                "values" => V::List(o.values().cloned().collect()),
                _ => return Err(format!("an object has no .{name}()")),
            },
            V::Regex(r) => match name {
                "matches" => V::Bool(r.is_match(&s_arg(0)?)),
                _ => return Err(format!("a regular expression has no .{name}()")),
            },
            V::Null => V::Null,
            V::Bool(_) => return Err(format!("a boolean has no .{name}()")),
        })
    }
}

fn slice_bounds(len: usize, a: Option<f64>, b: Option<f64>) -> (usize, usize) {
    let norm = |x: f64| -> usize {
        let x = x as i64;
        if x < 0 { (len as i64 + x).max(0) as usize } else { (x as usize).min(len) }
    };
    let s = a.map(norm).unwrap_or(0);
    let e = b.map(norm).unwrap_or(len);
    (s.min(e), e.max(s))
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

fn compile_filter(f: &Filter, out: &mut HashMap<String, Result<E, String>>) {
    match f {
        Filter::Expr(s) => {
            out.entry(s.clone()).or_insert_with(|| parse(s));
        }
        Filter::And(l) | Filter::Or(l) | Filter::Not(l) => l.iter().for_each(|x| compile_filter(x, out)),
    }
}

fn test(ctx: &Ctx, f: &Filter, compiled: &HashMap<String, Result<E, String>>, errors: &RefCell<Vec<String>>) -> bool {
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
            let path = &ctx.files.list[ctx.file].path;
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
        V::File(i) => json!({ "link": ctx.files.list[*i].path, "text": ctx.to_string(v) }),
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

    let formulas: BTreeMap<String, Result<E, String>> = sp.formulas.iter().map(|(k, v)| (k.clone(), parse(v))).collect();
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
    let new_ctx = |i: usize| Ctx {
        files,
        file: i,
        this: this_i,
        formulas: &formulas,
        cache: RefCell::new(HashMap::new()),
        depth: std::cell::Cell::new(0),
        now,
        locals: RefCell::new(vec![]),
    };
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
    let ctx = Ctx { files: &files, file: i, this: Some(i), formulas: &formulas, cache: RefCell::new(HashMap::new()), depth: std::cell::Cell::new(0), now: Local::now().naive_local(), locals: RefCell::new(vec![]) };
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
    let ctx_for = |i: usize| Ctx { files: &files, file: i, this: this_i, formulas: &formulas, cache: RefCell::new(HashMap::new()), depth: std::cell::Cell::new(0), now, locals: RefCell::new(vec![]) };
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
