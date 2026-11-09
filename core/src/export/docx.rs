//! Word (.docx) export, written as WordprocessingML by hand (no Word, pandoc
//! or LibreOffice needed). What maps to what:
//!
//! - theme styles → Word styles (Normal, Title, Heading 1–6 with outline
//!   levels, Quote, Code, Caption, Hyperlink, footnotes), Persian/Arabic text
//!   in the complex-script font slot
//! - right-to-left paragraphs/runs/tables → `w:bidi` / `w:rtl` /
//!   `w:bidiVisual`, decided by the same rule as the PDF
//! - footnotes → real Word footnotes; `<!-- toc -->` / `toc: true` → a Word
//!   table of contents (filled in, and updated with page numbers by Word)
//! - charts, diagrams, math, PDF pages, SVG images → PNG drawn by the PDF engine
//! - page size, orientation, margins, header/footer page numbers → the section

use std::collections::HashMap;
use std::io::Write;

use super::model::{Align, Block, ImageRef, Inline, MediaSrc};
use super::{css_color, length_pt, margins_pt, page_size_pt, read_asset, text_width_pt, xml_escape as esc, Drawn, Prepared};
use crate::render::md::Dir;
use crate::render::script::is_rtl_char;
use crate::render::styles::{TextStyle, Theme};

type Res<T> = Result<T, String>;

const EMU_PER_PT: f64 = 12700.0;
const W_NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture""#;

/// Images Word shows natively; others are drawn to PNG first.
fn word_image(path: &str) -> bool {
    let e = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    matches!(e.as_str(), "png" | "jpg" | "jpeg" | "gif" | "bmp")
}

/// Turn SVG/WebP/AVIF images into media items (drawn to PNG with the rest).
pub fn convert_images(p: &mut Prepared) {
    fn typst_for(img: &ImageRef) -> Option<String> {
        let path = img.path.as_deref()?;
        if word_image(path) {
            return None;
        }
        let w = img.width.map(|px| format!("{:.1}pt", px * 0.75)).unwrap_or_else(|| "auto".into());
        Some(format!("#image({}, width: {w})", crate::render::typst_str(&format!("/{path}"))))
    }
    fn inl(v: &mut [Inline], media: &mut Vec<MediaSrc>) {
        for i in v.iter_mut() {
            match i {
                Inline::Image(img) => {
                    if let Some(t) = typst_for(img) {
                        media.push(MediaSrc { typst: t, packages: vec![], inline: false, tight: true });
                        *i = Inline::Media(media.len() - 1);
                    }
                }
                Inline::Strong(b)
                | Inline::Emph(b)
                | Inline::Strike(b)
                | Inline::Underline(b)
                | Inline::Mark(_, b)
                | Inline::Sup(b)
                | Inline::Sub(b)
                | Inline::Link { body: b, .. }
                | Inline::Span { body: b, .. } => inl(b, media),
                _ => {}
            }
        }
    }
    fn blocks(v: &mut [Block], media: &mut Vec<MediaSrc>) {
        for b in v.iter_mut() {
            match b {
                Block::Figure { image, caption } => {
                    if let Some(t) = typst_for(image) {
                        media.push(MediaSrc { typst: t, packages: vec![], inline: false, tight: true });
                        *b = Block::Media { id: media.len() - 1, caption: caption.clone() };
                    }
                }
                Block::Para { body, .. } | Block::Heading { body, .. } => inl(body, media),
                Block::Callout { title, blocks: bl, .. } => {
                    inl(title, media);
                    blocks(bl, media)
                }
                Block::Quote { blocks: bl } | Block::Div { blocks: bl, .. } | Block::Embed { blocks: bl } => blocks(bl, media),
                Block::List { items, .. } => items.iter_mut().for_each(|i| blocks(&mut i.blocks, media)),
                Block::Table { head, rows, .. } => {
                    head.iter_mut().for_each(|c| inl(c, media));
                    rows.iter_mut().flatten().for_each(|c| inl(c, media));
                }
                _ => {}
            }
        }
    }
    let mut media = std::mem::take(&mut p.doc.media);
    blocks(&mut p.doc.blocks, &mut media);
    for (_, bl) in p.doc.footnotes.iter_mut() {
        blocks(bl, &mut media);
    }
    p.doc.media = media;
}

// ------------------------------------------------------------------ helpers

fn hex(c: &str) -> Option<String> {
    css_color(c).map(|h| h.trim_start_matches('#').to_uppercase())
}

/// `color` mixed with white (`t` = share of white), as RRGGBB.
fn tint(color: &str, t: f64) -> String {
    let h = hex(color).unwrap_or_else(|| "2F6FDE".into());
    let v = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).unwrap_or(0) as f64;
    let m = |x: f64| (x + (255.0 - x) * t).round() as u8;
    format!("{:02X}{:02X}{:02X}", m(v(0)), m(v(2)), m(v(4)))
}

fn half_points(size: &str) -> Option<u32> {
    length_pt(size).map(|pt| (pt * 2.0).round() as u32)
}

fn twips(pt: f64) -> i64 {
    (pt * 20.0).round() as i64
}

/// Fonts Typst bundles but Word users rarely have.
fn word_font(f: &str) -> String {
    match f {
        "New Computer Modern" | "Latin Modern Roman" => "Cambria".into(),
        "New Computer Modern Sans" => "Calibri".into(),
        "New Computer Modern Mono" | "DejaVu Sans Mono" => "Consolas".into(),
        "Libertinus Serif" => "Cambria".into(),
        f => f.into(),
    }
}

fn arabic_font(st: &TextStyle) -> Option<String> {
    st.fonts.as_ref().and_then(|m| m.get("arabic").cloned()).or_else(|| st.font_fa.clone())
}

fn bold_weight(w: &str) -> bool {
    matches!(w, "semibold" | "bold" | "extrabold" | "black") || w.parse::<u32>().is_ok_and(|n| n >= 600)
}

/// `w:jc` for an alignment. In a right-to-left paragraph Word reads
/// left/right relative to the reading direction, so they are swapped.
fn jc(align: &str, dir: Dir) -> Option<&'static str> {
    let rtl = dir == Dir::Rtl;
    Some(match align {
        "center" => "center",
        "justify" => "both",
        "left" => {
            if rtl {
                "right"
            } else {
                "left"
            }
        }
        "right" => {
            if rtl {
                "left"
            } else {
                "right"
            }
        }
        "end" => "right",
        _ => return None,
    })
}

fn word_lang(l: &str) -> String {
    match l.split(['-', '_']).next().unwrap_or(l) {
        "fa" => "fa-IR",
        "ar" => "ar-SA",
        "he" => "he-IL",
        "ur" => "ur-PK",
        "en" => "en-US",
        "de" => "de-DE",
        "fr" => "fr-FR",
        _ => return l.to_string(),
    }
    .into()
}

/// Split text where it changes between right-to-left script and the rest
/// (neutral characters stay with the run they follow).
fn script_runs(t: &str) -> Vec<(String, bool)> {
    let mut out: Vec<(String, bool)> = vec![];
    for c in t.chars() {
        let rtl = if is_rtl_char(c) {
            Some(true)
        } else if c.is_alphabetic() {
            Some(false)
        } else {
            None
        };
        match (out.last_mut(), rtl) {
            (Some((s, r)), Some(x)) if *r == x => s.push(c),
            (Some((s, _)), None) => s.push(c),
            (_, Some(x)) => out.push((c.to_string(), x)),
            (None, None) => out.push((c.to_string(), false)),
        }
    }
    out
}

// ------------------------------------------------------------------ runs

#[derive(Clone, Default)]
struct RunFmt {
    style: Option<&'static str>,
    font: Option<String>,
    bold: bool,
    italic: bool,
    smallcaps: bool,
    strike: bool,
    color: Option<String>,
    size: Option<u32>,
    underline: bool,
    shade: Option<String>,
    sup: bool,
    sub: bool,
    /// Lower the run by this many half-points (inline math).
    position: Option<i64>,
}

impl RunFmt {
    fn rpr(&self, rtl: bool) -> String {
        let mut o = String::new();
        if let Some(s) = self.style {
            o.push_str(&format!("<w:rStyle w:val=\"{s}\"/>"));
        }
        if let Some(f) = &self.font {
            let f = esc(&word_font(f));
            o.push_str(&format!("<w:rFonts w:ascii=\"{f}\" w:hAnsi=\"{f}\" w:eastAsia=\"{f}\"/>"));
        }
        if self.bold {
            o.push_str("<w:b/><w:bCs/>");
        }
        if self.italic {
            o.push_str("<w:i/><w:iCs/>");
        }
        if self.smallcaps {
            o.push_str("<w:smallCaps/>");
        }
        if self.strike {
            o.push_str("<w:strike/>");
        }
        if let Some(c) = &self.color {
            o.push_str(&format!("<w:color w:val=\"{c}\"/>"));
        }
        if let Some(p) = self.position {
            o.push_str(&format!("<w:position w:val=\"{p}\"/>"));
        }
        if let Some(s) = self.size {
            o.push_str(&format!("<w:sz w:val=\"{s}\"/><w:szCs w:val=\"{s}\"/>"));
        }
        if self.underline {
            o.push_str("<w:u w:val=\"single\"/>");
        }
        if let Some(f) = &self.shade {
            o.push_str(&format!("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{f}\"/>"));
        }
        if self.sup {
            o.push_str("<w:vertAlign w:val=\"superscript\"/>");
        } else if self.sub {
            o.push_str("<w:vertAlign w:val=\"subscript\"/>");
        }
        if rtl {
            o.push_str("<w:rtl/>");
        }
        if o.is_empty() {
            o
        } else {
            format!("<w:rPr>{o}</w:rPr>")
        }
    }

    /// Apply `[text]{attrs}` / `::: {attrs}` text attributes.
    fn with_attrs(mut self, attrs: &[(String, String)]) -> Self {
        for (k, v) in attrs {
            match k.as_str() {
                "color" => self.color = hex(v).or(self.color),
                "size" => self.size = half_points(v).or(self.size),
                "font" if !v.is_empty() => self.font = Some(v.clone()),
                "bold" => self.bold = true,
                "weight" => self.bold = bold_weight(v),
                "italic" => self.italic = true,
                "underline" => self.underline = true,
                "strike" => self.strike = true,
                "highlight" | "bg" => self.shade = Some(hex(v).unwrap_or_else(|| "FFF3A3".into())),
                _ => {}
            }
        }
        self
    }
}

fn text_runs(t: &str, f: &RunFmt) -> String {
    let mut o = String::new();
    for (seg, rtl) in script_runs(t) {
        o.push_str(&format!("<w:r>{}<w:t xml:space=\"preserve\">{}</w:t></w:r>", f.rpr(rtl), esc(&seg)));
    }
    o
}

// ------------------------------------------------------------------ writer

struct Para<'a> {
    style: Option<&'a str>,
    dir: Dir,
    align: Option<&'static str>,
    /// numId, ilvl
    num: Option<(usize, usize)>,
    /// Left (start) indent in twips.
    indent: Option<i64>,
    keep_next: bool,
    /// The first line hangs out by one list-number width.
    hanging: bool,
    borders: Option<String>,
    shade: Option<String>,
    spacing: Option<String>,
}

impl Default for Para<'_> {
    fn default() -> Self {
        Para { style: None, dir: Dir::Ltr, align: None, num: None, indent: None, keep_next: false, hanging: false, borders: None, shade: None, spacing: None }
    }
}

impl Para<'_> {
    fn ppr(&self) -> String {
        let mut o = String::new();
        if let Some(s) = self.style {
            o.push_str(&format!("<w:pStyle w:val=\"{s}\"/>"));
        }
        if self.keep_next {
            o.push_str("<w:keepNext/>");
        }
        if let Some((id, lvl)) = self.num {
            o.push_str(&format!("<w:numPr><w:ilvl w:val=\"{lvl}\"/><w:numId w:val=\"{id}\"/></w:numPr>"));
        }
        let rtl = self.dir == Dir::Rtl;
        if let Some(b) = &self.borders {
            // A side bar sits at the start of the line: the right in RTL.
            let b = if rtl && !b.contains("<w:right ") { b.replace("<w:left ", "<w:right ") } else { b.clone() };
            o.push_str(&format!("<w:pBdr>{b}</w:pBdr>"));
        }
        if let Some(f) = &self.shade {
            o.push_str(&format!("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{f}\"/>"));
        }
        if self.dir == Dir::Rtl {
            o.push_str("<w:bidi/>");
        }
        if let Some(s) = &self.spacing {
            o.push_str(s);
        }
        if let Some(i) = self.indent {
            let side = if rtl { "right" } else { "left" };
            let hang = if self.hanging { " w:hanging=\"360\"" } else { " w:firstLine=\"0\"" };
            o.push_str(&format!("<w:ind w:{side}=\"{i}\"{hang}/>"));
        }
        if let Some(a) = self.align {
            o.push_str(&format!("<w:jc w:val=\"{a}\"/>"));
        }
        format!("<w:pPr>{o}</w:pPr>")
    }
}

/// Context that applies to paragraphs inside quotes, callouts, divs, lists.
#[derive(Clone, Default)]
struct Ctx {
    run: RunFmt,
    indent: i64,
    /// pBdr + shade for every paragraph (box divs, quotes, embeds).
    borders: Option<String>,
    shade: Option<String>,
    align: Option<String>,
    style: Option<&'static str>,
}

struct W<'a> {
    p: &'a Prepared,
    drawn: &'a [Drawn],
    body: String,
    rels: Vec<(String, String, bool)>, // (target, type, external)
    media_files: Vec<(String, Vec<u8>)>,
    next_rel: usize,
    next_pic: usize,
    next_bm: usize,
    bookmarks: HashMap<String, String>,
    nums: Vec<(usize, u64)>, // (abstractNumId, start) per numId-2
    footnotes: Vec<String>,
    note_links: usize,
    text_width: f64,
    in_footnote: bool,
}

impl<'a> W<'a> {
    fn rel(&mut self, target: String, kind: &str, external: bool) -> String {
        if let Some(i) = self.rels.iter().position(|(t, k, _)| *t == target && k == kind) {
            return format!("rId{}", i + 10);
        }
        self.rels.push((target, kind.to_string(), external));
        format!("rId{}", self.rels.len() + 9)
    }

    fn picture(&mut self, png: Vec<u8>, ext: &str, w_pt: f64, h_pt: f64, alt: &str) -> String {
        self.next_pic += 1;
        let n = self.next_pic;
        let name = format!("image{n}.{ext}");
        self.media_files.push((name.clone(), png));
        let rid = self.rel(format!("media/{name}"), "image", false);
        let (cx, cy) = ((w_pt * EMU_PER_PT) as i64, (h_pt * EMU_PER_PT) as i64);
        format!(
            "<w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:docPr id=\"{n}\" name=\"Picture {n}\" descr=\"{alt}\"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic><pic:nvPicPr><pic:cNvPr id=\"{n}\" name=\"{name}\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"{rid}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>",
            alt = esc(alt)
        )
    }

    /// A drawn media item as a run (None if it failed).
    fn media_run(&mut self, id: usize, f: &RunFmt) -> String {
        let Some(d) = self.drawn.get(id).cloned() else { return String::new() };
        let inline = self.p.doc.media.get(id).is_some_and(|m| m.inline);
        match d.png {
            Some(png) if !png.is_empty() => {
                let scale = (self.text_width / d.width_pt).min(1.0);
                let (w, h) = (d.width_pt * scale, d.height_pt * scale);
                let mut rf = RunFmt::default();
                if inline {
                    rf.position = Some(-((d.height_pt - d.baseline_pt) * 2.0).round() as i64);
                }
                let pic = self.picture(png, "png", w, h, "");
                format!("<w:r>{}{pic}</w:r>", rf.rpr(false))
            }
            _ => {
                let mut ef = f.clone();
                ef.color = Some("A02020".into());
                text_runs(&format!("[{}]", d.error.unwrap_or_else(|| "could not draw".into())), &ef)
            }
        }
    }

    fn image_run(&mut self, img: &ImageRef, f: &RunFmt) -> String {
        let data = img.path.as_deref().and_then(|p| read_asset(self.p.vault.as_deref(), p));
        let Some((bytes, _)) = data else {
            let mut ef = f.clone();
            ef.color = Some("A02020".into());
            return text_runs(&format!("[missing image: {}]", img.url), &ef);
        };
        let ext = img.path.as_deref().and_then(|p| p.rsplit_once('.')).map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_else(|| "png".into());
        let ext = if ext == "jpg" { "jpeg".to_string() } else { ext };
        let (pw, ph) = imagesize::blob_size(&bytes).map(|s| (s.width as f64, s.height as f64)).unwrap_or((400.0, 300.0));
        // Pixels at 96 dpi; a `|300` width wins; never wider than the text.
        let mut w = img.width.unwrap_or(pw) * 0.75;
        let mut h = w * ph / pw.max(1.0);
        if w > self.text_width {
            h *= self.text_width / w;
            w = self.text_width;
        }
        let pic = self.picture(bytes, &ext, w, h, &img.alt);
        format!("<w:r>{pic}</w:r>")
    }

    fn inlines(&mut self, v: &[Inline], f: &RunFmt) -> String {
        let mut o = String::new();
        for i in v {
            o.push_str(&self.inline(i, f));
        }
        o
    }

    fn inline(&mut self, i: &Inline, f: &RunFmt) -> String {
        let with = |g: fn(&mut RunFmt)| {
            let mut x = f.clone();
            g(&mut x);
            x
        };
        match i {
            Inline::Text(t) => text_runs(t, f),
            Inline::Strong(b) => self.inlines(b, &with(|x| x.bold = true)),
            Inline::Emph(b) => self.inlines(b, &with(|x| x.italic = true)),
            Inline::Strike(b) => self.inlines(b, &with(|x| x.strike = true)),
            Inline::Underline(b) => self.inlines(b, &with(|x| x.underline = true)),
            Inline::Mark(c, b) => {
                let mut x = f.clone();
                x.shade = Some(c.as_deref().and_then(hex).unwrap_or_else(|| "FFF3A3".into()));
                self.inlines(b, &x)
            }
            Inline::Sup(b) => self.inlines(b, &with(|x| x.sup = true)),
            Inline::Sub(b) => self.inlines(b, &with(|x| x.sub = true)),
            Inline::Code(t) => {
                let mut x = f.clone();
                x.style = Some("NzCodeChar");
                format!("<w:r>{}<w:t xml:space=\"preserve\">{}</w:t></w:r>", x.rpr(false), esc(t))
            }
            Inline::Link { url, wiki, body } => {
                let mut x = f.clone();
                x.style = Some("Hyperlink");
                let runs = self.inlines(body, &x);
                if let Some(h) = url.strip_prefix('#') {
                    let slug = crate::render::md::heading_slug(&crate::render::percent_decode(h));
                    match self.bookmarks.get(&slug) {
                        Some(bm) => format!("<w:hyperlink w:anchor=\"{bm}\">{runs}</w:hyperlink>"),
                        None => runs,
                    }
                } else if *wiki {
                    self.note_links += 1;
                    runs
                } else {
                    let rid = self.rel(url.clone(), "hyperlink", true);
                    format!("<w:hyperlink r:id=\"{rid}\">{runs}</w:hyperlink>")
                }
            }
            Inline::Image(img) => self.image_run(img, f),
            Inline::Media(id) => self.media_run(*id, f),
            Inline::Span { attrs, body } => {
                let x = f.clone().with_attrs(attrs);
                self.inlines(body, &x)
            }
            Inline::FootnoteRef(l) => match self.p.doc.footnote_number(l) {
                Some(n) if !self.in_footnote => {
                    format!("<w:r><w:rPr><w:rStyle w:val=\"FootnoteReference\"/></w:rPr><w:footnoteReference w:id=\"{n}\"/></w:r>")
                }
                _ => text_runs(&format!("[{l}]"), f),
            },
            Inline::Break => "<w:r><w:br/></w:r>".into(),
        }
    }

    fn para(&mut self, mut p: Para, ctx: &Ctx, runs: &str) {
        if p.indent.is_none() && ctx.indent > 0 {
            p.indent = Some(ctx.indent);
        }
        if p.borders.is_none() {
            p.borders = ctx.borders.clone();
        }
        if p.shade.is_none() {
            p.shade = ctx.shade.clone();
        }
        if p.style.is_none() {
            p.style = ctx.style;
        }
        if p.align.is_none() {
            if let Some(a) = &ctx.align {
                p.align = jc(a, p.dir);
            }
        }
        self.body.push_str(&format!("<w:p>{}{runs}</w:p>\n", p.ppr()));
    }

    fn new_num(&mut self, ordered: bool, start: u64) -> usize {
        self.nums.push((if ordered { 1 } else { 0 }, start));
        self.nums.len() + 1
    }

    fn blocks(&mut self, v: &[Block], ctx: &Ctx, list: Option<usize>) {
        for b in v {
            self.block(b, ctx, list);
        }
    }

    /// `list`: the nesting level when inside a list item.
    fn block(&mut self, b: &Block, ctx: &Ctx, list: Option<usize>) {
        match b {
            Block::Heading { level, id, dir, body } => {
                let runs = self.inlines(body, &ctx.run);
                let bm = self.bookmarks.get(id).cloned();
                let runs = match bm {
                    Some(bm) => {
                        self.next_bm += 1;
                        let n = self.next_bm;
                        format!("<w:bookmarkStart w:id=\"{n}\" w:name=\"{bm}\"/>{runs}<w:bookmarkEnd w:id=\"{n}\"/>")
                    }
                    None => runs,
                };
                let style = ["Heading1", "Heading2", "Heading3", "Heading4", "Heading5", "Heading6"][(*level as usize).clamp(1, 6) - 1];
                self.para(Para { style: Some(style), dir: *dir, ..Default::default() }, &Ctx { style: None, ..ctx.clone() }, &runs);
            }
            Block::Para { dir, body } => {
                let runs = self.inlines(body, &ctx.run);
                self.para(Para { dir: *dir, ..Default::default() }, ctx, &runs);
            }
            Block::List { ordered, start, items } => {
                let level = list.map(|l| l + 1).unwrap_or(0).min(8);
                let tasks = items.iter().any(|i| i.task.is_some());
                let num = if tasks { None } else { Some(self.new_num(*ordered, *start)) };
                for it in items {
                    let mut first = true;
                    for blk in &it.blocks {
                        match blk {
                            Block::Para { dir, body } => {
                                let mut runs = String::new();
                                if first {
                                    if let Some(done) = it.task {
                                        runs.push_str(&text_runs(if done { "☑ " } else { "☐ " }, &ctx.run));
                                    }
                                }
                                runs.push_str(&self.inlines(body, &ctx.run));
                                let indent = 360 * (level as i64 + 1) + ctx.indent;
                                let p = Para {
                                    style: Some("ListParagraph"),
                                    dir: *dir,
                                    num: if first { num.map(|n| (n, level)) } else { None },
                                    indent: Some(indent),
                                    hanging: first && num.is_some(),
                                    ..Default::default()
                                };
                                self.para(p, ctx, &runs);
                            }
                            Block::List { .. } => self.block(blk, ctx, Some(level)),
                            other => {
                                let c = Ctx { indent: 360 * (level as i64 + 1) + ctx.indent, ..ctx.clone() };
                                self.block(other, &c, Some(level));
                            }
                        }
                        first = false;
                    }
                }
            }
            Block::Quote { blocks } => {
                let bar = self.p.theme.style("quote").border.as_deref().and_then(hex).unwrap_or_else(|| "7B93D1".into());
                let shade = self.p.theme.style("quote").background.as_deref().and_then(hex);
                let c = Ctx {
                    indent: ctx.indent + 240,
                    borders: Some(format!("<w:left w:val=\"single\" w:sz=\"18\" w:space=\"8\" w:color=\"{bar}\"/>")),
                    shade: shade.or(ctx.shade.clone()),
                    style: Some("Quote"),
                    ..ctx.clone()
                };
                self.blocks(blocks, &c, list);
            }
            Block::Callout { color, title, dir, blocks, .. } => {
                let c = color.trim_start_matches('#').to_uppercase();
                let fill = tint(color, 0.9);
                let border = format!("<w:left w:val=\"single\" w:sz=\"24\" w:space=\"8\" w:color=\"{c}\"/>");
                let inner = Ctx { indent: ctx.indent + 160, borders: Some(border), shade: Some(fill), ..ctx.clone() };
                let mut tf = ctx.run.clone();
                tf.bold = true;
                tf.color = Some(c.clone());
                let runs = self.inlines(title, &tf);
                self.para(Para { dir: *dir, keep_next: true, ..Default::default() }, &inner, &runs);
                self.blocks(blocks, &inner, list);
            }
            Block::Code { text, .. } => {
                let lines: Vec<&str> = text.split('\n').collect();
                for (k, line) in lines.iter().enumerate() {
                    let run = format!("<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>", esc(&line.replace('\t', "    ")));
                    let p = Para { style: Some("NzCode"), dir: Dir::Ltr, keep_next: k + 1 < lines.len(), ..Default::default() };
                    self.para(p, &Ctx { style: None, align: None, ..ctx.clone() }, &run);
                }
            }
            Block::Table { dir, aligns, head, rows } => self.table(*dir, aligns, head, rows, ctx),
            Block::Rule => self.para(
                Para { borders: Some("<w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"C8CCD4\"/>".into()), ..Default::default() },
                &Ctx::default(),
                "",
            ),
            Block::PageBreak => self.body.push_str("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>\n"),
            Block::Toc => self.toc(),
            Block::Div { attrs, blocks } => {
                let mut c = ctx.clone();
                c.run = c.run.with_attrs(attrs);
                let mut cols = None;
                for (k, v) in attrs {
                    match (k.as_str(), v.as_str()) {
                        ("align", a) => c.align = Some(a.to_string()),
                        ("box", col) => {
                            let col = hex(col).unwrap_or_else(|| "7B93D1".into());
                            let side = |s: &str| format!("<w:{s} w:val=\"single\" w:sz=\"6\" w:space=\"6\" w:color=\"{col}\"/>");
                            c.borders = Some(format!("{}{}{}{}", side("top"), side("left"), side("bottom"), side("right")));
                            c.shade = Some(tint(&format!("#{col}"), 0.92));
                        }
                        ("columns", n) => cols = n.parse::<u32>().ok().filter(|n| (2..=4).contains(n)),
                        _ => {}
                    }
                }
                if let (Some(n), None, false) = (cols, list, self.in_footnote) {
                    // Columns are a Word section: end the one before, then this one.
                    let one = self.sect_pr(1, false);
                    self.body.push_str(&format!("<w:p><w:pPr>{one}</w:pPr></w:p>\n"));
                    self.blocks(blocks, &c, list);
                    let many = self.sect_pr(n, false);
                    self.body.push_str(&format!("<w:p><w:pPr>{many}</w:pPr></w:p>\n"));
                } else {
                    self.blocks(blocks, &c, list);
                }
            }
            Block::Media { id, caption } => {
                let run = self.media_run(*id, &ctx.run);
                self.para(Para { align: Some("center"), keep_next: caption.is_some(), ..Default::default() }, ctx, &run);
                if let Some(cap) = caption {
                    let runs = text_runs(cap, &ctx.run);
                    let dir = crate::render::md::detect_dir(cap).unwrap_or(self.p.base);
                    self.para(Para { style: Some("Caption"), dir, align: Some("center"), ..Default::default() }, ctx, &runs);
                }
            }
            Block::Figure { image, caption } => {
                let run = self.image_run(image, &ctx.run);
                self.para(Para { align: Some("center"), keep_next: caption.is_some(), ..Default::default() }, ctx, &run);
                if let Some(cap) = caption {
                    let runs = text_runs(cap, &ctx.run);
                    let dir = crate::render::md::detect_dir(cap).unwrap_or(self.p.base);
                    self.para(Para { style: Some("Caption"), dir, align: Some("center"), ..Default::default() }, ctx, &runs);
                }
            }
            Block::Embed { blocks } => {
                let c = Ctx {
                    indent: ctx.indent + 200,
                    borders: Some("<w:left w:val=\"single\" w:sz=\"12\" w:space=\"8\" w:color=\"CCD0D8\"/>".into()),
                    ..ctx.clone()
                };
                self.blocks(blocks, &c, list);
            }
            Block::VSpace(n) => {
                for _ in 0..*n {
                    self.para(Para::default(), &Ctx::default(), "");
                }
            }
            Block::Error(m) => {
                let mut f = RunFmt::default();
                f.color = Some("A02020".into());
                let runs = text_runs(m, &f);
                self.para(Para { shade: Some("FDECEC".into()), ..Default::default() }, ctx, &runs);
            }
        }
    }

    fn table(&mut self, dir: Dir, aligns: &[Align], head: &[Vec<Inline>], rows: &[Vec<Vec<Inline>>], ctx: &Ctx) {
        let cols = aligns.len().max(head.len()).max(rows.iter().map(Vec::len).max().unwrap_or(0)).max(1);
        let col_w = twips(self.text_width) / cols as i64;
        let mut o = String::from("<w:tbl><w:tblPr><w:tblStyle w:val=\"NzTable\"/>");
        if dir == Dir::Rtl {
            o.push_str("<w:bidiVisual/>");
        }
        o.push_str("<w:tblW w:w=\"0\" w:type=\"auto\"/><w:jc w:val=\"center\"/><w:tblLook w:val=\"04A0\" w:firstRow=\"1\" w:lastRow=\"0\" w:firstColumn=\"0\" w:lastColumn=\"0\" w:noHBand=\"1\" w:noVBand=\"1\"/></w:tblPr><w:tblGrid>");
        for _ in 0..cols {
            o.push_str(&format!("<w:gridCol w:w=\"{col_w}\"/>"));
        }
        o.push_str("</w:tblGrid>\n");
        let align = |c: usize| match aligns.get(c) {
            Some(Align::Left) => jc("left", dir),
            Some(Align::Center) => Some("center"),
            Some(Align::Right) => jc("right", dir),
            _ => None,
        };
        let saved = std::mem::take(&mut self.body);
        let row = |w: &mut Self, cells: &[Vec<Inline>], header: bool, o: &mut String| {
            o.push_str("<w:tr>");
            if header {
                o.push_str("<w:trPr><w:tblHeader/></w:trPr>");
            }
            for c in 0..cols {
                let mut f = ctx.run.clone();
                f.bold |= header;
                let runs = cells.get(c).map(|cell| w.inlines(cell, &f)).unwrap_or_default();
                let shd = if header { "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F3F5F8\"/>" } else { "" };
                let p = Para { dir, align: align(c), spacing: Some("<w:spacing w:before=\"40\" w:after=\"40\"/>".into()), ..Default::default() };
                o.push_str(&format!("<w:tc><w:tcPr><w:tcW w:w=\"{col_w}\" w:type=\"dxa\"/>{shd}</w:tcPr><w:p>{}{runs}</w:p></w:tc>", p.ppr()));
            }
            o.push_str("</w:tr>\n");
        };
        if !head.is_empty() {
            row(self, head, true, &mut o);
        }
        for r in rows {
            row(self, r, false, &mut o);
        }
        o.push_str("</w:tbl>\n");
        self.body = saved;
        self.body.push_str(&o);
        // Word needs a paragraph between two tables.
        self.body.push_str("<w:p><w:pPr><w:spacing w:after=\"0\"/></w:pPr></w:p>\n");
    }

    /// A Word TOC field, pre-filled with the headings (Word adds page numbers
    /// when it updates the field; it asks to on opening).
    fn toc(&mut self) {
        let mut o = String::from("<w:p><w:pPr><w:pStyle w:val=\"TOCHeading\"/></w:pPr></w:p>\n");
        let heads: Vec<_> = self.p.doc.headings.iter().filter(|(l, ..)| *l <= 3).cloned().collect();
        for (k, (level, id, text)) in heads.iter().enumerate() {
            let mut runs = String::new();
            if k == 0 {
                runs.push_str("<w:r><w:fldChar w:fldCharType=\"begin\" w:dirty=\"true\"/></w:r><w:r><w:instrText xml:space=\"preserve\"> TOC \\o \"1-3\" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>");
            }
            let link = text_runs(text, &RunFmt::default());
            match self.bookmarks.get(id) {
                Some(bm) => runs.push_str(&format!("<w:hyperlink w:anchor=\"{bm}\">{link}</w:hyperlink>")),
                None => runs.push_str(&link),
            }
            if k + 1 == heads.len() {
                runs.push_str("<w:r><w:fldChar w:fldCharType=\"end\"/></w:r>");
            }
            let dir = crate::render::md::detect_dir(text).unwrap_or(self.p.base);
            let p = Para { style: Some(["TOC1", "TOC2", "TOC3"][(*level as usize).clamp(1, 3) - 1]), dir, ..Default::default() };
            o.push_str(&format!("<w:p>{}{runs}</w:p>\n", p.ppr()));
        }
        if heads.is_empty() {
            o.push_str("<w:p><w:r><w:fldChar w:fldCharType=\"begin\" w:dirty=\"true\"/></w:r><w:r><w:instrText xml:space=\"preserve\"> TOC \\o \"1-3\" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType=\"separate\"/></w:r><w:r><w:fldChar w:fldCharType=\"end\"/></w:r></w:p>\n");
        }
        self.body.push_str(&o);
    }

    fn sect_pr(&self, cols: u32, last: bool) -> String {
        let (w, h) = page_size_pt(&self.p.theme);
        let m = margins_pt(&self.p.theme);
        let landscape = self.p.theme.page.orientation.as_deref() == Some("landscape");
        let mut o = String::from("<w:sectPr>");
        if last {
            o.push_str("<w:headerReference w:type=\"default\" r:id=\"rId3\"/><w:footerReference w:type=\"default\" r:id=\"rId4\"/>");
            if self.p.theme.page.skip_first == Some(true) {
                o.push_str("<w:headerReference w:type=\"first\" r:id=\"rId5\"/><w:footerReference w:type=\"first\" r:id=\"rId6\"/>");
            }
        }
        if !last {
            o.push_str("<w:type w:val=\"continuous\"/>");
        }
        o.push_str(&format!(
            "<w:pgSz w:w=\"{}\" w:h=\"{}\"{}/><w:pgMar w:top=\"{}\" w:right=\"{}\" w:bottom=\"{}\" w:left=\"{}\" w:header=\"567\" w:footer=\"567\" w:gutter=\"0\"/>",
            twips(w),
            twips(h),
            if landscape { " w:orient=\"landscape\"" } else { "" },
            twips(m[0]),
            twips(m[1]),
            twips(m[2]),
            twips(m[3])
        ));
        o.push_str(&format!("<w:cols w:num=\"{cols}\" w:space=\"567\"/>"));
        if last && self.p.theme.page.skip_first == Some(true) {
            o.push_str("<w:titlePg/>");
        }
        if self.p.base == Dir::Rtl {
            o.push_str("<w:bidi/>");
        }
        o.push_str("</w:sectPr>");
        o
    }
}

// ------------------------------------------------------------------ parts

fn rpr_of(st: &TextStyle, body: &TextStyle, mono: bool) -> String {
    let mut o = String::new();
    let font = st.font.clone().or_else(|| if mono { None } else { body.font.clone() });
    let font = if mono { font.map(|f| word_font(&f)).or(Some("Consolas".into())) } else { font.map(|f| word_font(&f)) };
    let ar = arabic_font(st).or_else(|| arabic_font(body)).unwrap_or_else(|| "Vazirmatn".into());
    match font {
        Some(f) => o.push_str(&format!("<w:rFonts w:ascii=\"{0}\" w:hAnsi=\"{0}\" w:eastAsia=\"{0}\" w:cs=\"{1}\"/>", esc(&f), esc(&ar))),
        None => o.push_str(&format!("<w:rFonts w:cs=\"{}\"/>", esc(&ar))),
    }
    if st.weight.as_deref().is_some_and(bold_weight) {
        o.push_str("<w:b/><w:bCs/>");
    }
    if st.italic == Some(true) {
        o.push_str("<w:i/><w:iCs/>");
    }
    if st.smallcaps == Some(true) {
        o.push_str("<w:smallCaps/>");
    }
    if let Some(c) = st.color.as_deref().and_then(hex) {
        o.push_str(&format!("<w:color w:val=\"{c}\"/>"));
    }
    if let Some(s) = st.size.as_deref().and_then(half_points) {
        o.push_str(&format!("<w:sz w:val=\"{s}\"/><w:szCs w:val=\"{s}\"/>"));
    }
    if st.underline == Some(true) {
        o.push_str("<w:u w:val=\"single\"/>");
    }
    o
}

fn ppr_of(st: &TextStyle, base_dir: Dir) -> String {
    let mut o = String::new();
    let before = st.space_before.as_deref().and_then(length_pt).map(twips);
    let after = st.space_after.as_deref().and_then(length_pt).map(twips);
    let line = st.line_spacing.filter(|f| (0.5..=4.0).contains(f)).map(|f| (240.0 * f).round() as i64);
    if before.is_some() || after.is_some() || line.is_some() {
        o.push_str("<w:spacing");
        if let Some(b) = before {
            o.push_str(&format!(" w:before=\"{b}\""));
        }
        if let Some(a) = after {
            o.push_str(&format!(" w:after=\"{a}\""));
        }
        if let Some(l) = line {
            o.push_str(&format!(" w:line=\"{l}\" w:lineRule=\"auto\""));
        }
        o.push_str("/>");
    }
    if let Some(i) = st.indent.as_deref().and_then(length_pt) {
        o.push_str(&format!("<w:ind w:firstLine=\"{}\"/>", twips(i)));
    }
    if let Some(a) = st.align.as_deref().and_then(|a| jc(a, base_dir)) {
        o.push_str(&format!("<w:jc w:val=\"{a}\"/>"));
    }
    o
}

/// Heading numbering ("1.", "1.1.", "۱.", "I.") → lvlText and numFmt.
fn heading_level(pattern: &str, level: usize) -> Option<(String, &'static str)> {
    let p = pattern.trim();
    if p.is_empty() || p == "none" {
        return None;
    }
    let mut text = String::new();
    let mut n = 0;
    let mut fmt = "decimal";
    for c in p.chars() {
        let f = match c {
            '1' => Some("decimal"),
            '۱' | '١' => Some("hindiNumbers"),
            'a' => Some("lowerLetter"),
            'A' => Some("upperLetter"),
            'i' => Some("lowerRoman"),
            'I' => Some("upperRoman"),
            _ => None,
        };
        match f {
            Some(f) if n < level => {
                n += 1;
                fmt = f;
                text.push_str(&format!("%{n}"));
            }
            _ => text.push(c),
        }
    }
    (n > 0).then_some((text, fmt))
}

fn styles_xml(t: &Theme, base: Dir, lang: &str) -> (String, bool) {
    let body = t.style("body");
    let s = |k: &str| t.style(k);
    let wl = word_lang(lang);
    let (latin_lang, bidi_lang) = if base == Dir::Rtl { ("en-US".to_string(), wl) } else { (wl, "fa-IR".to_string()) };
    let mut o = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:styles {W_NS}><w:docDefaults><w:rPrDefault><w:rPr>{}<w:lang w:val=\"{latin_lang}\" w:eastAsia=\"zh-CN\" w:bidi=\"{bidi_lang}\"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after=\"160\" w:line=\"276\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults>\n",
        rpr_of(&body, &body, false)
    );
    o.push_str(&format!(
        "<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/><w:pPr>{}</w:pPr><w:rPr>{}</w:rPr></w:style>\n",
        ppr_of(&body, base),
        rpr_of(&body, &body, false)
    ));
    // Heading numbering, when the theme numbers headings.
    let mut numbered = false;
    for n in 1..=6 {
        let st = s(&format!("h{n}"));
        let num = st.numbering.as_deref().and_then(|p| heading_level(p, n));
        numbered |= num.is_some();
        let mut st2 = st.clone();
        st2.indent = None;
        let mut ppr = format!("<w:keepNext/><w:keepLines/>{}", ppr_of(&st2, base));
        if num.is_some() {
            ppr = format!("<w:keepNext/><w:keepLines/><w:numPr><w:ilvl w:val=\"{}\"/><w:numId w:val=\"1\"/></w:numPr>{}", n - 1, ppr_of(&st2, base));
        }
        o.push_str(&format!(
            "<w:style w:type=\"paragraph\" w:styleId=\"Heading{n}\"><w:name w:val=\"heading {n}\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"9\"/><w:qFormat/><w:pPr>{ppr}<w:outlineLvl w:val=\"{}\"/></w:pPr><w:rPr>{}</w:rPr></w:style>\n",
            n - 1,
            rpr_of(&st, &body, false)
        ));
    }
    let simple = |id: &str, name: &str, st: &TextStyle, extra_ppr: &str, mono: bool| {
        let mut st2 = st.clone();
        st2.indent = None;
        format!(
            "<w:style w:type=\"paragraph\" w:styleId=\"{id}\"><w:name w:val=\"{name}\"/><w:basedOn w:val=\"Normal\"/><w:qFormat/><w:pPr>{extra_ppr}{}</w:pPr><w:rPr>{}</w:rPr></w:style>\n",
            ppr_of(&st2, base),
            rpr_of(st, &body, mono)
        )
    };
    let mut title = s("title");
    title.align.get_or_insert("center".into());
    o.push_str(&simple("Title", "Title", &title, "", false));
    let mut sub = s("subtitle");
    sub.align.get_or_insert("center".into());
    o.push_str(&simple("Subtitle", "Subtitle", &sub, "", false));
    o.push_str(&simple("Quote", "Quote", &s("quote"), "", false));
    let code = s("code");
    let code_fill = code.background.as_deref().and_then(hex).unwrap_or_else(|| "F5F6F8".into());
    let mut code_st = code.clone();
    code_st.align = None;
    o.push_str(&format!(
        "<w:style w:type=\"paragraph\" w:styleId=\"NzCode\"><w:name w:val=\"Code\"/><w:basedOn w:val=\"Normal\"/><w:qFormat/><w:pPr><w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{code_fill}\"/><w:spacing w:before=\"0\" w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/><w:ind w:left=\"120\" w:right=\"120\"/><w:jc w:val=\"left\"/></w:pPr><w:rPr>{}</w:rPr></w:style>\n",
        rpr_of(&code_st, &body, true)
    ));
    o.push_str(&format!(
        "<w:style w:type=\"character\" w:styleId=\"NzCodeChar\"><w:name w:val=\"Inline code\"/><w:rPr>{}<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F3F4F6\"/></w:rPr></w:style>\n",
        rpr_of(&TextStyle { size: None, ..code.clone() }, &body, true)
    ));
    let mut cap = s("caption");
    cap.align.get_or_insert("center".into());
    o.push_str(&simple("Caption", "caption", &cap, "", false));
    o.push_str("<w:style w:type=\"paragraph\" w:styleId=\"ListParagraph\"><w:name w:val=\"List Paragraph\"/><w:basedOn w:val=\"Normal\"/><w:qFormat/><w:pPr><w:spacing w:after=\"60\"/><w:contextualSpacing/></w:pPr></w:style>\n");
    let link = s("link").color.as_deref().and_then(hex).unwrap_or_else(|| "2F5FC4".into());
    let link_u = if s("link").underline == Some(true) { "<w:u w:val=\"single\"/>" } else { "" };
    o.push_str(&format!("<w:style w:type=\"character\" w:styleId=\"Hyperlink\"><w:name w:val=\"Hyperlink\"/><w:rPr><w:color w:val=\"{link}\"/>{link_u}</w:rPr></w:style>\n"));
    o.push_str("<w:style w:type=\"paragraph\" w:styleId=\"FootnoteText\"><w:name w:val=\"footnote text\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/><w:ind w:firstLine=\"0\"/></w:pPr><w:rPr><w:sz w:val=\"18\"/><w:szCs w:val=\"18\"/></w:rPr></w:style>\n");
    o.push_str("<w:style w:type=\"character\" w:styleId=\"FootnoteReference\"><w:name w:val=\"footnote reference\"/><w:rPr><w:vertAlign w:val=\"superscript\"/></w:rPr></w:style>\n");
    o.push_str("<w:style w:type=\"paragraph\" w:styleId=\"TOCHeading\"><w:name w:val=\"TOC Heading\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:spacing w:after=\"0\"/></w:pPr></w:style>\n");
    for n in 1..=3 {
        o.push_str(&format!(
            "<w:style w:type=\"paragraph\" w:styleId=\"TOC{n}\"><w:name w:val=\"toc {n}\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:pPr><w:spacing w:after=\"60\"/><w:ind w:left=\"{}\" w:firstLine=\"0\"/></w:pPr></w:style>\n",
            (n - 1) * 240
        ));
    }
    o.push_str("<w:style w:type=\"paragraph\" w:styleId=\"Header\"><w:name w:val=\"header\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:spacing w:after=\"0\"/><w:ind w:firstLine=\"0\"/></w:pPr><w:rPr><w:sz w:val=\"18\"/><w:szCs w:val=\"18\"/></w:rPr></w:style>\n");
    o.push_str("<w:style w:type=\"paragraph\" w:styleId=\"Footer\"><w:name w:val=\"footer\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:spacing w:after=\"0\"/><w:ind w:firstLine=\"0\"/></w:pPr><w:rPr><w:sz w:val=\"18\"/><w:szCs w:val=\"18\"/></w:rPr></w:style>\n");
    let b = "<w:top w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"C9CDD4\"/><w:left w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"C9CDD4\"/><w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"C9CDD4\"/><w:right w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"C9CDD4\"/><w:insideH w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"C9CDD4\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"C9CDD4\"/>";
    o.push_str(&format!("<w:style w:type=\"table\" w:styleId=\"NzTable\"><w:name w:val=\"NoteZ Table\"/><w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/><w:ind w:firstLine=\"0\"/></w:pPr><w:tblPr><w:tblBorders>{b}</w:tblBorders><w:tblCellMar><w:top w:w=\"60\" w:type=\"dxa\"/><w:left w:w=\"110\" w:type=\"dxa\"/><w:bottom w:w=\"60\" w:type=\"dxa\"/><w:right w:w=\"110\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr></w:style>\n"));
    o.push_str("</w:styles>\n");
    (o, numbered)
}

fn numbering_xml(nums: &[(usize, u64)], theme: &Theme, headings: bool) -> String {
    let mut o = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:numbering {W_NS}>");
    let bullets = ["•", "◦", "▪"];
    let fmts = ["decimal", "lowerLetter", "lowerRoman"];
    for (abs, ordered) in [(0, false), (1, true)] {
        o.push_str(&format!("<w:abstractNum w:abstractNumId=\"{abs}\"><w:multiLevelType w:val=\"hybridMultilevel\"/>"));
        for l in 0..9 {
            let (fmt, text) = if ordered { (fmts[l % 3], format!("%{}.", l + 1)) } else { ("bullet", bullets[l % 3].to_string()) };
            o.push_str(&format!(
                "<w:lvl w:ilvl=\"{l}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"{fmt}\"/><w:lvlText w:val=\"{text}\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"{}\" w:hanging=\"360\"/></w:pPr></w:lvl>",
                360 * (l + 1)
            ));
        }
        o.push_str("</w:abstractNum>");
    }
    // Heading numbering from the theme's patterns.
    o.push_str("<w:abstractNum w:abstractNumId=\"2\"><w:multiLevelType w:val=\"multilevel\"/>");
    for n in 1..=9 {
        let (text, fmt) = if n <= 6 && headings {
            theme.style(&format!("h{n}")).numbering.as_deref().and_then(|p| heading_level(p, n)).unwrap_or_default()
        } else {
            (String::new(), "decimal")
        };
        let fmt = if text.is_empty() { "none" } else { fmt };
        o.push_str(&format!(
            "<w:lvl w:ilvl=\"{}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"{fmt}\"/>{}<w:lvlText w:val=\"{}\"/><w:lvlJc w:val=\"left\"/><w:suff w:val=\"space\"/><w:pPr><w:ind w:left=\"0\" w:firstLine=\"0\"/></w:pPr></w:lvl>",
            n - 1,
            if n <= 6 { format!("<w:pStyle w:val=\"Heading{n}\"/>") } else { String::new() },
            esc(&text)
        ));
    }
    o.push_str("</w:abstractNum>");
    o.push_str("<w:num w:numId=\"1\"><w:abstractNumId w:val=\"2\"/></w:num>");
    for (i, (abs, start)) in nums.iter().enumerate() {
        o.push_str(&format!(
            "<w:num w:numId=\"{}\"><w:abstractNumId w:val=\"{abs}\"/><w:lvlOverride w:ilvl=\"0\"><w:startOverride w:val=\"{start}\"/></w:lvlOverride></w:num>",
            i + 2
        ));
    }
    o.push_str("</w:numbering>\n");
    o
}

/// Header/footer text with `{page}`, `{total}`, `{title}`, `{author}`, `{date}`.
fn hf_runs(s: &str, p: &Prepared) -> String {
    let mut o = String::new();
    let mut rest = s;
    let field = |instr: &str| {
        format!("<w:r><w:fldChar w:fldCharType=\"begin\"/></w:r><w:r><w:instrText xml:space=\"preserve\"> {instr} </w:instrText></w:r><w:r><w:fldChar w:fldCharType=\"separate\"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType=\"end\"/></w:r>")
    };
    while let Some(a) = rest.find('{') {
        o.push_str(&text_runs(&rest[..a], &RunFmt::default()));
        let Some(b) = rest[a..].find('}') else { break };
        let key = &rest[a + 1..a + b];
        o.push_str(&match key {
            "page" => field("PAGE"),
            "total" => field("NUMPAGES"),
            "title" => text_runs(p.fm.title.as_deref().unwrap_or(""), &RunFmt::default()),
            "author" => text_runs(p.fm.author.as_deref().unwrap_or(""), &RunFmt::default()),
            "date" => text_runs(p.fm.date.as_deref().unwrap_or(""), &RunFmt::default()),
            "chapter" => field("STYLEREF \"heading 1\""),
            _ => String::new(),
        });
        rest = &rest[a + b + 1..];
    }
    o.push_str(&text_runs(rest, &RunFmt::default()));
    o
}

fn hf_xml(kind: &str, hf: Option<&crate::render::styles::HeaderFooter>, p: &Prepared, width: f64) -> String {
    let tag = if kind == "header" { "hdr" } else { "ftr" };
    let style = if kind == "header" { "Header" } else { "Footer" };
    let mut runs = String::new();
    if let Some(hf) = hf {
        let parts = [hf.left.as_deref(), hf.center.as_deref(), hf.right.as_deref()];
        for (k, part) in parts.iter().enumerate() {
            if k > 0 {
                runs.push_str("<w:r><w:tab/></w:r>");
            }
            if let Some(s) = part {
                runs.push_str(&hf_runs(s, p));
            }
        }
    }
    let line = hf.and_then(|h| h.line).unwrap_or(false);
    let border = if line {
        if kind == "header" {
            "<w:pBdr><w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"4\" w:color=\"B0B5BE\"/></w:pBdr>"
        } else {
            "<w:pBdr><w:top w:val=\"single\" w:sz=\"4\" w:space=\"4\" w:color=\"B0B5BE\"/></w:pBdr>"
        }
    } else {
        ""
    };
    let bidi = if p.base == Dir::Rtl { "<w:bidi/>" } else { "" };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:{tag} {W_NS}><w:p><w:pPr><w:pStyle w:val=\"{style}\"/>{border}<w:tabs><w:tab w:val=\"center\" w:pos=\"{}\"/><w:tab w:val=\"right\" w:pos=\"{}\"/></w:tabs>{bidi}</w:pPr>{runs}</w:p></w:{tag}>\n",
        twips(width / 2.0),
        twips(width)
    )
}

fn empty_hf(kind: &str) -> String {
    let tag = if kind == "header" { "hdr" } else { "ftr" };
    format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:{tag} {W_NS}><w:p/></w:{tag}>\n")
}

/// The .docx bytes. Returns (bytes, warnings).
pub fn write(p: &Prepared, drawn: &[Drawn]) -> Res<(Vec<u8>, Vec<String>)> {
    let mut w = W {
        p,
        drawn,
        body: String::new(),
        rels: vec![],
        media_files: vec![],
        next_rel: 0,
        next_pic: 0,
        next_bm: 0,
        bookmarks: HashMap::new(),
        nums: vec![],
        footnotes: vec![],
        note_links: 0,
        text_width: text_width_pt(&p.theme),
        in_footnote: false,
    };
    let _ = w.next_rel;
    for (i, (_, id, _)) in p.doc.headings.iter().enumerate() {
        w.bookmarks.entry(id.clone()).or_insert_with(|| format!("_NzH{}", i + 1));
    }
    // Title block.
    let fm = &p.fm;
    if let Some(t) = &fm.title {
        let dir = crate::render::md::detect_dir(t).unwrap_or(p.base);
        let runs = text_runs(t, &RunFmt::default());
        w.para(Para { style: Some("Title"), dir, ..Default::default() }, &Ctx::default(), &runs);
        if let Some(s) = &fm.subtitle {
            let runs = text_runs(s, &RunFmt::default());
            w.para(Para { style: Some("Subtitle"), dir, ..Default::default() }, &Ctx::default(), &runs);
        }
        let meta: Vec<&str> = [fm.author.as_deref(), fm.date.as_deref()].into_iter().flatten().collect();
        if !meta.is_empty() {
            let mut f = RunFmt::default();
            f.color = Some("5B6478".into());
            let runs = text_runs(&meta.join(" · "), &f);
            w.para(Para { dir, align: Some("center"), ..Default::default() }, &Ctx::default(), &runs);
        }
    }
    if fm.toc == Some(true) {
        w.toc();
        w.body.push_str("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>\n");
    }
    let blocks = p.doc.blocks.clone();
    w.blocks(&blocks, &Ctx::default(), None);
    // Footnotes.
    let notes = p.doc.footnotes.clone();
    for (i, (_, bl)) in notes.iter().enumerate() {
        let n = i + 1;
        let saved = std::mem::take(&mut w.body);
        w.in_footnote = true;
        let fref = "<w:r><w:rPr><w:rStyle w:val=\"FootnoteReference\"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space=\"preserve\"> </w:t></w:r>";
        let mut first = true;
        for b in bl {
            match b {
                Block::Para { dir, body } => {
                    let mut runs = if first { fref.to_string() } else { String::new() };
                    runs.push_str(&w.inlines(body, &RunFmt::default()));
                    w.para(Para { style: Some("FootnoteText"), dir: *dir, ..Default::default() }, &Ctx::default(), &runs);
                }
                other => {
                    if first {
                        w.para(Para { style: Some("FootnoteText"), dir: p.base, ..Default::default() }, &Ctx::default(), fref);
                    }
                    w.block(other, &Ctx { style: Some("FootnoteText"), ..Default::default() }, None)
                }
            }
            first = false;
        }
        if bl.is_empty() {
            w.para(Para { style: Some("FootnoteText"), dir: p.base, ..Default::default() }, &Ctx::default(), fref);
        }
        w.in_footnote = false;
        let body = std::mem::replace(&mut w.body, saved);
        w.footnotes.push(format!("<w:footnote w:id=\"{n}\">{body}</w:footnote>\n"));
    }
    let sect = w.sect_pr(p.theme.page.columns.unwrap_or(1).clamp(1, 4), true);
    let document = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:document {W_NS}><w:body>\n{}{sect}</w:body></w:document>\n",
        w.body
    );
    let (styles, numbered) = styles_xml(&p.theme, p.base, &p.lang);
    let numbering = numbering_xml(&w.nums, &p.theme, numbered);
    let footnotes = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:footnotes {W_NS}><w:footnote w:type=\"separator\" w:id=\"-1\"><w:p><w:pPr><w:spacing w:after=\"0\"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type=\"continuationSeparator\" w:id=\"0\"><w:p><w:pPr><w:spacing w:after=\"0\"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>\n{}</w:footnotes>\n",
        w.footnotes.concat()
    );
    let has_toc = fm.toc == Some(true) || contains_toc(&p.doc.blocks);
    let settings = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:settings {W_NS}>{}<w:defaultTabStop w:val=\"720\"/><w:characterSpacingControl w:val=\"doNotCompress\"/><w:footnotePr><w:footnote w:id=\"-1\"/><w:footnote w:id=\"0\"/></w:footnotePr><w:compat><w:doNotExpandShiftReturn/><w:compatSetting w:name=\"compatibilityMode\" w:uri=\"http://schemas.microsoft.com/office/word\" w:val=\"15\"/></w:compat></w:settings>\n",
        if has_toc { "<w:updateFields w:val=\"true\"/>" } else { "" }
    );
    let tw = w.text_width;
    let header = hf_xml("header", p.theme.page.header.as_ref(), p, tw);
    let footer = hf_xml("footer", p.theme.page.footer.as_ref(), p, tw);
    let title = fm.title.clone().unwrap_or_else(|| p.note.rsplit('/').next().unwrap_or(&p.note).trim_end_matches(".md").to_string());
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ");
    let core = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><dc:title>{}</dc:title><dc:creator>{}</dc:creator><dc:language>{}</dc:language><dcterms:created xsi:type=\"dcterms:W3CDTF\">{now}</dcterms:created><dcterms:modified xsi:type=\"dcterms:W3CDTF\">{now}</dcterms:modified></cp:coreProperties>\n",
        esc(&title),
        esc(fm.author.as_deref().unwrap_or("")),
        esc(&p.lang)
    );
    let app = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\"><Application>NoteZ</Application></Properties>\n";

    let mut rels = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">");
    let base = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    for (id, kind, target) in [
        (1, "styles", "styles.xml"),
        (2, "numbering", "numbering.xml"),
        (3, "header", "header1.xml"),
        (4, "footer", "footer1.xml"),
        (5, "header", "header2.xml"),
        (6, "footer", "footer2.xml"),
        (7, "footnotes", "footnotes.xml"),
        (8, "settings", "settings.xml"),
    ] {
        rels.push_str(&format!("<Relationship Id=\"rId{id}\" Type=\"{base}/{kind}\" Target=\"{target}\"/>"));
    }
    for (i, (target, kind, external)) in w.rels.iter().enumerate() {
        rels.push_str(&format!(
            "<Relationship Id=\"rId{}\" Type=\"{base}/{kind}\" Target=\"{}\"{}/>",
            i + 10,
            esc(target),
            if *external { " TargetMode=\"External\"" } else { "" }
        ));
    }
    rels.push_str("</Relationships>\n");

    let mut types = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Default Extension=\"png\" ContentType=\"image/png\"/><Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/><Default Extension=\"gif\" ContentType=\"image/gif\"/><Default Extension=\"bmp\" ContentType=\"image/bmp\"/>");
    let wml = "application/vnd.openxmlformats-officedocument.wordprocessingml";
    for (part, ct) in [
        ("/word/document.xml", format!("{wml}.document.main+xml")),
        ("/word/styles.xml", format!("{wml}.styles+xml")),
        ("/word/numbering.xml", format!("{wml}.numbering+xml")),
        ("/word/footnotes.xml", format!("{wml}.footnotes+xml")),
        ("/word/settings.xml", format!("{wml}.settings+xml")),
        ("/word/header1.xml", format!("{wml}.header+xml")),
        ("/word/header2.xml", format!("{wml}.header+xml")),
        ("/word/footer1.xml", format!("{wml}.footer+xml")),
        ("/word/footer2.xml", format!("{wml}.footer+xml")),
        ("/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml".into()),
        ("/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml".into()),
    ] {
        types.push_str(&format!("<Override PartName=\"{part}\" ContentType=\"{ct}\"/>"));
    }
    types.push_str("</Types>\n");
    let root_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/><Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\" Target=\"docProps/app.xml\"/></Relationships>\n";

    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut put = |name: &str, data: &[u8]| -> Res<()> {
            z.start_file(name, opts).map_err(|e| e.to_string())?;
            z.write_all(data).map_err(|e| e.to_string())
        };
        put("[Content_Types].xml", types.as_bytes())?;
        put("_rels/.rels", root_rels.as_bytes())?;
        put("docProps/core.xml", core.as_bytes())?;
        put("docProps/app.xml", app.as_bytes())?;
        put("word/document.xml", document.as_bytes())?;
        put("word/_rels/document.xml.rels", rels.as_bytes())?;
        put("word/styles.xml", styles.as_bytes())?;
        put("word/numbering.xml", numbering.as_bytes())?;
        put("word/footnotes.xml", footnotes.as_bytes())?;
        put("word/settings.xml", settings.as_bytes())?;
        put("word/header1.xml", header.as_bytes())?;
        put("word/footer1.xml", footer.as_bytes())?;
        put("word/header2.xml", empty_hf("header").as_bytes())?;
        put("word/footer2.xml", empty_hf("footer").as_bytes())?;
        for (name, data) in &w.media_files {
            put(&format!("word/media/{name}"), data)?;
        }
        z.finish().map_err(|e| e.to_string())?;
    }
    let mut warnings = vec![];
    if w.note_links > 0 {
        warnings.push(format!(
            "{} link{} to other notes became plain text (Word has only this note)",
            w.note_links,
            if w.note_links == 1 { "" } else { "s" }
        ));
    }
    let failed = drawn.iter().filter(|d| d.error.is_some()).count();
    if failed > 0 {
        warnings.push(format!("{failed} chart/diagram/formula could not be drawn"));
    }
    Ok((buf.into_inner(), warnings))
}

fn contains_toc(bl: &[Block]) -> bool {
    bl.iter().any(|b| match b {
        Block::Toc => true,
        Block::Div { blocks, .. } | Block::Quote { blocks } | Block::Embed { blocks } | Block::Callout { blocks, .. } => contains_toc(blocks),
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_runs_split_at_direction_changes() {
        let r = script_runs("سلام hello, دنیا!");
        assert_eq!(r, vec![("سلام ".to_string(), true), ("hello, ".to_string(), false), ("دنیا!".to_string(), true)]);
    }

    #[test]
    fn heading_numbering_patterns() {
        assert_eq!(heading_level("1.", 1), Some(("%1.".into(), "decimal")));
        assert_eq!(heading_level("1.1.", 2), Some(("%1.%2.".into(), "decimal")));
        assert_eq!(heading_level("۱.", 1), Some(("%1.".into(), "hindiNumbers")));
        assert_eq!(heading_level("none", 1), None);
    }

    #[test]
    fn rtl_alignment_is_mirrored() {
        assert_eq!(jc("left", Dir::Rtl), Some("right"));
        assert_eq!(jc("left", Dir::Ltr), Some("left"));
        assert_eq!(jc("justify", Dir::Rtl), Some("both"));
        assert_eq!(jc("start", Dir::Rtl), None);
    }
}
