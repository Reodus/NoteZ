//! Export a Markdown note to Word (.docx), one self-contained HTML file, or
//! portable Markdown (standard links, attachments copied next to it).
//!
//! Word and HTML read the note into `model::Doc` the way the PDF does, so
//! directions, callouts, footnotes and tables come out the same. Charts,
//! diagrams, math, data views and PDF pages are drawn by the PDF engine
//! (Typst) in one compile — one page per item — as SVG for HTML and PNG for
//! Word, so they look exactly like the PDF.

pub mod docx;
pub mod html;
pub mod markdown;
pub mod model;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use typst::layout::{Frame, FrameItem, Point};
use typst_layout::PagedDocument;

use crate::render::md::{Dir, Rendered};
use crate::render::styles::{Meta, Theme};
use crate::render::world::NoteWorld;
use crate::render::{self, FrontMatter};
use model::{Doc, Env};

/// A note read for export.
pub struct Prepared {
    pub doc: Doc,
    pub theme: Theme,
    pub fm: FrontMatter,
    pub lang: String,
    pub base: Dir,
    pub vault: Option<PathBuf>,
    /// Vault-relative note path.
    pub note: String,
    /// Note text without frontmatter.
    pub body: String,
    /// Things the export could not keep (shown to the user).
    pub warnings: Vec<String>,
}

/// Read `text` (the note at vault path `note`) like `render::build` does.
pub fn prepare(vault: Option<&Path>, note: &str, text: &str, rendered: &Rendered) -> Prepared {
    let note = note.trim_start_matches('/').to_string();
    let note_dir = note.rsplit_once('/').map(|(d, _)| d).unwrap_or("").to_string();
    let (fm, body, _, fm_err) = render::parse_frontmatter(text);
    let mut theme = render::theme_for(vault, &fm, render::split_frontmatter(text).0);
    theme.resolve_lang(&format!("{} {body}", fm.title.as_deref().unwrap_or("")));
    let base = if theme.is_rtl() { Dir::Rtl } else { Dir::Ltr };
    let lang = theme.lang_code().unwrap_or_else(|| "en".into());
    let resolve_image = |url: &str| render::resolve_image(vault, &note_dir, url);
    let resolve_note = |url: &str| render::embedded_note(vault, &note_dir, text, url);
    let env = Env { base, rendered, resolve_image: &resolve_image, resolve_note: &resolve_note };
    let doc = model::build(body, &env);
    Prepared {
        doc,
        theme,
        lang,
        base,
        vault: vault.map(Path::to_path_buf),
        note,
        body: body.to_string(),
        warnings: fm_err.into_iter().collect(),
        fm,
    }
}

/// A drawn media item.
#[derive(Clone, Default)]
pub struct Drawn {
    pub svg: Option<String>,
    pub png: Option<Vec<u8>>,
    pub width_pt: f64,
    pub height_pt: f64,
    /// Distance from the top to the text baseline (inline math).
    pub baseline_pt: f64,
    pub error: Option<String>,
}

/// Width of the text area of the theme's page, in pt.
pub fn text_width_pt(theme: &Theme) -> f64 {
    let p = &theme.page;
    let (mut w, mut h) = match p.paper.as_deref().unwrap_or("a4").to_ascii_lowercase().as_str() {
        "a3" => (841.89, 1190.55),
        "a5" => (419.53, 595.28),
        "a6" => (297.64, 419.53),
        "b5" => (498.9, 708.66),
        "us-letter" | "letter" => (612.0, 792.0),
        "us-legal" | "legal" => (612.0, 1008.0),
        _ => (595.28, 841.89),
    };
    if p.orientation.as_deref() == Some("landscape") {
        std::mem::swap(&mut w, &mut h);
    }
    let m = margins_pt(theme);
    (w - m[1] - m[3]).max(144.0)
}

/// Page size (w, h) in pt.
pub fn page_size_pt(theme: &Theme) -> (f64, f64) {
    let m = margins_pt(theme);
    let w = text_width_pt(theme) + m[1] + m[3];
    let p = &theme.page;
    let (pw, ph): (f64, f64) = match p.paper.as_deref().unwrap_or("a4").to_ascii_lowercase().as_str() {
        "a3" => (841.89, 1190.55),
        "a5" => (419.53, 595.28),
        "a6" => (297.64, 419.53),
        "b5" => (498.9, 708.66),
        "us-letter" | "letter" => (612.0, 792.0),
        "us-legal" | "legal" => (612.0, 1008.0),
        _ => (595.28, 841.89),
    };
    let h = if p.orientation.as_deref() == Some("landscape") { pw.min(ph) } else { ph.max(pw) };
    (w, h)
}

/// Margins [top, right, bottom, left] in pt (`2cm` or `2cm 2.5cm 2cm 2.5cm`).
pub fn margins_pt(theme: &Theme) -> [f64; 4] {
    let vals: Vec<f64> = theme.page.margin.as_deref().unwrap_or("2.5cm").split_whitespace().filter_map(length_pt).collect();
    match vals.as_slice() {
        [a] => [*a; 4],
        [v, h] => [*v, *h, *v, *h],
        [t, h, b] => [*t, *h, *b, *h],
        [t, r, b, l, ..] => [*t, *r, *b, *l],
        _ => [70.87; 4],
    }
}

/// A Typst length in pt (`2cm`, `12pt`, `5mm`, `1in`); `em` relative to 11pt.
pub fn length_pt(s: &str) -> Option<f64> {
    let s = s.trim();
    let split = s.find(|c: char| c.is_ascii_alphabetic())?;
    let (n, unit) = s.split_at(split);
    let n: f64 = n.trim().parse().ok()?;
    Some(match unit {
        "pt" => n,
        "mm" => n * 72.0 / 25.4,
        "cm" => n * 72.0 / 2.54,
        "in" => n * 72.0,
        "em" => n * 11.0,
        _ => return None,
    })
}

/// Draw every media item of `p` (one compile; a failing item is retried
/// alone so one bad chart doesn't blank the others).
pub fn draw(world: &mut NoteWorld, p: &Prepared, svg: bool, png: bool) -> Vec<Drawn> {
    draw_items(world, &p.theme, &p.note, &p.doc.media, svg, png)
}

/// Draw `items` with the theme's fonts and text width (`note` places relative paths).
pub fn draw_items(world: &mut NoteWorld, theme: &Theme, note: &str, items: &[model::MediaSrc], svg: bool, png: bool) -> Vec<Drawn> {
    if items.is_empty() {
        return vec![];
    }
    let width = text_width_pt(theme);
    let meta = Meta { title: None, author: None, date: None };
    let head = |pkgs: &BTreeSet<&str>| {
        let imports: String = render::PACKAGES.iter().filter(|(n, _)| pkgs.contains(n)).map(|(_, i)| *i).collect();
        format!(
            "{imports}{}{}#set page(header: none, footer: none, numbering: none, background: none, columns: 1, fill: none)\n",
            render::HELPERS,
            render::styles::prelude(theme, &meta)
        )
    };
    let page = |m: &model::MediaSrc| {
        if m.inline {
            format!("#page(width: auto, height: auto, margin: 0pt)[#block(inset: 2pt)[{}]]\n", m.typst)
        } else if m.tight {
            // Display math: `aligned` & co. draw their first row above the
            // box they report, so leave room above and below.
            format!("#page(width: auto, height: auto, margin: (x: 2pt, y: 0.9em))[{}]\n", m.typst)
        } else {
            format!("#page(width: {width:.2}pt, height: auto, margin: 0pt)[{}]\n", m.typst)
        }
    };
    let main = match note.rsplit_once('/') {
        Some((d, _)) => format!("/{d}/__export__.typ"),
        None => "/__export__.typ".into(),
    };
    let compile = |world: &mut NoteWorld, src: String| -> Result<PagedDocument, String> {
        world.prepare(&main, src, vec![])?;
        typst::compile::<PagedDocument>(&*world)
            .output
            .map_err(|errs| errs.iter().map(|e| e.message.to_string()).collect::<Vec<_>>().join("; "))
    };
    let mut pkgs = BTreeSet::new();
    items.iter().for_each(|m| pkgs.extend(m.packages.iter().copied()));
    // Packages the pre-rendered Typst may use.
    for (name, _) in render::PACKAGES {
        if items.iter().any(|m| m.typst.contains(&format!("{name}.")) || (*name == "mitex" && m.typst.contains("mitex("))) {
            pkgs.insert(name);
        }
    }
    let all: String = items.iter().map(page).collect();
    let docs: Vec<Result<typst_layout::Page, String>> = match compile(world, format!("{}{all}", head(&pkgs))) {
        Ok(d) if d.pages().len() == items.len() => d.pages().iter().cloned().map(Ok).collect(),
        _ => items
            .iter()
            .map(|m| {
                let mut one = pkgs.clone();
                one.extend(m.packages.iter().copied());
                compile(world, format!("{}{}", head(&one), page(m))).and_then(|d| d.pages().first().cloned().ok_or_else(|| "empty".into()))
            })
            .collect(),
    };
    docs.into_iter()
        .map(|r| match r {
            Ok(pg) => {
                let size = pg.frame.size();
                Drawn {
                    svg: svg.then(|| typst_svg::svg(&pg, &typst_svg::SvgOptions::default())),
                    png: png.then(|| typst_render::render(&pg, &typst_render::RenderOptions { pixel_per_pt: typst::utils::Scalar::new(3.0), render_bleed: false }).encode_png().unwrap_or_default()),
                    width_pt: size.x.to_pt(),
                    height_pt: size.y.to_pt(),
                    baseline_pt: baseline(&pg.frame).unwrap_or(size.y.to_pt() * 0.78),
                    error: None,
                }
            }
            Err(e) => Drawn { error: Some(e), ..Default::default() },
        })
        .collect()
}

/// The baseline of the first line of text on a page (inline math).
fn baseline(f: &Frame) -> Option<f64> {
    fn first(f: &Frame, at: Point) -> Option<f64> {
        for (pos, item) in f.items() {
            match item {
                FrameItem::Group(g) => {
                    if let Some(b) = first(&g.frame, at + *pos) {
                        return Some(b);
                    }
                }
                FrameItem::Text(_) => return Some((at + *pos).y.to_pt()),
                _ => {}
            }
        }
        None
    }
    first(f, Point::zero())
}

/// Bytes and MIME type of a vault file.
pub fn read_asset(vault: Option<&Path>, rel: &str) -> Option<(Vec<u8>, &'static str)> {
    let path = vault?.join(rel.trim_start_matches('/'));
    let bytes = std::fs::read(&path).ok()?;
    let ext = rel.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    };
    Some((bytes, mime))
}

pub fn xml_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            // Not allowed in XML 1.0.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => o.push(c),
        }
    }
    o
}

/// A color attribute value as `#rrggbb` (named colors as Typst names them).
pub fn css_color(v: &str) -> Option<String> {
    let v = v.trim();
    if let Some(h) = v.strip_prefix('#') {
        if h.chars().all(|c| c.is_ascii_hexdigit()) {
            return match h.len() {
                3 | 4 => Some(format!("#{}", h.chars().take(3).flat_map(|c| [c, c]).collect::<String>())),
                6 | 8 => Some(format!("#{}", &h[..6])),
                _ => None,
            };
        }
        return None;
    }
    // Typst's named colors (styles::color accepts these).
    Some(
        match v {
            "black" => "#000000",
            "gray" => "#aaaaaa",
            "silver" => "#dddddd",
            "white" => "#ffffff",
            "navy" => "#001f3f",
            "blue" => "#0074d9",
            "aqua" => "#7fdbff",
            "teal" => "#39cccc",
            "eastern" => "#239dad",
            "purple" => "#b10dc9",
            "fuchsia" => "#f012be",
            "maroon" => "#85144b",
            "red" => "#ff4136",
            "orange" => "#ff851b",
            "yellow" => "#ffdc00",
            "olive" => "#3d9970",
            "green" => "#2ecc40",
            "lime" => "#01ff70",
            _ => return None,
        }
        .to_string(),
    )
}

