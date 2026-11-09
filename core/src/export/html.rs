//! One self-contained HTML file: the theme's styles as CSS, every image,
//! chart and formula embedded (data: URIs), the Persian font embedded when
//! the note has Arabic-script text. Opens anywhere, offline.

use base64::Engine;

use super::model::{Align, Block, Doc, ImageRef, Inline};
use super::{css_color, length_pt, read_asset, text_width_pt, xml_escape as esc, Drawn, Prepared};
use crate::render::md::{self, Dir};
use crate::render::styles::{TextStyle, Theme};

const VAZIR_REGULAR: &[u8] = include_bytes!("../../fonts/Vazirmatn-Regular.ttf");
const VAZIR_BOLD: &[u8] = include_bytes!("../../fonts/Vazirmatn-Bold.ttf");

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn dir_attr(d: Dir) -> &'static str {
    match d {
        Dir::Rtl => "rtl",
        Dir::Ltr => "ltr",
    }
}

fn weight(w: &str) -> String {
    match w {
        "thin" => "100",
        "extralight" => "200",
        "light" => "300",
        "regular" => "400",
        "medium" => "500",
        "semibold" => "600",
        "bold" => "700",
        "extrabold" => "800",
        "black" => "900",
        n if n.chars().all(|c| c.is_ascii_digit()) => n,
        _ => "400",
    }
    .to_string()
}

/// CSS font-family list: the style's font, the Arabic-script one, fallbacks.
fn families(main: Option<&str>, arabic: Option<&str>, mono: bool) -> String {
    let mut f: Vec<String> = vec![];
    if mono {
        // Code: a monospace font before any Arabic-script one.
        if let Some(m) = main {
            f.push(format!("\"{}\"", m.replace('"', "")));
        }
        f.push("ui-monospace, \"DejaVu Sans Mono\", \"Cascadia Mono\", Consolas, monospace, \"Vazirmatn\"".into());
        return f.join(", ");
    }
    if let Some(m) = main {
        f.push(format!("\"{}\"", m.replace('"', "")));
        if m == "New Computer Modern" {
            f.extend(["\"Latin Modern Roman\"", "\"CMU Serif\""].map(String::from));
        }
    }
    f.push(format!("\"{}\"", arabic.unwrap_or("Vazirmatn").replace('"', "")));
    if arabic != Some("Vazirmatn") {
        f.push("\"Vazirmatn\"".into());
    }
    f.push("Georgia, \"Noto Serif\", serif".into());
    let mut seen = std::collections::HashSet::new();
    f.retain(|x| seen.insert(x.clone()));
    f.join(", ")
}

fn arabic_font(st: &TextStyle) -> Option<String> {
    st.fonts.as_ref().and_then(|m| m.get("arabic").cloned()).or_else(|| st.font_fa.clone())
}

/// CSS declarations for a theme style.
fn style_css(t: &Theme, key: &str) -> String {
    let st = t.style(key);
    let body = t.style("body");
    let mut c = vec![];
    if st.font.is_some() || arabic_font(&st).is_some() || key == "body" || key == "code" {
        let main = st.font.clone().or_else(|| if key == "code" { None } else { body.font.clone() });
        let ar = arabic_font(&st).or_else(|| arabic_font(&body));
        c.push(format!("font-family: {}", families(main.as_deref(), ar.as_deref(), key == "code")));
    }
    if let Some(s) = st.size.as_deref().and_then(length_pt) {
        c.push(format!("font-size: {s:.1}pt"));
    }
    if let Some(w) = &st.weight {
        c.push(format!("font-weight: {}", weight(w)));
    }
    if st.italic == Some(true) {
        c.push("font-style: italic".into());
    }
    if st.underline == Some(true) {
        c.push("text-decoration: underline".into());
    }
    if st.smallcaps == Some(true) {
        c.push("font-variant: small-caps".into());
    }
    if let Some(tr) = st.tracking.as_deref().and_then(length_pt) {
        c.push(format!("letter-spacing: {tr:.2}pt"));
    }
    if let Some(col) = st.color.as_deref().and_then(css_color) {
        c.push(format!("color: {col}"));
    }
    if let Some(a) = &st.align {
        c.push(format!("text-align: {a}"));
    }
    if let Some(ls) = st.line_spacing.filter(|f| (0.5..=4.0).contains(f)) {
        c.push(format!("line-height: {:.2}", 1.0 + 0.5 * ls));
    }
    if let Some(b) = st.space_before.as_deref().and_then(length_pt) {
        c.push(format!("margin-top: {b:.1}pt"));
    }
    if let Some(a) = st.space_after.as_deref().and_then(length_pt) {
        c.push(format!("margin-bottom: {a:.1}pt"));
    }
    if let Some(bg) = st.background.as_deref().and_then(css_color) {
        c.push(format!("background: {bg}"));
    }
    c.join("; ")
}

fn css(p: &Prepared, fonts: bool) -> String {
    let t = &p.theme;
    let width = text_width_pt(t);
    let mut o = String::new();
    if fonts {
        o.push_str(&format!(
            "@font-face {{ font-family: \"Vazirmatn\"; font-weight: 100 500; src: url(data:font/ttf;base64,{}) format(\"truetype\"); }}\n@font-face {{ font-family: \"Vazirmatn\"; font-weight: 600 900; src: url(data:font/ttf;base64,{}) format(\"truetype\"); }}\n",
            b64(VAZIR_REGULAR),
            b64(VAZIR_BOLD)
        ));
    }
    let link = t.style("link").color.as_deref().and_then(css_color).unwrap_or_else(|| "#2f5fc4".into());
    let quote_bar = t.style("quote").border.as_deref().and_then(css_color).unwrap_or_else(|| "#7b93d1".into());
    let code_border = t.style("code").border.as_deref().and_then(css_color);
    let indent = t.style("body").indent.as_deref().and_then(length_pt);
    o.push_str(&format!(
        r#":root {{ color-scheme: light; }}
* {{ box-sizing: border-box; }}
html {{ background: #eef0f3; }}
body {{ margin: 0; padding: 32px 16px; color: #1b1d22; line-height: 1.55; {body} }}
main {{ max-width: {width:.0}pt; margin: 0 auto; background: #fff; padding: 56px 64px; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 8px 28px rgba(0,0,0,.06); overflow-wrap: break-word; }}
@media (max-width: 760px) {{ body {{ padding: 0; }} main {{ padding: 24px 16px; border-radius: 0; box-shadow: none; }} }}
@media print {{ html, body {{ background: none; padding: 0; }} main {{ box-shadow: none; padding: 0; max-width: none; }} .pagebreak {{ break-after: page; }} }}
p {{ margin: 0 0 .7em; {indent} }}
h1, h2, h3, h4, h5, h6 {{ line-height: 1.25; margin: 1.2em 0 .5em; }}
h1 {{ {h1} }} h2 {{ {h2} }} h3 {{ {h3} }} h4 {{ {h4} }} h5 {{ {h5} }} h6 {{ {h6} }}
header.title {{ text-align: center; margin-bottom: 2em; }}
header.title h1 {{ margin: 0 0 .3em; {title} }}
header.title .subtitle {{ {subtitle} }}
header.title .meta {{ color: #5b6478; margin-top: .6em; }}
a {{ color: {link}; text-decoration: none; }} a:hover {{ text-decoration: underline; }}
.wikilink {{ color: {link}; }}
blockquote {{ margin: 1em 0; padding: .5em 1em; border-inline-start: 3px solid {quote_bar}; {quote} }}
blockquote > :last-child, .callout > :last-child {{ margin-bottom: 0; }}
.callout {{ margin: 1em 0; padding: .7em 1em; border-inline-start: 3px solid var(--c); background: color-mix(in srgb, var(--c) 9%, white); border-radius: 4px; }}
.callout-title {{ font-weight: 700; color: var(--c); margin-bottom: .3em; }}
pre {{ margin: 1em 0; padding: 10px 12px; border-radius: 4px; white-space: pre-wrap; word-break: break-all; text-align: left; {code}{code_border} }}
code {{ {code_inline} font-size: .92em; }}
pre code {{ font-size: inherit; background: none; padding: 0; }}
:not(pre) > code {{ background: #f3f4f6; padding: .1em .3em; border-radius: 3px; }}
table {{ border-collapse: collapse; margin: 1em auto; max-width: 100%; }}
.table {{ overflow-x: auto; }}
th, td {{ border: 1px solid #d5d8de; padding: 6px 10px; vertical-align: top; }}
th {{ background: #f3f5f8; font-weight: 600; }}
figure {{ margin: 1em 0; text-align: center; }}
figure img, .media img {{ max-width: 100%; height: auto; }}
figcaption {{ margin-top: .4em; {caption} }}
.media {{ margin: 1em 0; text-align: center; }}
img.math {{ display: inline; }}
mark {{ background: #fff3a3; color: inherit; padding: 0 .1em; }}
hr {{ border: none; border-top: 1px solid #c8ccd4; margin: 1.5em 0; }}
ul.tasks {{ list-style: none; padding-inline-start: 1.2em; }}
ul.tasks input {{ margin-inline-end: .45em; }}
.embed {{ border-inline-start: 2px solid #ccd0d8; padding-inline-start: 10px; margin: 1em 0; }}
.error {{ background: #fdecec; border: 1px solid #d13c3c; color: #a02020; padding: 8px 10px; border-radius: 4px; font-size: .9em; }}
nav.toc {{ margin: 1em 0 2em; }} nav.toc ul {{ list-style: none; padding-inline-start: 1.2em; margin: .2em 0; }}
section.footnotes {{ margin-top: 2.5em; border-top: 1px solid #d5d8de; font-size: .9em; }}
sup a {{ text-decoration: none; }}
"#,
        body = style_css(t, "body"),
        indent = indent.map(|i| format!("text-indent: {i:.1}pt;")).unwrap_or_default(),
        h1 = style_css(t, "h1"),
        h2 = style_css(t, "h2"),
        h3 = style_css(t, "h3"),
        h4 = style_css(t, "h4"),
        h5 = style_css(t, "h5"),
        h6 = style_css(t, "h6"),
        title = style_css(t, "title"),
        subtitle = style_css(t, "subtitle"),
        quote = style_css(t, "quote"),
        code = format!("{}; background: {}", style_css(t, "code"), t.style("code").background.as_deref().and_then(css_color).unwrap_or_else(|| "#f5f6f8".into())),
        code_border = code_border.map(|c| format!("; border: 1px solid {c}")).unwrap_or_default(),
        code_inline = format!("font-family: {};", families(t.style("code").font.as_deref(), None, true)),
        caption = style_css(t, "caption"),
    ));
    o
}

struct W<'a> {
    p: &'a Prepared,
    drawn: &'a [Drawn],
    out: String,
    note_links: usize,
}

impl<'a> W<'a> {
    fn doc(&self) -> &Doc {
        &self.p.doc
    }

    fn media_img(&self, id: usize, inline: bool) -> String {
        let Some(d) = self.drawn.get(id) else { return String::new() };
        if let Some(e) = &d.error {
            return format!("<span class=\"error\">{}</span>", esc(e));
        }
        let Some(svg) = &d.svg else { return String::new() };
        let src = format!("data:image/svg+xml;base64,{}", b64(svg.as_bytes()));
        if inline {
            let depth = d.height_pt - d.baseline_pt;
            format!(
                "<img class=\"math\" alt=\"\" src=\"{src}\" style=\"width: {:.2}pt; height: {:.2}pt; vertical-align: -{depth:.2}pt\">",
                d.width_pt, d.height_pt
            )
        } else {
            format!("<img alt=\"\" src=\"{src}\" style=\"width: {:.2}pt\">", d.width_pt)
        }
    }

    fn image(&self, img: &ImageRef) -> String {
        let style = img.width.map(|w| format!(" width=\"{w}\"")).unwrap_or_default();
        let alt = esc(&img.alt);
        if img.url.contains("://") {
            return format!("<img src=\"{}\" alt=\"{alt}\"{style}>", esc(&img.url));
        }
        match img.path.as_deref().and_then(|p| read_asset(self.p.vault.as_deref(), p)) {
            Some((bytes, mime)) => format!("<img src=\"data:{mime};base64,{}\" alt=\"{alt}\"{style}>", b64(&bytes)),
            None => format!("<span class=\"error\">missing image: {}</span>", esc(&img.url)),
        }
    }

    fn inlines(&mut self, inl: &[Inline]) -> String {
        let mut o = String::new();
        for i in inl {
            o.push_str(&self.inline(i));
        }
        o
    }

    fn inline(&mut self, i: &Inline) -> String {
        match i {
            Inline::Text(t) => esc(t),
            Inline::Strong(b) => format!("<strong>{}</strong>", self.inlines(b)),
            Inline::Emph(b) => format!("<em>{}</em>", self.inlines(b)),
            Inline::Strike(b) => format!("<s>{}</s>", self.inlines(b)),
            Inline::Underline(b) => format!("<u>{}</u>", self.inlines(b)),
            Inline::Mark(c, b) => match c.as_deref().and_then(css_color) {
                Some(c) => format!("<mark style=\"background: {c}\">{}</mark>", self.inlines(b)),
                None => format!("<mark>{}</mark>", self.inlines(b)),
            },
            Inline::Sup(b) => format!("<sup>{}</sup>", self.inlines(b)),
            Inline::Sub(b) => format!("<sub>{}</sub>", self.inlines(b)),
            Inline::Code(t) => format!("<code dir=\"ltr\">{}</code>", esc(t)),
            Inline::Link { url, wiki, body } => {
                let body = self.inlines(body);
                if let Some(h) = url.strip_prefix('#') {
                    format!("<a href=\"#{}\">{body}</a>", esc(&md::heading_slug(&crate::render::percent_decode(h))))
                } else if *wiki {
                    // `[[Note#Heading]]` inside this note's text, or another note.
                    self.note_links += 1;
                    format!("<span class=\"wikilink\">{body}</span>")
                } else {
                    format!("<a href=\"{}\">{body}</a>", esc(url))
                }
            }
            Inline::Image(img) => self.image(img),
            Inline::Media(id) => {
                let inline = self.doc().media.get(*id).is_some_and(|m| m.inline);
                if inline {
                    self.media_img(*id, true)
                } else {
                    format!("<span class=\"media\" style=\"display: block\">{}</span>", self.media_img(*id, false))
                }
            }
            Inline::Span { attrs, body } => {
                let body = self.inlines(body);
                span(attrs, body)
            }
            Inline::FootnoteRef(l) => match self.doc().footnote_number(l) {
                Some(n) => format!("<sup id=\"fnref-{n}\"><a href=\"#fn-{n}\">{n}</a></sup>"),
                None => format!("[^{}]", esc(l)),
            },
            Inline::Break => "<br>".into(),
        }
    }

    fn blocks(&mut self, bl: &[Block]) {
        for b in bl {
            self.block(b);
        }
    }

    fn block(&mut self, b: &Block) {
        match b {
            Block::Heading { level, id, dir, body } => {
                let body = self.inlines(body);
                self.out.push_str(&format!("<h{level} id=\"{}\" dir=\"{}\">{body}</h{level}>\n", esc(id), dir_attr(*dir)));
            }
            Block::Para { dir, body } => {
                let body = self.inlines(body);
                self.out.push_str(&format!("<p dir=\"{}\">{body}</p>\n", dir_attr(*dir)));
            }
            Block::List { ordered, start, items } => {
                let tasks = items.iter().any(|i| i.task.is_some());
                let tag = if *ordered { "ol" } else { "ul" };
                let start = if *ordered && *start != 1 { format!(" start=\"{start}\"") } else { String::new() };
                let class = if tasks { " class=\"tasks\"" } else { "" };
                self.out.push_str(&format!("<{tag}{start}{class}>\n"));
                for it in items {
                    self.out.push_str(&format!("<li dir=\"{}\">", dir_attr(it.dir)));
                    if let Some(done) = it.task {
                        self.out.push_str(&format!("<input type=\"checkbox\" disabled{}>", if done { " checked" } else { "" }));
                    }
                    // A tight item's single paragraph is written without <p>.
                    match it.blocks.as_slice() {
                        [Block::Para { body, .. }] => {
                            let body = self.inlines(body);
                            self.out.push_str(&body);
                        }
                        bl => self.blocks(bl),
                    }
                    self.out.push_str("</li>\n");
                }
                self.out.push_str(&format!("</{tag}>\n"));
            }
            Block::Quote { blocks } => {
                self.out.push_str("<blockquote>\n");
                self.blocks(blocks);
                self.out.push_str("</blockquote>\n");
            }
            Block::Callout { kind, color, title, dir, blocks } => {
                let title = self.inlines(title);
                self.out.push_str(&format!(
                    "<div class=\"callout callout-{}\" dir=\"{}\" style=\"--c: {color}\"><div class=\"callout-title\">{title}</div>\n",
                    esc(kind),
                    dir_attr(*dir)
                ));
                self.blocks(blocks);
                self.out.push_str("</div>\n");
            }
            Block::Code { lang, text } => {
                let class = if lang.is_empty() { String::new() } else { format!(" class=\"language-{}\"", esc(lang)) };
                self.out.push_str(&format!("<pre dir=\"ltr\"><code{class}>{}</code></pre>\n", esc(text)));
            }
            Block::Table { dir, aligns, head, rows } => {
                let al = |c: usize| match aligns.get(c) {
                    Some(Align::Left) => " style=\"text-align: left\"",
                    Some(Align::Center) => " style=\"text-align: center\"",
                    Some(Align::Right) => " style=\"text-align: right\"",
                    _ => "",
                };
                self.out.push_str(&format!("<div class=\"table\"><table dir=\"{}\">\n", dir_attr(*dir)));
                if !head.is_empty() {
                    self.out.push_str("<thead><tr>");
                    for (c, cell) in head.iter().enumerate() {
                        let s = self.inlines(cell);
                        self.out.push_str(&format!("<th{}>{s}</th>", al(c)));
                    }
                    self.out.push_str("</tr></thead>\n");
                }
                self.out.push_str("<tbody>\n");
                let cols = aligns.len().max(head.len());
                for r in rows {
                    self.out.push_str("<tr>");
                    for c in 0..cols.max(r.len()) {
                        let s = r.get(c).map(|cell| self.inlines(cell)).unwrap_or_default();
                        self.out.push_str(&format!("<td{}>{s}</td>", al(c)));
                    }
                    self.out.push_str("</tr>\n");
                }
                self.out.push_str("</tbody></table></div>\n");
            }
            Block::Rule => self.out.push_str("<hr>\n"),
            Block::PageBreak => self.out.push_str("<div class=\"pagebreak\"></div>\n"),
            Block::Toc => {
                let toc = self.toc();
                self.out.push_str(&toc);
            }
            Block::Div { attrs, blocks } => {
                let (style, dir) = div_style(attrs);
                self.out.push_str(&format!("<div{dir} style=\"{style}\">\n"));
                self.blocks(blocks);
                self.out.push_str("</div>\n");
            }
            Block::Media { id, caption } => {
                let img = self.media_img(*id, false);
                self.out.push_str(&format!("<div class=\"media\">{img}"));
                if let Some(c) = caption {
                    self.out.push_str(&format!("<figcaption>{}</figcaption>", esc(c)));
                }
                self.out.push_str("</div>\n");
            }
            Block::Figure { image, caption } => {
                let img = self.image(image);
                self.out.push_str(&format!("<figure>{img}"));
                if let Some(c) = caption {
                    self.out.push_str(&format!("<figcaption>{}</figcaption>", esc(c)));
                }
                self.out.push_str("</figure>\n");
            }
            Block::Embed { blocks } => {
                self.out.push_str("<div class=\"embed\">\n");
                self.blocks(blocks);
                self.out.push_str("</div>\n");
            }
            Block::VSpace(n) => self.out.push_str(&format!("<div style=\"height: {:.2}em\"></div>\n", *n as f64 * 1.55)),
            Block::Error(m) => self.out.push_str(&format!("<div class=\"error\" dir=\"ltr\">{}</div>\n", esc(m))),
        }
    }

    fn toc(&self) -> String {
        let mut o = String::from("<nav class=\"toc\"><ul>\n");
        for (level, id, text) in &self.doc().headings {
            if *level <= 3 {
                o.push_str(&format!(
                    "<li style=\"margin-inline-start: {}em\" dir=\"auto\"><a href=\"#{}\">{}</a></li>\n",
                    (*level as f64 - 1.0) * 1.2,
                    esc(id),
                    esc(text)
                ));
            }
        }
        o.push_str("</ul></nav>\n");
        o
    }
}

pub(crate) fn span(attrs: &[(String, String)], body: String) -> String {
    let mut st = vec![];
    let mut dir = String::new();
    let mut block = false;
    for (k, v) in attrs {
        match k.as_str() {
            "color" => {
                if let Some(c) = css_color(v) {
                    st.push(format!("color: {c}"))
                }
            }
            "size" => {
                if let Some(s) = length_pt(v) {
                    st.push(format!("font-size: {s:.1}pt"))
                }
            }
            "font" if !v.is_empty() => st.push(format!("font-family: {}", families(Some(v), None, false))),
            "bold" => st.push("font-weight: 700".into()),
            "weight" => st.push(format!("font-weight: {}", weight(v))),
            "italic" => st.push("font-style: italic".into()),
            "underline" => st.push("text-decoration: underline".into()),
            "strike" => st.push("text-decoration: line-through".into()),
            "highlight" | "bg" => st.push(format!("background: {}", css_color(v).unwrap_or_else(|| "#fff3a3".into()))),
            "align" if matches!(v.as_str(), "left" | "right" | "center" | "start" | "end") => {
                block = true;
                st.push(format!("display: block; text-align: {v}"));
            }
            "dir" if v == "rtl" || v == "ltr" => dir = format!(" dir=\"{v}\""),
            _ => {}
        }
    }
    if dir.is_empty() && st.is_empty() && !block {
        return body;
    }
    format!("<span{dir} style=\"{}\">{body}</span>", esc(&st.join("; ")))
}

pub(crate) fn div_style(attrs: &[(String, String)]) -> (String, String) {
    let mut st = vec![];
    let mut dir = String::new();
    for (k, v) in attrs {
        match (k.as_str(), v.as_str()) {
            ("align", a @ ("left" | "right" | "center" | "start" | "end" | "justify")) => st.push(format!("text-align: {a}")),
            ("columns", n) => {
                if let Ok(n) = n.parse::<u32>() {
                    if (2..=4).contains(&n) {
                        st.push(format!("column-count: {n}; column-gap: 2em"));
                    }
                }
            }
            ("box", c) => {
                let c = css_color(c).unwrap_or_else(|| "#7b93d1".into());
                st.push(format!("border: 1px solid {c}; background: color-mix(in srgb, {c} 8%, white); padding: 10px 14px; border-radius: 4px; margin: 1em 0"));
            }
            ("color", c) => {
                if let Some(c) = css_color(c) {
                    st.push(format!("color: {c}"))
                }
            }
            ("size", s) => {
                if let Some(s) = length_pt(s) {
                    st.push(format!("font-size: {s:.1}pt"))
                }
            }
            ("font", f) if !f.is_empty() => st.push(format!("font-family: {}", families(Some(f), None, false))),
            ("bold", _) => st.push("font-weight: 700".into()),
            ("weight", w) => st.push(format!("font-weight: {}", weight(w))),
            ("italic", _) => st.push("font-style: italic".into()),
            ("dir", d @ ("rtl" | "ltr")) => dir = format!(" dir=\"{d}\""),
            ("lang", l) => {
                if let Some(l) = crate::render::script::normalize_lang(l) {
                    let d = if crate::render::script::is_rtl_lang(&l) { "rtl" } else { "ltr" };
                    dir = format!(" dir=\"{d}\" lang=\"{}\"", esc(&l));
                }
            }
            _ => {}
        }
    }
    (esc(&st.join("; ")), dir)
}

/// The whole HTML file. Returns (html, warnings).
pub fn write(p: &Prepared, drawn: &[Drawn]) -> (String, Vec<String>) {
    let fonts = super::model::has_rtl(&p.body) || p.base == Dir::Rtl;
    let mut w = W { p, drawn, out: String::new(), note_links: 0 };
    let fm = &p.fm;
    if let Some(title) = &fm.title {
        w.out.push_str(&format!("<header class=\"title\" dir=\"auto\"><h1>{}</h1>", esc(title)));
        if let Some(s) = &fm.subtitle {
            w.out.push_str(&format!("<div class=\"subtitle\">{}</div>", esc(s)));
        }
        let meta: Vec<&str> = [fm.author.as_deref(), fm.date.as_deref()].into_iter().flatten().collect();
        if !meta.is_empty() {
            w.out.push_str(&format!("<div class=\"meta\">{}</div>", esc(&meta.join(" · "))));
        }
        w.out.push_str("</header>\n");
    }
    if fm.toc == Some(true) {
        let toc = w.toc();
        w.out.push_str(&toc);
    }
    let blocks = p.doc.blocks.clone();
    w.blocks(&blocks);
    if !p.doc.footnotes.is_empty() {
        w.out.push_str("<section class=\"footnotes\"><ol>\n");
        let notes = p.doc.footnotes.clone();
        for (i, (_, bl)) in notes.iter().enumerate() {
            let n = i + 1;
            let dir = match bl.first() {
                Some(Block::Para { dir, .. }) => dir_attr(*dir),
                _ => dir_attr(p.base),
            };
            w.out.push_str(&format!("<li id=\"fn-{n}\" dir=\"{dir}\">"));
            match bl.as_slice() {
                [Block::Para { body, .. }] => {
                    let s = w.inlines(body);
                    w.out.push_str(&s);
                }
                _ => w.blocks(bl),
            }
            w.out.push_str(&format!(" <a href=\"#fnref-{n}\">↩</a></li>\n"));
        }
        w.out.push_str("</ol></section>\n");
    }
    let title = fm.title.clone().unwrap_or_else(|| {
        let name = p.note.rsplit('/').next().unwrap_or(&p.note);
        name.trim_end_matches(".md").to_string()
    });
    let mut warnings = vec![];
    if w.note_links > 0 {
        warnings.push(format!(
            "{} link{} to other notes became plain text (the HTML file has only this note)",
            w.note_links,
            if w.note_links == 1 { "" } else { "s" }
        ));
    }
    let failed = drawn.iter().filter(|d| d.error.is_some()).count();
    if failed > 0 {
        warnings.push(format!("{failed} chart/diagram/formula could not be drawn"));
    }
    let author = fm.author.as_deref().map(|a| format!("<meta name=\"author\" content=\"{}\">\n", esc(a))).unwrap_or_default();
    let html = format!(
        "<!doctype html>\n<html lang=\"{lang}\" dir=\"{dir}\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"generator\" content=\"NoteZ\">\n{author}<title>{title}</title>\n<style>\n{css}</style>\n</head>\n<body>\n<main>\n{body}</main>\n</body>\n</html>\n",
        lang = esc(&p.lang),
        dir = dir_attr(p.base),
        title = esc(&title),
        css = css(p, fonts),
        body = w.out,
    );
    (html, warnings)
}
