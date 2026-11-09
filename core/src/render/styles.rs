//! Word-like style system. A `Theme` holds page setup plus named paragraph
//! styles (body, title, h1..h6, quote, code, link, caption). Themes merge
//! field by field: built-in → vault `.notez/styles/<name>.yaml` → note
//! frontmatter. `prelude()` compiles a theme into Typst set/show rules.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::script;
use super::typst_str as q;

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "kebab-case")]
pub struct TextStyle {
    /// Main font family (usually a Latin one).
    pub font: Option<String>,
    /// Deprecated alias of `fonts.arabic` (Persian/Arabic font), kept so
    /// existing themes keep working.
    pub font_fa: Option<String>,
    /// Fonts per script, tried after `font`: `{ arabic: Vazirmatn, cjk:
    /// "Noto Serif CJK SC", devanagari: "Noto Serif Devanagari", … }` (keys:
    /// `script::FONT_KEYS`). Scripts without an entry use the bundled Noto fonts.
    pub fonts: Option<BTreeMap<String, String>>,
    pub size: Option<String>,
    pub weight: Option<String>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    /// Small capitals (headings and titles).
    pub smallcaps: Option<bool>,
    /// Letter spacing, e.g. `0.05em` or `-0.2pt`.
    pub tracking: Option<String>,
    pub color: Option<String>,
    /// start | end | left | center | right | justify
    pub align: Option<String>,
    /// Word-style multiplier: 1.0 single, 1.5, 2.0 double.
    pub line_spacing: Option<f64>,
    pub space_before: Option<String>,
    pub space_after: Option<String>,
    /// First-line indent (body only).
    pub indent: Option<String>,
    /// Heading numbering pattern, e.g. "1.", "1.1.", "۱.", "I." or "none".
    pub numbering: Option<String>,
    /// Background fill (quote/code).
    pub background: Option<String>,
    /// Accent bar / border color (quote/code).
    pub border: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "kebab-case")]
pub struct HeaderFooter {
    pub left: Option<String>,
    pub center: Option<String>,
    pub right: Option<String>,
    /// Draw a thin rule between header/footer and body.
    pub line: Option<bool>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "kebab-case")]
pub struct PageStyle {
    /// a4, a5, us-letter, ...
    pub paper: Option<String>,
    /// portrait | landscape
    pub orientation: Option<String>,
    /// "2.5cm" or "top right bottom left" e.g. "2cm 2.5cm 2cm 2.5cm"
    pub margin: Option<String>,
    pub columns: Option<u32>,
    pub header: Option<HeaderFooter>,
    pub footer: Option<HeaderFooter>,
    /// Hide header/footer on the first page.
    pub skip_first: Option<bool>,
    /// Page number pattern: "1", "۱", "i", "1 / 1" ...
    pub numbering: Option<String>,
    pub background: Option<String>,
    /// Digits of page and heading numbers: `auto` (the document language's
    /// own digits, e.g. Persian for `fa`, Arabic-Indic for `ar`), `latin`,
    /// `persian`, `arabic-indic`, `devanagari`, `bengali`, `thai`, `khmer`, …
    /// (see `script::DIGIT_SYSTEMS`). Unset = as written in each pattern.
    pub digits: Option<String>,
    /// Digits of heading numbers only; overrides `digits` for headings.
    pub heading_digits: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "kebab-case")]
pub struct Theme {
    pub name: Option<String>,
    pub description: Option<String>,
    /// Document language (ISO 639, e.g. `en`, `fa`, `ar`, `ja`, `pt-BR`).
    /// Unset or `auto`: detected from the note's text. It sets the text
    /// direction, hyphenation, quotes and `digits: auto`.
    pub lang: Option<String>,
    /// Language of the sample text in the Themes dialog thumbnail (for
    /// themes made for one script, e.g. `zh`); default: `lang`, else English.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample: Option<String>,
    pub page: PageStyle,
    pub styles: BTreeMap<String, TextStyle>,
}

impl Theme {
    pub fn style(&self, key: &str) -> TextStyle {
        self.styles.get(key).cloned().unwrap_or_default()
    }

    /// The document language, normalised; `None` while still to be detected.
    pub fn lang_code(&self) -> Option<String> {
        self.lang.as_deref().filter(|l| *l != "auto").and_then(script::normalize_lang)
    }

    /// Fill in the language from `text` when the theme leaves it to
    /// detection (falls back to English for text without letters).
    pub fn resolve_lang(&mut self, text: &str) {
        let lang = self.lang_code().unwrap_or_else(|| script::guess_lang(text).unwrap_or("en").to_string());
        self.lang = Some(lang);
    }

    pub fn is_rtl(&self) -> bool {
        self.lang_code().is_some_and(|l| script::is_rtl_lang(&l))
    }

    /// Digit system for `digits`-style settings (`auto` = the language's own).
    fn digit_system(&self, setting: Option<&str>) -> Option<&'static script::Digits> {
        match setting.map(str::trim) {
            None | Some("") => None,
            Some("auto") => Some(script::native_digits(&self.lang_code().unwrap_or_else(|| "en".into()))),
            Some(name) => script::digits(name),
        }
    }
}

pub const BUILTIN_THEMES: &[(&str, &str)] = &[
    ("default", include_str!("themes/default.yaml")),
    ("academic", include_str!("themes/academic.yaml")),
    ("modern", include_str!("themes/modern.yaml")),
    ("report", include_str!("themes/report.yaml")),
    ("minimal", include_str!("themes/minimal.yaml")),
    ("thesis", include_str!("themes/thesis.yaml")),
    ("book", include_str!("themes/book.yaml")),
    ("letter", include_str!("themes/letter.yaml")),
    ("compact", include_str!("themes/compact.yaml")),
    ("newspaper", include_str!("themes/newspaper.yaml")),
    ("elegant", include_str!("themes/elegant.yaml")),
    ("technical", include_str!("themes/technical.yaml")),
    ("night", include_str!("themes/night.yaml")),
    ("naskh", include_str!("themes/naskh.yaml")),
    ("cjk", include_str!("themes/cjk.yaml")),
    ("devanagari", include_str!("themes/devanagari.yaml")),
];

pub fn parse_theme(yaml: &str) -> Result<Theme, String> {
    if yaml.trim().is_empty() {
        return Ok(Theme::default());
    }
    serde_yaml_ng::from_str(yaml).map_err(|e| e.to_string())
}

/// Deep-merge theme YAML: keys of `over` win and an explicit `null` clears
/// the value underneath (a saved theme removing a built-in footer slot, a
/// heading numbering, a color…). A `null` over a section that must stay a
/// map (`page`, `styles`, one style) is ignored; header/footer may be cleared.
pub fn merge_value(base: &mut serde_yaml_ng::Value, over: &serde_yaml_ng::Value) {
    use serde_yaml_ng::Value;
    match (base, over) {
        (Value::Mapping(b), Value::Mapping(o)) => {
            for (k, v) in o {
                match b.get_mut(k) {
                    Some(slot) => {
                        let clearable = matches!(k.as_str(), Some("header" | "footer"));
                        if v.is_null() && slot.is_mapping() && !clearable {
                            continue;
                        }
                        merge_value(slot, v);
                    }
                    None if v.is_null() => {}
                    None => {
                        b.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (b, o) => *b = o.clone(),
    }
}

/// Merge a user layer (a vault theme file or a note's frontmatter) over a
/// theme. Layers written before `digits` existed (0.5) named their page
/// numbering pattern literally — `numbering: '1'` meant Latin digits — so a
/// layer that sets `page.numbering` without `page.digits` keeps its pattern
/// as written instead of inheriting the built-in `digits: auto`.
pub fn merge_layer(base: &mut serde_yaml_ng::Value, over: &serde_yaml_ng::Value) {
    use serde_yaml_ng::Value;
    let mut over = over.clone();
    if let Some(Value::Mapping(page)) = over.get_mut("page") {
        if page.contains_key("numbering") && !page.contains_key("digits") {
            page.insert("digits".into(), Value::Null);
        }
    }
    merge_value(base, &over);
}

pub fn theme_from_value(v: &serde_yaml_ng::Value) -> Option<Theme> {
    if v.is_null() {
        return Some(Theme::default());
    }
    serde_yaml_ng::from_value(v.clone()).ok()
}

pub fn builtin(name: &str) -> Option<Theme> {
    BUILTIN_THEMES.iter().find(|(n, _)| *n == name).and_then(|(_, y)| parse_theme(y).ok())
}

// ---------- validation helpers (keep generated Typst well-formed) ----------

fn length(s: &str) -> Option<String> {
    let s = s.trim();
    let num_end = s.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-')).unwrap_or(s.len());
    let (num, unit) = s.split_at(num_end);
    let ok_num = !num.is_empty() && num.parse::<f64>().is_ok();
    let ok_unit = matches!(unit, "pt" | "mm" | "cm" | "in" | "em");
    (ok_num && ok_unit).then(|| s.to_string())
}

pub fn color(s: &str) -> Option<String> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix('#') {
        if matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(format!("rgb(\"{s}\")"));
        }
        return None;
    }
    const NAMED: &[&str] = &[
        "black", "gray", "silver", "white", "navy", "blue", "aqua", "teal", "eastern", "purple",
        "fuchsia", "maroon", "red", "orange", "yellow", "olive", "green", "lime",
    ];
    NAMED.contains(&s).then(|| s.to_string())
}

fn weight(s: &str) -> Option<String> {
    const NAMED: &[&str] =
        &["thin", "extralight", "light", "regular", "medium", "semibold", "bold", "extrabold", "black"];
    let s = s.trim();
    if NAMED.contains(&s) {
        Some(q(s))
    } else {
        s.parse::<u16>().ok().filter(|w| (100..=900).contains(w)).map(|w| w.to_string())
    }
}

fn align(s: &str) -> Option<&'static str> {
    Some(match s.trim() {
        "start" => "start",
        "end" => "end",
        "left" => "left",
        "right" => "right",
        "center" => "center",
        _ => return None,
    })
}

fn numbering(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty() && s != "none").then(|| q(s))
}

/// A style's own fonts in order: `font`, then the per-script `fonts`
/// (the `font-fa` alias counts as `fonts.arabic`).
fn own_fonts(st: &TextStyle) -> Vec<String> {
    let mut list: Vec<String> = Vec::new();
    let mut add = |f: &str| {
        let f = f.trim();
        if !f.is_empty() && !list.iter().any(|x| x == f) {
            list.push(f.to_string());
        }
    };
    if let Some(f) = &st.font {
        add(f);
    }
    if let Some(map) = &st.fonts {
        // Scripts in a fixed order so the generated source is stable.
        for key in script::FONT_KEYS {
            if let Some(f) = map.get(*key) {
                add(f);
            }
        }
        for (k, f) in map {
            if !script::FONT_KEYS.contains(&k.as_str()) {
                add(f);
            }
        }
    }
    if let Some(f) = &st.font_fa {
        add(f);
    }
    list
}

/// Whether a font family looks like a serif face (picks serif or sans
/// fallbacks for the other scripts).
fn is_serif(family: &str) -> bool {
    let f = family.to_ascii_lowercase();
    !(f.contains("sans") || f.contains("mono") || f.contains("grotesk") || f.contains("gothic")
        || ["vazirmatn", "inter", "roboto", "lato", "fira", "helvetica", "arial", "ubuntu", "cantarell", "montserrat", "dejavu sans"]
            .iter()
            .any(|n| f.starts_with(n)))
}

/// Typst font array for a style: its own fonts, then the bundled fallbacks
/// (the regional CJK font for the document language first). `None` when the
/// style sets no font (it inherits the body's list).
fn fonts(st: &TextStyle, lang: &str) -> Option<String> {
    let own = own_fonts(st);
    if own.is_empty() {
        return None;
    }
    Some(font_array(&own, lang))
}

/// Font array for snippets rendered outside a note (inline block previews).
pub fn default_font_array() -> String {
    font_array(&["New Computer Modern".to_string()], "en")
}

fn font_array(own: &[String], lang: &str) -> String {
    let serif = own.first().is_none_or(|f| is_serif(f));
    let mut list: Vec<String> = own.to_vec();
    let mut add = |f: &str| {
        if !list.iter().any(|x| x == f) {
            list.push(f.to_string());
        }
    };
    if let Some(cjk) = script::cjk_font_for(lang) {
        add(cjk);
    }
    for f in script::fallback_fonts(serif) {
        add(f);
    }
    format!("({},)", list.iter().map(|f| q(f)).collect::<Vec<_>>().join(", "))
}

/// `set text(...)` arguments for a style.
fn text_args(st: &TextStyle, lang: &str) -> Vec<String> {
    let mut a = Vec::new();
    if let Some(f) = fonts(st, lang) {
        a.push(format!("font: {f}"));
    }
    if let Some(s) = st.size.as_deref().and_then(length) {
        a.push(format!("size: {s}"));
    }
    if let Some(w) = st.weight.as_deref().and_then(weight) {
        a.push(format!("weight: {w}"));
    }
    if let Some(i) = st.italic {
        a.push(format!("style: {}", if i { "\"italic\"" } else { "\"normal\"" }));
    }
    if let Some(c) = st.color.as_deref().and_then(color) {
        a.push(format!("fill: {c}"));
    }
    if let Some(t) = st.tracking.as_deref().and_then(length) {
        a.push(format!("tracking: {t}"));
    }
    a
}

/// `, above: x, below: y` for a block from a style's space before/after.
fn block_space(st: &TextStyle) -> String {
    let mut o = String::new();
    if let Some(b) = st.space_before.as_deref().and_then(length) {
        o.push_str(&format!(", above: {b}"));
    }
    if let Some(a) = st.space_after.as_deref().and_then(length) {
        o.push_str(&format!(", below: {a}"));
    }
    o
}

fn leading(st: &TextStyle) -> Option<String> {
    st.line_spacing.filter(|f| (0.5..=4.0).contains(f)).map(|f| format!("{:.2}em", 0.65 + (f - 1.0)))
}

// ---------- header / footer ----------

/// Turn "Page {page} of {total} — {title}" into Typst markup.
/// `page_numbering` is a Typst numbering value (a pattern string or function).
fn placeholder_markup(s: &str, page_numbering: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('{') {
        let (lit, tail) = rest.split_at(start);
        if !lit.is_empty() {
            out.push_str(&format!("#{}", q(lit)));
        }
        let Some(end) = tail.find('}') else {
            rest = tail;
            break;
        };
        let key = &tail[1..end];
        out.push_str(&match key {
            "page" => format!("#counter(page).display({page_numbering})"),
            "total" => format!("#numbering({page_numbering}, ..counter(page).final())"),
            "title" => "#document.title".into(),
            "author" => "#notez-meta.author".into(),
            "date" => "#notez-meta.date".into(),
            "chapter" => "#{ let hs = query(heading.where(level: 1).before(here())); if hs.len() > 0 { hs.last().body } }".into(),
            other => format!("#{}", q(&format!("{{{other}}}"))),
        });
        rest = &tail[end + 1..];
    }
    if !rest.is_empty() {
        out.push_str(&format!("#{}", q(rest)));
    }
    out
}

fn header_footer(
    hf: &HeaderFooter,
    page_numbering: &str,
    is_header: bool,
    skip_first: bool,
    meta: &Meta,
    rtl: bool,
) -> Option<String> {
    // Left/right are physical positions, so the grid is laid out LTR; each
    // slot then gets the text direction of its own (resolved) content.
    let part = |s: &Option<String>| {
        let Some(s) = s.as_deref() else { return String::new() };
        let sample = s.replace("{title}", meta.title.unwrap_or("")).replace("{author}", meta.author.unwrap_or(""));
        let dir = match super::md::detect_dir(&sample) {
            Some(super::md::Dir::Ltr) => "ltr",
            Some(super::md::Dir::Rtl) => "rtl",
            None if rtl => "rtl",
            None => "ltr",
        };
        format!("#set text(dir: {dir})\n{}", placeholder_markup(s, page_numbering))
    };
    let empty = |s: &Option<String>| s.as_deref().is_none_or(|s| s.trim().is_empty());
    if empty(&hf.left) && empty(&hf.center) && empty(&hf.right) {
        return None;
    }
    let grid = format!(
        "grid(columns: (1fr, auto, 1fr), align(left)[{}], align(center)[{}], align(right)[{}])",
        part(&hf.left),
        part(&hf.center),
        part(&hf.right)
    );
    let line = if hf.line.unwrap_or(false) {
        "line(length: 100%, stroke: 0.4pt + luma(160))"
    } else {
        "none"
    };
    let body = if is_header {
        format!("{grid}; v(-6pt); {line}")
    } else {
        format!("{line}; v(-6pt); {grid}")
    };
    let inner = format!("{{ set text(size: 0.85em, fill: luma(90), dir: ltr); {body} }}");
    Some(if skip_first {
        format!("context if here().page() == 1 {{ none }} else {inner}")
    } else {
        format!("context {inner}")
    })
}

// ---------- the prelude ----------

pub struct Meta<'a> {
    pub title: Option<&'a str>,
    pub author: Option<&'a str>,
    pub date: Option<&'a str>,
}

pub fn prelude(theme: &Theme, meta: &Meta) -> String {
    let mut o = String::new();
    let lang = theme.lang_code().unwrap_or_else(|| "en".into());
    let lang = lang.as_str();
    let (lang_base, region) = script::split_lang(lang);

    // Metadata available to header/footer placeholders.
    let date = match meta.date {
        Some("today") | None => "datetime.today().display(\"[year]/[month]/[day]\")".to_string(),
        Some(d) => q(d),
    };
    o.push_str(&format!(
        "#let notez-meta = (author: {}, date: {})\n",
        q(meta.author.unwrap_or("")),
        date
    ));
    if let Some(t) = meta.title {
        o.push_str(&format!(
            "#set document(title: {}{})\n",
            q(t),
            meta.author.map(|a| format!(", author: {}", q(a))).unwrap_or_default()
        ));
    }

    // Page setup.
    let p = &theme.page;
    let pattern = p.numbering.clone().unwrap_or_else(|| "1".into());
    let page_digits = theme.digit_system(p.digits.as_deref());
    let page_numbering = script::numbering_value(&pattern, page_digits);
    let mut page = vec![format!("paper: {}", q(p.paper.as_deref().unwrap_or("a4")))];
    if p.orientation.as_deref() == Some("landscape") {
        page.push("flipped: true".into());
    }
    if let Some(m) = &p.margin {
        let parts: Vec<String> = m.split_whitespace().filter_map(length).collect();
        match parts.len() {
            1 => page.push(format!("margin: {}", parts[0])),
            4 => page.push(format!(
                "margin: (top: {}, right: {}, bottom: {}, left: {})",
                parts[0], parts[1], parts[2], parts[3]
            )),
            2 => page.push(format!("margin: (y: {}, x: {})", parts[0], parts[1])),
            _ => {}
        }
    }
    if let Some(c) = p.columns.filter(|c| (2..=4).contains(c)) {
        page.push(format!("columns: {c}"));
    }
    if let Some(bg) = p.background.as_deref().and_then(color) {
        page.push(format!("fill: {bg}"));
    }
    page.push(format!("numbering: {page_numbering}"));
    let skip = p.skip_first.unwrap_or(false);
    // An empty header/footer is `none`, not Typst's automatic page number.
    let hf = |x: &Option<HeaderFooter>, is_header| {
        x.as_ref().and_then(|h| header_footer(h, &page_numbering, is_header, skip, meta, theme.is_rtl())).unwrap_or_else(|| "none".into())
    };
    page.push(format!("header: {}", hf(&p.header, true)));
    page.push(format!("footer: {}", hf(&p.footer, false)));
    o.push_str(&format!("#set page({})\n", page.join(", ")));

    // Body text & paragraphs.
    let body = theme.style("body");
    // The body's font list, also used by spans and blocks that name one font.
    let body_fonts = font_array(&own_fonts(&body), lang);
    o.push_str(&format!("#let notez-fonts = {body_fonts}\n"));
    let mut text = text_args(&body, lang);
    if !text.iter().any(|a| a.starts_with("font:")) {
        text.insert(0, "font: notez-fonts".into());
    }
    text.push(format!("lang: {}", q(&lang_base)));
    if let Some(r) = &region {
        text.push(format!("region: {}", q(r)));
    }
    text.push(format!("dir: {}", if theme.is_rtl() { "rtl" } else { "ltr" }));
    o.push_str(&format!("#set text({})\n", text.join(", ")));
    let mut par = Vec::new();
    let lead = leading(&body);
    if let Some(l) = &lead {
        par.push(format!("leading: {l}"));
    }
    // Typst's paragraph spacing replaces the gap between lines instead of
    // adding to it, so "space after" smaller than the line spacing made a
    // paragraph break look like a line break. Space after is extra space.
    if let Some(s) = body.space_after.as_deref().and_then(length) {
        par.push(format!("spacing: {} + {s}", lead.as_deref().unwrap_or("0.65em")));
    }
    match body.align.as_deref() {
        Some("justify") => par.push("justify: true".into()),
        Some(a) => {
            if let Some(a) = align(a) {
                o.push_str(&format!("#set align({a})\n"));
            }
        }
        None => {}
    }
    if let Some(i) = body.indent.as_deref().and_then(length) {
        par.push(format!("first-line-indent: {i}"));
    }
    if !par.is_empty() {
        o.push_str(&format!("#set par({})\n", par.join(", ")));
    }
    if body.underline == Some(true) {
        o.push_str("#show: underline\n");
    }

    // Headings.
    o.push_str("#set heading(numbering: none)\n");
    for level in 1..=6 {
        let st = theme.style(&format!("h{level}"));
        let sel = format!("heading.where(level: {level})");
        let t = text_args(&st, lang);
        if !t.is_empty() {
            o.push_str(&format!("#show {sel}: set text({})\n", t.join(", ")));
        }
        let mut blk = Vec::new();
        if let Some(b) = st.space_before.as_deref().and_then(length) {
            blk.push(format!("above: {b}"));
        }
        if let Some(a) = st.space_after.as_deref().and_then(length) {
            blk.push(format!("below: {a}"));
        }
        if !blk.is_empty() {
            o.push_str(&format!("#show {sel}: set block({})\n", blk.join(", ")));
        }
        let heading_digits = theme.digit_system(p.heading_digits.as_deref().or(p.digits.as_deref()));
        if let Some(n) = st.numbering.as_deref().filter(|n| numbering(n).is_some()) {
            let n = script::numbering_value(n.trim(), heading_digits);
            o.push_str(&format!("#show {sel}: set heading(numbering: {n})\n"));
        }
        if let Some(a) = st.align.as_deref().and_then(align) {
            o.push_str(&format!("#show {sel}: set align({a})\n"));
        }
        if st.underline == Some(true) {
            o.push_str(&format!("#show {sel}: underline\n"));
        }
        if st.smallcaps == Some(true) {
            o.push_str(&format!("#show {sel}: smallcaps\n"));
        }
        if let Some(c) = st.border.as_deref().and_then(color) {
            o.push_str(&format!(
                "#show {sel}: it => block(width: 100%, stroke: (bottom: 0.8pt + {c}), inset: (bottom: 4pt), it)\n"
            ));
        }
    }

    // Quote.
    let qs = theme.style("quote");
    let qt = text_args(&qs, lang);
    if !qt.is_empty() {
        o.push_str(&format!("#show quote.where(block: true): set text({})\n", qt.join(", ")));
    }
    let qbar = qs.border.as_deref().and_then(color).unwrap_or_else(|| "luma(180)".into());
    let qfill = qs.background.as_deref().and_then(color).unwrap_or_else(|| "none".into());
    if let Some(a) = qs.align.as_deref().and_then(align) {
        o.push_str(&format!("#show quote.where(block: true): set align({a})\n"));
    }
    if qs.underline == Some(true) {
        o.push_str("#show quote.where(block: true): underline\n");
    }
    o.push_str(&format!(
        "#show quote.where(block: true): it => block(width: 100%, fill: {qfill}, inset: (x: 12pt, y: 8pt), radius: 2pt, stroke: (left: 2.5pt + {qbar}){}, it.body)\n",
        block_space(&qs)
    ));

    // Code: always LTR.
    let cs = theme.style("code");
    let mut ct = text_args(&cs, lang);
    if cs.font.is_none() {
        ct.push("font: (\"DejaVu Sans Mono\",) + notez-fonts".into());
    }
    ct.push("dir: ltr".into());
    o.push_str(&format!("#show raw: set text({})\n", ct.join(", ")));
    o.push_str(&format!(
        "#set raw(syntaxes: ({}, {}))\n",
        q(super::world::ASM_SYNTAX_PATH),
        q(super::world::MIPS_SYNTAX_PATH)
    ));
    let cfill = cs.background.as_deref().and_then(color).unwrap_or_else(|| "luma(245)".into());
    let cstroke = cs.border.as_deref().and_then(color).map(|c| format!("0.5pt + {c}")).unwrap_or_else(|| "none".into());
    let calign = cs.align.as_deref().and_then(align).unwrap_or("left");
    o.push_str(&format!(
        "#show raw.where(block: true): it => block(width: 100%, fill: {cfill}, stroke: {cstroke}, inset: 10pt, radius: 4pt{}, align({calign}, it))\n",
        block_space(&cs)
    ));
    if cs.underline == Some(true) {
        o.push_str("#show raw: underline\n");
    }

    // Links, captions, tables.
    let ls = theme.style("link");
    let link = text_args(&ls, lang);
    if !link.is_empty() {
        o.push_str(&format!("#show link: set text({})\n", link.join(", ")));
    }
    if ls.underline == Some(true) {
        o.push_str("#show link: underline\n");
    }
    let caps = theme.style("caption");
    let cap = text_args(&caps, lang);
    if !cap.is_empty() {
        o.push_str(&format!("#show figure.caption: set text({})\n", cap.join(", ")));
    }
    if let Some(a) = caps.align.as_deref().and_then(align) {
        o.push_str(&format!("#show figure.caption: set align({a})\n"));
    }
    if caps.underline == Some(true) {
        o.push_str("#show figure.caption: underline\n");
    }
    if let Some(g) = caps.space_before.as_deref().and_then(length) {
        o.push_str(&format!("#set figure(gap: {g})\n"));
    }
    if let Some(b) = caps.space_after.as_deref().and_then(length) {
        o.push_str(&format!("#show figure: set block(below: {b})\n"));
    }
    o.push_str("#set table(stroke: 0.5pt + luma(170), inset: 7pt)\n");
    o.push_str("#show table.cell.where(y: 0): set text(weight: \"bold\")\n");
    o.push_str("#show math.equation: set text(dir: ltr)\n");
    o.push_str("#set footnote.entry(separator: align(start, line(length: 30%, stroke: 0.5pt)))\n");
    o
}

/// Title block from frontmatter (title / subtitle / author / date).
pub fn title_block(theme: &Theme, meta: &Meta, subtitle: Option<&str>) -> String {
    let Some(title) = meta.title else { return String::new() };
    let ts = theme.style("title");
    let ss = theme.style("subtitle");
    let lang = theme.lang_code().unwrap_or_else(|| "en".into());
    let mut targs = text_args(&ts, &lang);
    if targs.iter().all(|a| !a.starts_with("size")) {
        targs.push("size: 2em".into());
    }
    if targs.iter().all(|a| !a.starts_with("weight")) {
        targs.push("weight: \"bold\"".into());
    }
    let talign = ts.align.as_deref().and_then(align).unwrap_or("center");
    let ul = |st: &TextStyle, body: String| {
        let body = if st.smallcaps == Some(true) { format!("#smallcaps[{body}]") } else { body };
        if st.underline == Some(true) { format!("#underline[{body}]") } else { body }
    };
    let mut o = String::new();
    if let Some(b) = ts.space_before.as_deref().and_then(length) {
        o.push_str(&format!("#v({b})\n"));
    }
    o.push_str(&format!(
        "#align({talign})[\n#text({})[{}]\n",
        targs.join(", "),
        ul(&ts, super::escape_markup(title))
    ));
    if let Some(s) = subtitle {
        let mut sargs = text_args(&ss, &lang);
        if sargs.is_empty() {
            sargs.push("size: 1.25em, fill: luma(90)".into());
        }
        let mut sub = format!("#text({})[{}]", sargs.join(", "), ul(&ss, super::escape_markup(s)));
        if let Some(a) = ss.align.as_deref().and_then(align) {
            sub = format!("#align({a})[{sub}]");
        }
        let before = ss.space_before.as_deref().and_then(length).map(|b| format!("#v({b}, weak: true)\n")).unwrap_or_default();
        let after = ss.space_after.as_deref().and_then(length).map(|b| format!("\n#v({b}, weak: true)")).unwrap_or_default();
        o.push_str(&format!("\n{before}{sub}{after}\n"));
    }
    if meta.author.is_some() || meta.date.is_some() {
        o.push_str("\n#text(fill: luma(80))[#notez-meta.author");
        if meta.author.is_some() && meta.date.is_some() {
            o.push_str(" #h(1em) ");
        }
        if meta.date.is_some() {
            o.push_str("#notez-meta.date");
        }
        o.push_str("]\n");
    }
    let after = ts.space_after.as_deref().and_then(length).unwrap_or_else(|| "1.5em".into());
    o.push_str(&format!("]\n#v({after})\n"));
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    fn theme_lang(lang: &str) -> Theme {
        Theme { lang: Some(lang.into()), ..Default::default() }
    }

    #[test]
    fn heading_digit_styles() {
        let ds = |t: &Theme, s: &str| t.digit_system(Some(s)).map(|d| d.name);
        assert_eq!(ds(&theme_lang("fa"), "auto"), Some("persian"));
        assert_eq!(ds(&theme_lang("ar"), "auto"), Some("arabic-indic"));
        assert_eq!(ds(&theme_lang("en"), "auto"), Some("latin"));
        assert_eq!(ds(&theme_lang("hi"), "auto"), Some("latin"));
        assert_eq!(ds(&theme_lang("en"), "arabic"), Some("arabic-indic"));
        assert_eq!(theme_lang("en").digit_system(None).map(|d| d.name), None);

        // Headings and pages follow `digits`, `heading-digits` overrides headings.
        let mut t = theme_lang("fa");
        t.page.digits = Some("auto".into());
        t.page.numbering = Some("1".into());
        t.styles.insert("h1".into(), TextStyle { numbering: Some("1.".into()), ..Default::default() });
        t.styles.insert("h2".into(), TextStyle { numbering: Some("I.".into()), ..Default::default() });
        let p = prelude(&t, &Meta { title: None, author: None, date: None });
        assert!(p.contains("numbering: \"۱\""), "{p}");
        assert!(p.contains("set heading(numbering: \"۱.\")"), "{p}");
        assert!(p.contains("set heading(numbering: \"I.\")"), "{p}");
        t.page.heading_digits = Some("latin".into());
        let p = prelude(&t, &Meta { title: None, author: None, date: None });
        assert!(p.contains("set heading(numbering: \"1.\")"), "{p}");
        // Thai digits have no Typst pattern character: a mapping function.
        t.lang = Some("th".into());
        t.page.digits = Some("thai".into());
        let p = prelude(&t, &Meta { title: None, author: None, date: None });
        assert!(p.contains("notez-digits(numbering(\"1\", ..n)"), "{p}");
    }

    #[test]
    fn language_and_direction() {
        for (lang, rtl) in [("fa", true), ("ur", true), ("ar-EG", true), ("en", false), ("ja", false), ("hi", false)] {
            let t = theme_lang(lang);
            assert_eq!(t.is_rtl(), rtl, "{lang}");
            let p = prelude(&t, &Meta { title: None, author: None, date: None });
            let (base, region) = script::split_lang(lang);
            assert!(p.contains(&format!("lang: \"{base}\"")), "{p}");
            if let Some(r) = region {
                assert!(p.contains(&format!("region: \"{r}\"")), "{p}");
            }
            assert!(p.contains(if rtl { "dir: rtl" } else { "dir: ltr" }), "{p}");
        }
        let mut t = Theme::default();
        t.resolve_lang("هذه ملاحظة باللغة العربية");
        assert_eq!(t.lang.as_deref(), Some("ar"));
        let mut t = Theme { lang: Some("auto".into()), ..Default::default() };
        t.resolve_lang("1 + 1");
        assert_eq!(t.lang.as_deref(), Some("en"));
        let mut t = theme_lang("de");
        t.resolve_lang("این فارسی است");
        assert_eq!(t.lang.as_deref(), Some("de"), "an explicit language wins");
    }

    #[test]
    fn script_fonts() {
        let st = TextStyle {
            font: Some("Libertinus Serif".into()),
            font_fa: Some("Vazirmatn".into()),
            fonts: Some([("devanagari".to_string(), "Noto Serif Devanagari".to_string()), ("cjk".to_string(), "Noto Serif CJK JP".to_string())].into()),
            ..Default::default()
        };
        assert_eq!(own_fonts(&st), ["Libertinus Serif", "Noto Serif Devanagari", "Noto Serif CJK JP", "Vazirmatn"]);
        let a = fonts(&st, "ja").unwrap();
        assert!(a.starts_with("(\"Libertinus Serif\", \"Noto Serif Devanagari\", \"Noto Serif CJK JP\", \"Vazirmatn\", \"Noto Sans JP\", \"Noto Serif\""), "{a}");
        assert!(a.contains("\"Noto Sans Bengali\""), "{a}");
        assert_eq!(fonts(&TextStyle::default(), "en"), None);
        assert!(is_serif("New Computer Modern") && !is_serif("Noto Sans") && !is_serif("Vazirmatn"));
        let sans = fonts(&TextStyle { font: Some("Inter".into()), ..Default::default() }, "en").unwrap();
        assert!(sans.contains("\"Noto Sans\"") && !sans.contains("\"Noto Serif\""), "{sans}");
    }

    #[test]
    fn builtin_themes_parse() {
        for (name, yaml) in BUILTIN_THEMES {
            parse_theme(yaml).unwrap_or_else(|e| panic!("theme {name}: {e}"));
        }
    }

    #[test]
    fn merge_overrides_fields_only() {
        let yaml = BUILTIN_THEMES.iter().find(|(n, _)| *n == "default").unwrap().1;
        let mut v: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml).unwrap();
        let over = serde_yaml_ng::from_str("styles:\n  h1:\n    color: \"#ff0000\"\n").unwrap();
        let before = builtin("default").unwrap().style("h1");
        merge_value(&mut v, &over);
        let after = theme_from_value(&v).unwrap().style("h1");
        assert_eq!(after.color.as_deref(), Some("#ff0000"));
        assert_eq!(after.size, before.size);
    }

    /// A saved theme (every field written, cleared ones as `null`) must be
    /// able to remove built-in values: the vault's default.yaml moved the
    /// page number from the center to the right.
    #[test]
    fn explicit_null_clears() {
        let yaml = BUILTIN_THEMES.iter().find(|(n, _)| *n == "academic").unwrap().1;
        let mut v: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml).unwrap();
        let over = serde_yaml_ng::from_str(
            "page:\n  numbering: '1'\n  header: null\n  footer:\n    left: null\n    center: null\n    right: '{page}'\n    line: null\nstyles:\n  h1:\n    numbering: null\n    color: null\n  h9: null\n",
        )
        .unwrap();
        merge_value(&mut v, &over);
        let t = theme_from_value(&v).unwrap();
        let f = t.page.footer.clone().unwrap();
        assert_eq!(f.center, None);
        assert_eq!(f.right.as_deref(), Some("{page}"));
        assert_eq!(t.page.header, None);
        assert_eq!(t.style("h1").numbering, None);
        assert!(t.style("h1").size.is_some());
        let p = prelude(&t, &Meta { title: None, author: None, date: None });
        assert!(p.contains("align(center)[]"), "{p}");
        assert!(p.contains("header: none"), "{p}");
    }

    #[test]
    fn old_saved_themes_keep_literal_numbering() {
        let yaml = BUILTIN_THEMES.iter().find(|(n, _)| *n == "default").unwrap().1;
        let mut v: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml).unwrap();
        let over = serde_yaml_ng::from_str("lang: fa\npage:\n  numbering: '1'\n  heading-digits: latin\n").unwrap();
        merge_layer(&mut v, &over);
        let t = theme_from_value(&v).unwrap();
        assert_eq!(t.page.digits, None);
        let p = prelude(&t, &Meta { title: None, author: None, date: None });
        assert!(p.contains("numbering: \"1\""), "{p}");
        // A layer that names `digits` keeps it.
        let mut v: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml).unwrap();
        merge_layer(&mut v, &serde_yaml_ng::from_str("page:\n  numbering: '1'\n  digits: auto\n").unwrap());
        assert_eq!(theme_from_value(&v).unwrap().page.digits.as_deref(), Some("auto"));
    }

    #[test]
    fn empty_footer_is_none() {
        let mut t = builtin("default").unwrap();
        t.page.footer = Some(HeaderFooter { center: Some(" ".into()), ..Default::default() });
        let p = prelude(&t, &Meta { title: None, author: None, date: None });
        assert!(p.contains("footer: none"), "{p}");
    }

    #[test]
    fn rejects_bad_values() {
        assert_eq!(length("12pt").as_deref(), Some("12pt"));
        assert_eq!(length("12px"), None);
        assert_eq!(length("1); evil("), None);
        assert_eq!(color("#1a4d8f").as_deref(), Some("rgb(\"#1a4d8f\")"));
        assert_eq!(color("#zzz"), None);
        assert_eq!(color("red").as_deref(), Some("red"));
    }

    #[test]
    fn placeholders() {
        let m = placeholder_markup("Page {page} / {total}", "\"1\"");
        assert!(m.contains("counter(page).display(\"1\")"));
        assert!(m.starts_with("#\"Page \""));
    }
}
