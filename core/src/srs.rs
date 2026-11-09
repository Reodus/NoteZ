//! Flashcards: cards written in notes with the Obsidian Spaced Repetition
//! syntax, scheduled with FSRS-6 (a port of the reference `py-fsrs`
//! scheduler, checked against its output in the tests).
//!
//! Cards come from notes tagged `#flashcards` (`#flashcards/spanish` puts
//! them in the deck "spanish"):
//!
//! - `front::back` — one card; `front:::back` — two (each way)
//! - question lines, a `?` line, answer lines (until a blank line); `??`
//!   makes two cards
//! - `==hidden==` (or `{{c1::hidden}}`) in a paragraph — a cloze card per
//!   hidden part (per number for `{{cN::…}}`)
//!
//! Review state lives in `.notez/srs.json`, keyed by a hash of the card's
//! text, so notes are never modified. Obsidian SR's `<!--SR:!date,…-->`
//! comments are ignored, but their due date seeds a card NoteZ hasn't seen.

use crate::vault::Index;
use chrono::{Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use regex::Regex;
use std::sync::{LazyLock, Mutex};

// ------------------------------------------------------------------ FSRS-6

/// FSRS-6 default parameters (py-fsrs 6.x).
pub const W: [f64; 21] = [
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483,
    0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];
const S_MIN: f64 = 0.001;
const DAY: i64 = 86_400_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Wanted chance of remembering a card when it comes due (0.7–0.99).
    pub retention: f64,
    pub max_interval: i64,
    /// Minutes.
    pub learning_steps: Vec<f64>,
    pub relearning_steps: Vec<f64>,
    pub new_per_day: usize,
    pub fuzz: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { retention: 0.9, max_interval: 36500, learning_steps: vec![1.0, 10.0], relearning_steps: vec![10.0], new_per_day: 20, fuzz: true }
    }
}

/// 0 new, 1 learning, 2 review, 3 relearning (py-fsrs numbering; new cards
/// are "learning, step 0" there).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Sched {
    pub state: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub d: Option<f64>,
    /// Unix ms.
    pub due: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last: Option<i64>,
    pub reps: u32,
    pub lapses: u32,
}

struct Fsrs<'a> {
    w: &'a [f64; 21],
    set: &'a Settings,
}

impl Fsrs<'_> {
    fn decay(&self) -> f64 {
        -self.w[20]
    }
    fn factor(&self) -> f64 {
        0.9f64.powf(1.0 / self.decay()) - 1.0
    }
    fn retrievability(&self, c: &Sched, now: i64) -> f64 {
        let (Some(last), Some(s)) = (c.last, c.s) else { return 0.0 };
        let days = ((now - last).max(0) / DAY) as f64; // whole days, as py-fsrs
        (1.0 + self.factor() * days / s).powf(self.decay())
    }
    fn init_s(&self, g: u8) -> f64 {
        self.w[g as usize - 1].max(S_MIN)
    }
    fn init_d(&self, g: u8, clamp: bool) -> f64 {
        let d = self.w[4] - (self.w[5] * (g as f64 - 1.0)).exp() + 1.0;
        if clamp {
            d.clamp(1.0, 10.0)
        } else {
            d
        }
    }
    fn interval(&self, s: f64) -> i64 {
        let i = s / self.factor() * (self.set.retention.powf(1.0 / self.decay()) - 1.0);
        (i.round_ties_even() as i64).max(1).min(self.set.max_interval)
    }
    fn short_term_s(&self, s: f64, g: u8) -> f64 {
        let mut inc = (self.w[17] * (g as f64 - 3.0 + self.w[18])).exp() * s.powf(-self.w[19]);
        if g >= 2 {
            inc = inc.max(1.0);
        }
        (s * inc).max(S_MIN)
    }
    fn next_d(&self, d: f64, g: u8) -> f64 {
        let delta = -(self.w[6] * (g as f64 - 3.0));
        let damped = d + (10.0 - d) * delta / 9.0;
        (self.w[7] * self.init_d(4, false) + (1.0 - self.w[7]) * damped).clamp(1.0, 10.0)
    }
    fn next_s(&self, d: f64, s: f64, r: f64, g: u8) -> f64 {
        let w = self.w;
        let n = if g == 1 {
            let long = w[11] * d.powf(-w[12]) * ((s + 1.0).powf(w[13]) - 1.0) * ((1.0 - r) * w[14]).exp();
            long.min(s / (w[17] * w[18]).exp())
        } else {
            let hard = if g == 2 { w[15] } else { 1.0 };
            let easy = if g == 4 { w[16] } else { 1.0 };
            s * (1.0 + w[8].exp() * (11.0 - d) * s.powf(-w[9]) * (((1.0 - r) * w[10]).exp() - 1.0) * hard * easy)
        };
        n.max(S_MIN)
    }

    /// Fuzz (py-fsrs ranges), from a seed so a card's interval is stable
    /// while its buttons are shown.
    fn fuzz(&self, days: i64, seed: u64) -> i64 {
        if !self.set.fuzz || (days as f64) < 2.5 {
            return days;
        }
        let mut delta = 1.0;
        for (start, end, f) in [(2.5, 7.0, 0.15), (7.0, 20.0, 0.1), (20.0, f64::INFINITY, 0.05)] {
            delta += f * ((days as f64).min(end) - start).max(0.0);
        }
        let max = ((days as f64 + delta).round_ties_even() as i64).min(self.set.max_interval);
        let min = ((days as f64 - delta).round_ties_even() as i64).max(2).min(max);
        let rnd = (seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407) >> 11) as f64 / (1u64 << 53) as f64;
        // floor, not py-fsrs' round (which can land one day past `max`)
        ((rnd * (max - min + 1) as f64 + min as f64).floor() as i64).min(max)
    }

    /// The card after grade `g` (1 again, 2 hard, 3 good, 4 easy) at `now`.
    fn review(&self, c: &Sched, g: u8, now: i64, seed: u64) -> Sched {
        let mut c = c.clone();
        let mins = |m: f64| (m * 60_000.0) as i64;
        let same_day = c.last.is_some_and(|l| now - l < DAY);
        let state = if c.state == 0 { 1 } else { c.state };
        let next: i64; // ms from now
        let review_days = |c: &mut Sched| -> i64 {
            c.state = 2;
            c.step = None;
            self.fuzz(self.interval(c.s.unwrap()), seed) * DAY
        };
        match state {
            1 | 3 => {
                let steps = if state == 1 { &self.set.learning_steps } else { &self.set.relearning_steps };
                match (c.s, c.d) {
                    (Some(s), Some(d)) => {
                        c.s = Some(if same_day { self.short_term_s(s, g) } else { self.next_s(d, s, self.retrievability(&c, now), g) });
                        c.d = Some(self.next_d(d, g));
                    }
                    _ => {
                        c.s = Some(self.init_s(g));
                        c.d = Some(self.init_d(g, true));
                    }
                }
                let step = c.step.unwrap_or(0);
                if steps.is_empty() || (step >= steps.len() && g >= 2) {
                    next = review_days(&mut c);
                } else {
                    c.state = state;
                    match g {
                        1 => {
                            c.step = Some(0);
                            next = mins(steps[0]);
                        }
                        2 => {
                            c.step = Some(step);
                            next = if step == 0 && steps.len() == 1 {
                                mins(steps[0] * 1.5)
                            } else if step == 0 {
                                mins((steps[0] + steps[1]) / 2.0)
                            } else {
                                mins(steps[step])
                            };
                        }
                        3 if step + 1 < steps.len() => {
                            c.step = Some(step + 1);
                            next = mins(steps[step + 1]);
                        }
                        _ => next = review_days(&mut c),
                    }
                }
            }
            _ => {
                let (s, d) = (c.s.unwrap_or(self.init_s(3)), c.d.unwrap_or(self.init_d(3, true)));
                c.s = Some(if same_day { self.short_term_s(s, g) } else { self.next_s(d, s, self.retrievability(&c, now), g) });
                c.d = Some(self.next_d(d, g));
                if g == 1 {
                    c.lapses += 1;
                    if self.set.relearning_steps.is_empty() {
                        next = self.interval(c.s.unwrap()) * DAY;
                    } else {
                        c.state = 3;
                        c.step = Some(0);
                        next = mins(self.set.relearning_steps[0]);
                    }
                } else {
                    next = review_days(&mut c);
                }
            }
        }
        c.reps += 1;
        c.last = Some(now);
        c.due = now + next;
        c
    }
}

// ------------------------------------------------------------------ cards

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Card {
    pub id: String,
    pub path: String,
    /// 1-based line of the card's first line.
    pub line: usize,
    pub deck: String,
    /// "basic", "reversed" (the back→front card of `:::`/`??`), "cloze".
    pub kind: String,
    /// Markdown: the question, and the answer (for cloze: the paragraph with
    /// the hidden part marked).
    pub front: String,
    pub back: String,
    #[serde(skip)]
    seed_due: Option<i64>,
}

fn hash(parts: &[&str]) -> String {
    let mut h = blake3::Hasher::new();
    for p in parts {
        h.update(p.trim().as_bytes());
        h.update(&[0]);
    }
    h.finalize().to_hex()[..16].to_string()
}

/// Obsidian SR's `<!--SR:!2026-01-05,3,250-->`: removed; the due date returned.
fn strip_sr(s: &str) -> (String, Option<i64>) {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*<!--SR:([^>]*)-->").unwrap());
    let re = &*RE;
    let mut due = None;
    if let Some(c) = re.captures(s) {
        if let Some(d) = c[1].trim_start_matches('!').split(',').next().and_then(|d| NaiveDate::parse_from_str(d.trim(), "%Y-%m-%d").ok()) {
            due = Local.from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap()).single().map(|t| t.timestamp_millis());
        }
    }
    (re.replace_all(s, "").to_string(), due)
}

/// `text` with inline code blanked out (so `std::vector` isn't a card).
fn without_code(line: &str) -> String {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`+[^`]*`+").unwrap());
    let re = &*RE;
    re.replace_all(line, |c: &regex::Captures| " ".repeat(c[0].len())).to_string()
}

/// The deck of a note: `#flashcards/x/y` → "x/y"; plain `#flashcards` → the
/// note's folder (or "Default" at the vault root). None: not a card note.
pub fn deck_of(path: &str, tags: &[String]) -> Option<String> {
    let mut plain = false;
    for t in tags {
        let l = t.to_lowercase();
        if let Some(rest) = l.strip_prefix("flashcards/") {
            return Some(t[t.len() - rest.len()..].to_string());
        }
        if l == "flashcards" {
            plain = true;
        }
    }
    plain.then(|| match path.rsplit_once('/') {
        Some((dir, _)) => dir.to_string(),
        None => "Default".into(),
    })
}

/// The cards of one note.
pub fn parse(path: &str, deck: &str, text: &str) -> Vec<Card> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = vec![];
    let mut i = 0;
    // frontmatter
    if lines.first().is_some_and(|l| l.trim() == "---") {
        if let Some(end) = lines.iter().skip(1).position(|l| l.trim() == "---" || l.trim() == "...") {
            i = end + 2;
        }
    }
    let push = |out: &mut Vec<Card>, line: usize, kind: &str, front: &str, back: &str, due: Option<i64>, extra: &str| {
        let id = hash(&[kind, front, back, extra]);
        if out.iter().any(|c: &Card| c.id == id) {
            return;
        }
        out.push(Card { id, path: path.into(), line, deck: deck.into(), kind: kind.into(), front: front.trim().into(), back: back.trim().into(), seed_due: due });
    };
    static CLOZE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"==([^=\n]+?)==|\{\{c(\d+)::(.+?)(?:::([^}]*))?\}\}").unwrap());
    static ANKI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{\{c\d+::.*?\}\}").unwrap());
    let (cloze, anki) = (&*CLOZE, &*ANKI);
    while i < lines.len() {
        let l = lines[i];
        let t = l.trim();
        // fenced code and math blocks are skipped whole
        if t.starts_with("```") || t.starts_with("~~~") || t == "$$" {
            let fence: String = if t == "$$" { "$$".into() } else { t.chars().take_while(|&c| c == t.chars().next().unwrap()).collect() };
            i += 1;
            while i < lines.len() && !lines[i].trim().starts_with(fence.as_str()) {
                i += 1;
            }
            i += 1;
            continue;
        }
        if t.is_empty() || t.starts_with('#') && !t.starts_with("#flashcards") && t.chars().nth(1).is_some_and(|c| c == '#' || c == ' ') {
            i += 1;
            continue;
        }
        // a paragraph: lines up to a blank line (or a fence)
        let start = i;
        let mut j = i;
        while j < lines.len() && !lines[j].trim().is_empty() && !lines[j].trim().starts_with("```") && !lines[j].trim().starts_with("~~~") {
            j += 1;
        }
        let para: Vec<&str> = lines[start..j].to_vec();
        let mut used = false;
        // multi-line: a `?` / `??` line
        if let Some(q) = para.iter().position(|x| matches!(x.trim(), "?" | "??")) {
            if q > 0 && q + 1 < para.len() {
                let front = para[..q].join("\n");
                let (back, due) = strip_sr(&para[q + 1..].join("\n"));
                let front = drop_tag_line(&front);
                push(&mut out, start + 1, "basic", &front, &back, due, "");
                if para[q].trim() == "??" {
                    push(&mut out, start + 1, "reversed", &back, &front, None, "");
                }
                used = true;
            }
        }
        if !used {
            for (k, raw) in para.iter().enumerate() {
                let (line, due) = strip_sr(raw);
                // inline code and {{c1::…}} clozes don't separate a card
                let code_free = anki.replace_all(&without_code(&line), |c: &regex::Captures| " ".repeat(c[0].len())).to_string();
                let (sep, rev) = if let Some(p) = code_free.find(":::") {
                    (Some((p, 3)), true)
                } else {
                    (code_free.find("::").map(|p| (p, 2)), false)
                };
                if let Some((p, n)) = sep {
                    let front = line[..p].trim();
                    let back = line[p + n..].trim();
                    // `{{c1::x}}` isn't a basic card; nor are empty sides
                    if !front.is_empty() && !back.is_empty() {
                        let front = strip_list(front);
                        push(&mut out, start + k + 1, "basic", &front, back, due, "");
                        if rev {
                            push(&mut out, start + k + 1, "reversed", back, &front, None, "");
                        }
                        used = true;
                    }
                }
            }
        }
        if !used {
            let (body, due) = strip_sr(&para.join("\n"));
            let code_free = without_code(&body);
            let hits: Vec<(usize, usize, String, Option<String>)> = cloze
                .captures_iter(&code_free)
                .map(|c| {
                    let m = c.get(0).unwrap();
                    let group = c.get(2).map(|g| g.as_str().to_string());
                    (m.start(), m.end(), group.unwrap_or_default(), None)
                })
                .collect();
            if !hits.is_empty() {
                let body = drop_tag_line(&body);
                // group: ==x== each its own card; {{cN::}} by number
                let mut groups: Vec<String> = vec![];
                for (n, (_, _, g, _)) in hits.iter().enumerate() {
                    let key = if g.is_empty() { format!("h{n}") } else { format!("c{g}") };
                    if !groups.contains(&key) {
                        groups.push(key);
                    }
                }
                for key in &groups {
                    let (front, back) = cloze_sides(&body, cloze, key);
                    push(&mut out, start + 1, "cloze", &front, &back, due, key);
                }
            }
        }
        i = j.max(i + 1);
    }
    out
}

fn strip_list(s: &str) -> String {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(?:[-*+]|\d+[.)])\s+").unwrap());
    RE.replace(s, "").to_string()
}

/// A lone `#flashcards…` tag line at the start of a card isn't part of it.
fn drop_tag_line(s: &str) -> String {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(#[\w/-]+\s*)+$").unwrap());
    s.lines().filter(|l| !RE.is_match(l)).collect::<Vec<_>>().join("\n")
}

/// The question (`key`'s parts hidden as `[…]`, other parts shown) and the
/// answer (`key`'s parts as ==highlight==).
fn cloze_sides(body: &str, re: &Regex, key: &str) -> (String, String) {
    let mut n = 0;
    let mut front = String::new();
    let mut back = String::new();
    let mut last = 0;
    for c in re.captures_iter(body) {
        let m = c.get(0).unwrap();
        front.push_str(&body[last..m.start()]);
        back.push_str(&body[last..m.start()]);
        let (text, hint, k) = match c.get(1) {
            Some(h) => (h.as_str(), None, format!("h{n}")),
            None => (c.get(3).unwrap().as_str(), c.get(4).map(|h| h.as_str()), format!("c{}", &c[2])),
        };
        n += 1;
        if k == key {
            front.push_str(&format!("**[{}]**", hint.map(|h| format!("{h}…")).unwrap_or_else(|| "…".into())));
            back.push_str(&format!("=={text}=="));
        } else {
            front.push_str(text);
            back.push_str(text);
        }
        last = m.end();
    }
    front.push_str(&body[last..]);
    back.push_str(&body[last..]);
    (front, back)
}

/// Every card in the vault.
pub fn all_cards(idx: &Index, exclude: &[String]) -> Vec<Card> {
    let mut out = vec![];
    for (path, doc) in idx.iter(exclude) {
        if !path.to_lowercase().ends_with(".md") {
            continue;
        }
        if let Some(deck) = deck_of(path, &doc.meta.tags) {
            out.extend(parse(path, &deck, &doc.text));
        }
    }
    out
}

// ------------------------------------------------------------------ storage

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Store {
    pub cards: BTreeMap<String, Sched>,
    /// Reviews per day ("2026-11-09" → count).
    pub days: BTreeMap<String, u32>,
    /// New cards started per day.
    pub new_days: BTreeMap<String, u32>,
}

static LOCK: Mutex<()> = Mutex::new(());

fn store_path(root: &Path) -> PathBuf {
    root.join(".notez").join("srs.json")
}

pub fn load(root: &Path) -> Store {
    fs::read_to_string(store_path(root)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(root: &Path, s: &Store) -> Result<(), String> {
    let p = store_path(root);
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string(s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// End of today (local), for "due today".
fn end_of_day() -> i64 {
    let d = Local::now().date_naive().succ_opt().unwrap();
    Local.from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap()).single().map(|t| t.timestamp_millis()).unwrap_or(now_ms() + DAY)
}

// ------------------------------------------------------------------ API

#[derive(Serialize)]
pub struct Deck {
    pub name: String,
    pub total: usize,
    pub new: usize,
    pub learning: usize,
    pub due: usize,
}

#[derive(Serialize)]
pub struct Overview {
    pub decks: Vec<Deck>,
    pub reviewed_today: u32,
    pub new_left_today: usize,
}

fn is_due(s: &Sched, now: i64) -> bool {
    // learning steps count from now; review cards from the end of the day
    if s.state == 2 {
        s.due < end_of_day().max(now)
    } else {
        s.due <= now
    }
}

fn sched_for<'a>(st: &'a Store, c: &Card) -> Option<&'a Sched> {
    st.cards.get(&c.id)
}

pub fn overview(idx: &Index, root: &Path, exclude: &[String], set: &Settings) -> Overview {
    let st = load(root);
    let now = now_ms();
    let cards = all_cards(idx, exclude);
    let mut decks: BTreeMap<String, Deck> = BTreeMap::new();
    let new_left = set.new_per_day.saturating_sub(*st.new_days.get(&today()).unwrap_or(&0) as usize);
    for c in &cards {
        let d = decks.entry(c.deck.clone()).or_insert_with(|| Deck { name: c.deck.clone(), total: 0, new: 0, learning: 0, due: 0 });
        d.total += 1;
        match sched_for(&st, c) {
            None if c.seed_due.is_some_and(|t| t > now) => {}
            None => d.new += 1,
            Some(s) if s.state == 1 || s.state == 3 => d.learning += 1,
            Some(s) if is_due(s, now) => d.due += 1,
            _ => {}
        }
    }
    for d in decks.values_mut() {
        d.new = d.new.min(new_left);
    }
    Overview { decks: decks.into_values().collect(), reviewed_today: *st.days.get(&today()).unwrap_or(&0), new_left_today: new_left }
}

#[derive(Serialize)]
pub struct QueueCard {
    #[serde(flatten)]
    pub card: Card,
    pub state: u8,
    pub due: i64,
    /// The next interval for each grade, as text ("10m", "3d").
    pub intervals: [String; 4],
}

fn label(ms: i64) -> String {
    let m = ms as f64 / 60_000.0;
    if m < 60.0 {
        format!("{}m", m.round().max(1.0))
    } else if m < 1440.0 {
        format!("{}h", (m / 60.0).round())
    } else if m < 1440.0 * 30.0 {
        format!("{}d", (m / 1440.0).round())
    } else if m < 1440.0 * 365.0 {
        format!("{:.1}mo", m / 1440.0 / 30.0).replace(".0mo", "mo")
    } else {
        format!("{:.1}y", m / 1440.0 / 365.0).replace(".0y", "y")
    }
}

fn seed(id: &str, reps: u32) -> u64 {
    u64::from_str_radix(&id[..id.len().min(15)], 16).unwrap_or(7) ^ (reps as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
}

fn intervals(set: &Settings, s: &Sched, id: &str, now: i64) -> [String; 4] {
    let f = Fsrs { w: &W, set };
    [1u8, 2, 3, 4].map(|g| label(f.review(s, g, now, seed(id, s.reps)).due - now))
}

/// The cards to study now in `deck` (None: all): learning cards due now,
/// due reviews, new cards (up to today's limit), then learning cards due
/// within 20 minutes. Ordered by note.
pub fn queue(idx: &Index, root: &Path, deck: Option<&str>, exclude: &[String], set: &Settings) -> Vec<QueueCard> {
    let st = load(root);
    let now = now_ms();
    let mut new_left = set.new_per_day.saturating_sub(*st.new_days.get(&today()).unwrap_or(&0) as usize);
    let mut learning = vec![];
    let mut due = vec![];
    let mut fresh = vec![];
    for c in all_cards(idx, exclude) {
        if deck.is_some_and(|d| c.deck != d && !c.deck.starts_with(&format!("{d}/"))) {
            continue;
        }
        match st.cards.get(&c.id).cloned() {
            Some(s) if (s.state == 1 || s.state == 3) && s.due <= now + 20 * 60_000 => learning.push((c, s)),
            Some(s) if s.state == 2 && is_due(&s, now) => due.push((c, s)),
            Some(_) => {}
            None if c.seed_due.is_some_and(|t| t > now) => {}
            None if new_left > 0 => {
                new_left -= 1;
                fresh.push((c, Sched::default()));
            }
            None => {}
        }
    }
    learning.sort_by_key(|(_, s)| s.due);
    due.sort_by_key(|(_, s)| s.due);
    // Learning cards due now first; those due within 20 minutes only once
    // nothing else is left (learn ahead, as Anki does).
    let ahead: Vec<_> = learning.iter().position(|(_, s)| s.due > now).map(|i| learning.split_off(i)).unwrap_or_default();
    learning
        .into_iter()
        .chain(due)
        .chain(fresh)
        .chain(ahead)
        .map(|(c, s)| QueueCard { intervals: intervals(set, &s, &c.id, now), state: s.state, due: s.due, card: c })
        .collect()
}

/// Grade card `id` (1–4); returns its new schedule.
pub fn grade(root: &Path, id: &str, g: u8, set: &Settings) -> Result<Sched, String> {
    if !(1..=4).contains(&g) {
        return Err("grade must be 1–4".into());
    }
    let _l = LOCK.lock().unwrap();
    let mut st = load(root);
    let now = now_ms();
    let cur = st.cards.get(id).cloned().unwrap_or_default();
    if cur.reps == 0 {
        *st.new_days.entry(today()).or_default() += 1;
    }
    let next = Fsrs { w: &W, set }.review(&cur, g, now, seed(id, cur.reps));
    st.cards.insert(id.to_string(), next.clone());
    *st.days.entry(today()).or_default() += 1;
    save(root, &st)?;
    Ok(next)
}

/// Undo: put back card `id`'s earlier schedule (None: it was new).
pub fn restore(root: &Path, id: &str, prev: Option<Sched>) -> Result<(), String> {
    let _l = LOCK.lock().unwrap();
    let mut st = load(root);
    let t = today();
    if let Some(n) = st.days.get_mut(&t) {
        *n = n.saturating_sub(1);
    }
    match prev {
        Some(p) => {
            st.cards.insert(id.into(), p);
        }
        None => {
            st.cards.remove(id);
            if let Some(n) = st.new_days.get_mut(&t) {
                *n = n.saturating_sub(1);
            }
        }
    }
    save(root, &st)
}

#[derive(Serialize)]
pub struct Stats {
    pub days: BTreeMap<String, u32>,
    pub new: usize,
    pub learning: usize,
    pub young: usize,
    pub mature: usize,
    /// Due per day for the next 30 days (index 0 = today, overdue included).
    pub forecast: Vec<usize>,
    pub total_reviews: u32,
}

pub fn stats(idx: &Index, root: &Path, exclude: &[String]) -> Stats {
    let st = load(root);
    let eod = end_of_day();
    let mut s = Stats { days: st.days.clone(), new: 0, learning: 0, young: 0, mature: 0, forecast: vec![0; 30], total_reviews: st.days.values().sum() };
    for c in all_cards(idx, exclude) {
        match st.cards.get(&c.id) {
            None => s.new += 1,
            Some(x) if x.state != 2 => s.learning += 1,
            Some(x) => {
                let ivl = x.last.map(|l| (x.due - l) / DAY).unwrap_or(0);
                if ivl >= 21 {
                    s.mature += 1;
                } else {
                    s.young += 1;
                }
                let day = if x.due < eod { 0 } else { ((x.due - eod) / DAY + 1) as usize };
                if day < 30 {
                    s.forecast[day] += 1;
                }
            }
        }
    }
    s
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    fn run(seq: &[(u8, f64)]) -> Vec<Sched> {
        let set = Settings { fuzz: false, ..Default::default() };
        let f = Fsrs { w: &W, set: &set };
        let mut c = Sched::default();
        let t0 = 1_767_254_400_000i64; // 2026-01-01 08:00 UTC
        seq.iter()
            .map(|&(g, day)| {
                c = f.review(&c, g, t0 + (day * 86_400_000.0).round() as i64, 0);
                let mut out = c.clone();
                out.due -= t0;
                out
            })
            .collect()
    }

    #[test]
    fn matches_py_fsrs() {
        // srs_ref.json: py-fsrs 6.3.2, Scheduler(enable_fuzzing=False), the
        // same grade sequences (days from 2026-01-01 08:00 UTC).
        let refs: serde_json::Value = serde_json::from_str(include_str!("srs_ref.json")).unwrap();
        let seqs: &[(&str, &[(u8, f64)])] = &[
            ("good_path", &[(3, 0.0), (3, 0.01), (3, 1.0), (3, 3.0), (3, 8.0), (3, 21.0)]),
            ("lapse", &[(3, 0.0), (3, 0.01), (4, 1.0), (1, 10.0), (3, 10.01), (3, 12.0), (2, 20.0)]),
            ("easy_hard", &[(4, 0.0), (2, 4.0), (4, 9.0), (1, 9.2), (1, 9.21), (4, 9.3)]),
            ("again_start", &[(1, 0.0), (1, 0.001), (2, 0.01), (3, 0.02), (3, 0.03), (3, 2.5), (4, 6.0)]),
        ];
        for (name, seq) in seqs {
            let got = run(seq);
            let want = refs[name].as_array().unwrap();
            for (k, (g, w)) in got.iter().zip(want).enumerate() {
                let ctx = format!("{name}[{k}]");
                let state = w["state"].as_u64().unwrap() as u8;
                assert_eq!(g.state, state, "{ctx} state");
                assert_eq!(g.step, w["step"].as_u64().map(|x| x as usize), "{ctx} step");
                assert!((g.s.unwrap() - w["s"].as_f64().unwrap()).abs() < 1e-9, "{ctx} s {} vs {}", g.s.unwrap(), w["s"]);
                assert!((g.d.unwrap() - w["d"].as_f64().unwrap()).abs() < 1e-9, "{ctx} d");
                assert_eq!(g.due, (w["due"].as_f64().unwrap() * 1000.0).round() as i64, "{ctx} due");
            }
        }
    }

    #[test]
    fn fuzz_stays_in_range() {
        let set = Settings::default();
        let f = Fsrs { w: &W, set: &set };
        for seed in 0..200u64 {
            let x = f.fuzz(30, seed.wrapping_mul(2654435761));
            assert!((26..=33).contains(&x), "{x}"); // py-fsrs range for 30 days
        }
        assert_eq!(f.fuzz(2, 5), 2);
    }

    #[test]
    fn parses_cards() {
        let t = "---\ntags: [flashcards]\n---\n# Spanish\n\nperro::dog\n- gato:::cat\nnot `std::vector` a card\n\nWhat is 2+2?\n?\n4\nfour <!--SR:!2026-01-05,3,250-->\n\nThe ==mitochondria== is the ==powerhouse== of the cell.\n\n{{c1::Paris}} is the capital of {{c1::France::country}}; {{c2::Rome}} of Italy.\n\n```\nnot::a card\n```\n";
        let c = parse("Lang/es.md", "es", t);
        let k: Vec<(&str, &str, &str)> = c.iter().map(|c| (c.kind.as_str(), c.front.as_str(), c.back.as_str())).collect();
        assert_eq!(k[0], ("basic", "perro", "dog"));
        assert_eq!(k[1], ("basic", "gato", "cat"));
        assert_eq!(k[2], ("reversed", "cat", "gato"));
        assert_eq!(k[3], ("basic", "What is 2+2?", "4\nfour"));
        assert!(c[3].seed_due.is_some());
        assert_eq!(k[4], ("cloze", "The **[…]** is the powerhouse of the cell.", "The ==mitochondria== is the powerhouse of the cell."));
        assert_eq!(k[5].1, "The mitochondria is the **[…]** of the cell.");
        assert_eq!(k[6].1, "**[…]** is the capital of **[country…]**; Rome of Italy.");
        assert_eq!(k[7].1, "Paris is the capital of France; **[…]** of Italy.");
        assert_eq!(c.len(), 8, "{k:?}");
        assert_eq!(c[0].line, 6);
        // ids are stable and distinct
        let again = parse("Other/place.md", "x", t);
        assert_eq!(again[0].id, c[0].id);
        let mut ids: Vec<_> = c.iter().map(|c| &c.id).collect();
        ids.dedup();
        assert_eq!(ids.len(), 8);
    }

    #[test]
    fn decks() {
        assert_eq!(deck_of("a/b.md", &["x".into(), "flashcards/Spanish/verbs".into()]).as_deref(), Some("Spanish/verbs"));
        assert_eq!(deck_of("a/b.md", &["flashcards".into()]).as_deref(), Some("a"));
        assert_eq!(deck_of("b.md", &["Flashcards".into()]).as_deref(), Some("Default"));
        assert_eq!(deck_of("b.md", &["cards".into()]), None);
    }

    #[test]
    fn labels() {
        assert_eq!(label(60_000), "1m");
        assert_eq!(label(600_000), "10m");
        assert_eq!(label(3 * DAY), "3d");
        assert_eq!(label(45 * DAY), "1.5mo");
        assert_eq!(label(730 * DAY), "2y");
    }
}
