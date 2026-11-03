//! Word-like style system. A `Theme` holds page setup plus named paragraph
//! styles (body, title, h1..h6, quote, code, link, caption). Themes merge
//! field by field: built-in → vault `.notez/styles/<name>.yaml` → note
//! frontmatter. `prelude()` compiles a theme into Typst set/show rules.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::typst_str as q;

macro_rules! mergeable {
    ($(#[$m:meta])* pub struct $name:ident { $($(#[$fm:meta])* pub $field:ident : Option<$ty:ty>,)* }) => {
        $(#[$m])*
        pub struct $name { $($(#[$fm])* pub $field: Option<$ty>,)* }
        impl $name {
            /// Fields set in `other` win.
            pub fn merge(&mut self, other: &Self) {
                $(if other.$field.is_some() { self.$field = other.$field.clone(); })*
            }
        }
    };
}

mergeable! {
    #[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
    #[serde(default, rename_all = "kebab-case")]
    pub struct TextStyle {
        /// Latin font family.
        pub font: Option<String>,
        /// Persian/Arabic font family (fallback after the Latin one).
        pub font_fa: Option<String>,
        pub size: Option<String>,
        pub weight: Option<String>,
        pub italic: Option<bool>,
        pub underline: Option<bool>,
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
}

mergeable! {
    #[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
    #[serde(default, rename_all = "kebab-case")]
    pub struct HeaderFooter {
        pub left: Option<String>,
        pub center: Option<String>,
        pub right: Option<String>,
        /// Draw a thin rule between header/footer and body.
        pub line: Option<bool>,
    }
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
}

impl PageStyle {
    pub fn merge(&mut self, o: &Self) {
        macro_rules! take { ($($f:ident),*) => { $(if o.$f.is_some() { self.$f = o.$f.clone(); })* } }
        take!(paper, orientation, margin, columns, skip_first, numbering, background);
        for (mine, theirs) in [(&mut self.header, &o.header), (&mut self.footer, &o.footer)] {
            match (mine.as_mut(), theirs) {
                (Some(m), Some(t)) => m.merge(t),
                (None, Some(t)) => *mine = Some(t.clone()),
                _ => {}
            }
        }
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "kebab-case")]
pub struct Theme {
    pub name: Option<String>,
    pub description: Option<String>,
    /// Document base language: "fa" (RTL) or "en".
    pub lang: Option<String>,
    pub page: PageStyle,
    pub styles: BTreeMap<String, TextStyle>,
}

impl Theme {
    pub fn merge(&mut self, o: &Theme) {
        if o.lang.is_some() {
            self.lang = o.lang.clone();
        }
        self.page.merge(&o.page);
        for (k, v) in &o.styles {
            self.styles.entry(k.clone()).or_default().merge(v);
        }
    }

    pub fn style(&self, key: &str) -> TextStyle {
        self.styles.get(key).cloned().unwrap_or_default()
    }

    pub fn is_rtl(&self) -> bool {
        self.lang.as_deref().is_none_or(|l| matches!(l, "fa" | "ar" | "ur" | "he"))
    }
}

pub const BUILTIN_THEMES: &[(&str, &str)] = &[
    ("default", include_str!("themes/default.yaml")),
    ("academic", include_str!("themes/academic.yaml")),
    ("modern", include_str!("themes/modern.yaml")),
    ("report", include_str!("themes/report.yaml")),
    ("minimal", include_str!("themes/minimal.yaml")),
];

pub fn parse_theme(yaml: &str) -> Result<Theme, String> {
    if yaml.trim().is_empty() {
        return Ok(Theme::default());
    }
    serde_yaml_ng::from_str(yaml).map_err(|e| e.to_string())
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

/// Typst font list: Latin first, then Persian (Typst falls back per glyph).
fn fonts(st: &TextStyle) -> Option<String> {
    let list: Vec<String> = [st.font.as_deref(), st.font_fa.as_deref()]
        .into_iter()
        .flatten()
        .filter(|f| !f.trim().is_empty())
        .map(q)
        .collect();
    match list.len() {
        0 => None,
        _ => Some(format!("({},)", list.join(", "))),
    }
}

/// `set text(...)` arguments for a style.
fn text_args(st: &TextStyle) -> Vec<String> {
    let mut a = Vec::new();
    if let Some(f) = fonts(st) {
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
    a
}

fn leading(st: &TextStyle) -> Option<String> {
    st.line_spacing.filter(|f| (0.5..=4.0).contains(f)).map(|f| format!("{:.2}em", 0.65 + (f - 1.0)))
}

// ---------- header / footer ----------

/// Turn "Page {page} of {total} — {title}" into Typst markup.
fn placeholder_markup(s: &str, page_pattern: &str) -> String {
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
            "page" => format!("#counter(page).display({})", q(page_pattern)),
            "total" => format!("#numbering({}, ..counter(page).final())", q(page_pattern)),
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
    page_pattern: &str,
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
        format!("#set text(dir: {dir})\n{}", placeholder_markup(s, page_pattern))
    };
    if hf.left.is_none() && hf.center.is_none() && hf.right.is_none() {
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
    let lang = theme.lang.as_deref().unwrap_or("fa");
    let lang = if lang.chars().all(|c| c.is_ascii_lowercase()) && (2..=3).contains(&lang.len()) { lang } else { "fa" };

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
    page.push(format!("numbering: {}", q(&pattern)));
    let skip = p.skip_first.unwrap_or(false);
    if let Some(h) = p.header.as_ref().and_then(|h| header_footer(h, &pattern, true, skip, meta, theme.is_rtl())) {
        page.push(format!("header: {h}"));
    }
    if let Some(f) = p.footer.as_ref().and_then(|f| header_footer(f, &pattern, false, skip, meta, theme.is_rtl())) {
        page.push(format!("footer: {f}"));
    }
    o.push_str(&format!("#set page({})\n", page.join(", ")));

    // Body text & paragraphs.
    let body = theme.style("body");
    let mut text = text_args(&body);
    text.push(format!("lang: {}", q(lang)));
    o.push_str(&format!("#set text({})\n", text.join(", ")));
    let mut par = Vec::new();
    if let Some(l) = leading(&body) {
        par.push(format!("leading: {l}"));
    }
    if let Some(s) = body.space_after.as_deref().and_then(length) {
        par.push(format!("spacing: {s}"));
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
        let t = text_args(&st);
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
        if let Some(n) = st.numbering.as_deref().and_then(numbering) {
            o.push_str(&format!("#show {sel}: set heading(numbering: {n})\n"));
        }
        if let Some(a) = st.align.as_deref().and_then(align) {
            o.push_str(&format!("#show {sel}: set align({a})\n"));
        }
        if st.underline == Some(true) {
            o.push_str(&format!("#show {sel}: underline\n"));
        }
        if let Some(c) = st.border.as_deref().and_then(color) {
            o.push_str(&format!(
                "#show {sel}: it => block(width: 100%, stroke: (bottom: 0.8pt + {c}), inset: (bottom: 4pt), it)\n"
            ));
        }
    }

    // Quote.
    let qs = theme.style("quote");
    let qt = text_args(&qs);
    if !qt.is_empty() {
        o.push_str(&format!("#show quote.where(block: true): set text({})\n", qt.join(", ")));
    }
    let qbar = qs.border.as_deref().and_then(color).unwrap_or_else(|| "luma(180)".into());
    let qfill = qs.background.as_deref().and_then(color).unwrap_or_else(|| "none".into());
    o.push_str(&format!(
        "#show quote.where(block: true): it => block(width: 100%, fill: {qfill}, inset: (x: 12pt, y: 8pt), radius: 2pt, stroke: (left: 2.5pt + {qbar}), it.body)\n"
    ));

    // Code: always LTR.
    let cs = theme.style("code");
    let mut ct = text_args(&cs);
    if cs.font.is_none() {
        ct.push("font: (\"DejaVu Sans Mono\", \"Vazirmatn\")".into());
    }
    ct.push("dir: ltr".into());
    o.push_str(&format!("#show raw: set text({})\n", ct.join(", ")));
    let cfill = cs.background.as_deref().and_then(color).unwrap_or_else(|| "luma(245)".into());
    let cstroke = cs.border.as_deref().and_then(color).map(|c| format!("0.5pt + {c}")).unwrap_or_else(|| "none".into());
    o.push_str(&format!(
        "#show raw.where(block: true): it => block(width: 100%, fill: {cfill}, stroke: {cstroke}, inset: 10pt, radius: 4pt, align(left, it))\n"
    ));

    // Links, captions, tables.
    let link = text_args(&theme.style("link"));
    if !link.is_empty() {
        o.push_str(&format!("#show link: set text({})\n", link.join(", ")));
    }
    let cap = text_args(&theme.style("caption"));
    if !cap.is_empty() {
        o.push_str(&format!("#show figure.caption: set text({})\n", cap.join(", ")));
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
    let mut targs = text_args(&ts);
    if targs.iter().all(|a| !a.starts_with("size")) {
        targs.push("size: 2em".into());
    }
    if targs.iter().all(|a| !a.starts_with("weight")) {
        targs.push("weight: \"bold\"".into());
    }
    let talign = ts.align.as_deref().and_then(align).unwrap_or("center");
    let mut o = format!("#align({talign})[\n#text({})[{}]\n", targs.join(", "), super::escape_markup(title));
    if let Some(s) = subtitle {
        let mut sargs = text_args(&ss);
        if sargs.is_empty() {
            sargs.push("size: 1.25em, fill: luma(90)".into());
        }
        o.push_str(&format!("\n#text({})[{}]\n", sargs.join(", "), super::escape_markup(s)));
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

    #[test]
    fn builtin_themes_parse() {
        for (name, yaml) in BUILTIN_THEMES {
            parse_theme(yaml).unwrap_or_else(|e| panic!("theme {name}: {e}"));
        }
    }

    #[test]
    fn merge_overrides_fields_only() {
        let mut base = builtin("default").unwrap();
        let over = parse_theme("styles:\n  h1:\n    color: \"#ff0000\"\n").unwrap();
        let before = base.style("h1");
        base.merge(&over);
        let after = base.style("h1");
        assert_eq!(after.color.as_deref(), Some("#ff0000"));
        assert_eq!(after.size, before.size);
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
        let m = placeholder_markup("Page {page} / {total}", "1");
        assert!(m.contains("counter(page).display(\"1\")"));
        assert!(m.starts_with("#\"Page \""));
    }
}
