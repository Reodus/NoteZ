//! A note as a small document tree for the Word and HTML exports, read the
//! way the PDF reads it (render/md.rs): the same preprocessing (callouts,
//! spans, `:::` blocks, `%%comments%%`, `==marks==`), the same parser
//! options, and the same direction rule for every paragraph, heading, list
//! item and table, so all formats agree with the PDF.
//!
//! Charts, diagrams, math, data views and PDF pages are not interpreted here:
//! they become `Media` items holding Typst, which `mod.rs` compiles to SVG
//! (HTML) or PNG (Word) with the same engine the PDF uses.

use std::collections::HashMap;
use std::ops::Range;

use pulldown_cmark::{Alignment, BlockQuoteKind, CodeBlockKind, Event, HeadingLevel, LinkType, Options, Parser, Tag, TagEnd};

use crate::render::blocks::{self, BlockCtx};
use crate::render::md::{self, detect_dir, Dir, Rendered};
use crate::render::script::{self, is_rtl_char};

pub type Attrs = Vec<(String, String)>;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Align {
    None,
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone)]
pub enum Block {
    Heading { level: u8, id: String, dir: Dir, body: Vec<Inline> },
    Para { dir: Dir, body: Vec<Inline> },
    List { ordered: bool, start: u64, items: Vec<Item> },
    Quote { blocks: Vec<Block> },
    /// `> [!kind] Title` / GitHub alerts. `color` is the PDF's.
    Callout { kind: String, color: String, title: Vec<Inline>, dir: Dir, blocks: Vec<Block> },
    Code { lang: String, text: String },
    Table { dir: Dir, aligns: Vec<Align>, head: Vec<Vec<Inline>>, rows: Vec<Vec<Vec<Inline>>> },
    Rule,
    PageBreak,
    Toc,
    /// `::: {attrs}` … `:::`
    Div { attrs: Attrs, blocks: Vec<Block> },
    /// A rendered block (chart, diagram, display math, data view, PDF page).
    Media { id: usize, caption: Option<String> },
    /// A raster/SVG image file on its own line.
    Figure { image: ImageRef, caption: Option<String> },
    /// `![[Note]]`: the embedded note's content.
    Embed { blocks: Vec<Block> },
    /// Extra blank lines (n text lines of space).
    VSpace(u32),
    /// A block that could not be rendered (shown as a red note).
    Error(String),
}

#[derive(Debug, Clone)]
pub struct Item {
    pub task: Option<bool>,
    pub dir: Dir,
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone)]
pub enum Inline {
    Text(String),
    Strong(Vec<Inline>),
    Emph(Vec<Inline>),
    Strike(Vec<Inline>),
    Underline(Vec<Inline>),
    /// `==x==` (None = yellow) or a span's `highlight=`.
    Mark(Option<String>, Vec<Inline>),
    Sup(Vec<Inline>),
    Sub(Vec<Inline>),
    Code(String),
    /// `wiki`: a note link (`[[…]]` or a relative `.md` link); `url` is as written.
    Link { url: String, wiki: bool, body: Vec<Inline> },
    Image(ImageRef),
    /// Rendered math (inline) or an inline-rendered thing.
    Media(usize),
    Span { attrs: Attrs, body: Vec<Inline> },
    FootnoteRef(String),
    Break,
}

#[derive(Debug, Clone)]
pub struct ImageRef {
    /// Vault-relative path of the file (None: missing / remote).
    pub path: Option<String>,
    /// As written in the note.
    pub url: String,
    pub alt: String,
    /// `|300`: width in CSS pixels.
    pub width: Option<f64>,
}

/// Something for the Typst engine to draw.
#[derive(Debug, Clone)]
pub struct MediaSrc {
    pub typst: String,
    pub packages: Vec<&'static str>,
    /// Inline math: laid out on its own line, cut to its size, with a baseline.
    pub inline: bool,
    /// Display math: tight page too (charts get the text width).
    pub tight: bool,
}

#[derive(Debug, Default)]
pub struct Doc {
    pub blocks: Vec<Block>,
    pub footnotes: Vec<(String, Vec<Block>)>,
    pub media: Vec<MediaSrc>,
    /// Headings (level, id, plain text) in order, for tables of contents.
    pub headings: Vec<(u8, String, String)>,
}

impl Doc {
    pub fn footnote_number(&self, label: &str) -> Option<usize> {
        self.footnotes.iter().position(|(l, _)| l == label).map(|i| i + 1)
    }
}

/// Where the model gets things from outside the note.
pub struct Env<'a> {
    pub base: Dir,
    pub rendered: &'a Rendered,
    /// Vault-rooted path ("/a/b.png") of an image/PDF reference, if found.
    pub resolve_image: &'a dyn Fn(&str) -> Option<String>,
    /// Markdown of `![[Note]]` / `![[Note#H]]` / `![[Note#^id]]`.
    pub resolve_note: &'a dyn Fn(&str) -> Option<String>,
}

/// Plain text of inlines: what decides a paragraph's direction. Same as the
/// PDF's `plain`: images and math don't count, link and span text does.
pub fn plain(inl: &[Inline]) -> String {
    let mut s = String::new();
    fn go(inl: &[Inline], s: &mut String) {
        for i in inl {
            match i {
                Inline::Text(t) | Inline::Code(t) => s.push_str(t),
                Inline::Strong(b)
                | Inline::Emph(b)
                | Inline::Strike(b)
                | Inline::Underline(b)
                | Inline::Mark(_, b)
                | Inline::Sup(b)
                | Inline::Sub(b)
                | Inline::Link { body: b, .. }
                | Inline::Span { body: b, .. } => go(b, s),
                Inline::Break => s.push(' '),
                Inline::Image(_) | Inline::Media(_) | Inline::FootnoteRef(_) => {}
            }
        }
    }
    go(inl, &mut s);
    s
}

// ------------------------------------------------------------------ builder

enum F {
    Root,
    Para,
    Heading { level: u8, id: Option<String> },
    Quote { kind: Option<String>, title: Option<Vec<Inline>> },
    List { ordered: bool, start: u64, items: Vec<Item> },
    Item { task: Option<bool> },
    Footnote(String),
    Table { aligns: Vec<Align>, head: Vec<Vec<Inline>>, rows: Vec<Vec<Vec<Inline>>>, row: Vec<Vec<Inline>> },
    Cell,
    Code { lang: String, text: String },
    Emph,
    Strong,
    Strike,
    Sup,
    Sub,
    Underline,
    Mark,
    Link { url: String, wiki: bool },
    Image { url: String, wiki: bool },
    Span(Attrs),
    Div(Attrs),
    Meta,
}

struct Node {
    f: F,
    blocks: Vec<Block>,
    inl: Vec<Inline>,
}

struct B<'a> {
    stack: Vec<Node>,
    env: &'a Env<'a>,
    doc: Doc,
    depth: u8,
    ctx: BlockCtx,
    /// The callout marker ate the title; skip the line break after it.
    skip_break: bool,
}

impl<'a> B<'a> {
    fn push(&mut self, f: F) {
        self.stack.push(Node { f, blocks: vec![], inl: vec![] });
    }
    fn top(&mut self) -> &mut Node {
        self.stack.last_mut().unwrap()
    }
    fn inline(&mut self, i: Inline) {
        self.top().inl.push(i);
    }
    /// Block output goes to the innermost block container.
    fn block(&mut self, b: Block) {
        // Text waiting in a tight list item becomes a paragraph first.
        if matches!(self.top().f, F::Item { .. }) && !self.top().inl.is_empty() {
            let body = std::mem::take(&mut self.top().inl);
            let dir = self.dir(&plain(&body));
            self.top().blocks.push(Block::Para { dir, body });
        }
        self.top().blocks.push(b);
    }

    /// The direction of a block with text `p`: an enclosing `::: {dir}` or
    /// `{lang}` block, else the text, else the document's (md.rs `directed`).
    fn dir(&self, p: &str) -> Dir {
        for n in self.stack.iter().rev() {
            if let F::Div(attrs) = &n.f {
                for (k, v) in attrs.iter().rev() {
                    match (k.as_str(), v.as_str()) {
                        ("dir", "rtl") => return Dir::Rtl,
                        ("dir", "ltr") => return Dir::Ltr,
                        ("lang", l) if script::normalize_lang(l).is_some() => {
                            let l = script::normalize_lang(l).unwrap();
                            return if script::is_rtl_lang(&l) { Dir::Rtl } else { Dir::Ltr };
                        }
                        _ => {}
                    }
                }
            }
        }
        detect_dir(p).unwrap_or(self.env.base)
    }

    fn media(&mut self, typst: String, packages: Vec<&'static str>, inline: bool, tight: bool) -> usize {
        self.doc.media.push(MediaSrc { typst, packages, inline, tight });
        self.doc.media.len() - 1
    }

    fn start(&mut self, tag: Tag) {
        match tag {
            Tag::Paragraph => self.push(F::Para),
            Tag::Heading { level, id, .. } => self.push(F::Heading {
                level: match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    HeadingLevel::H3 => 3,
                    HeadingLevel::H4 => 4,
                    HeadingLevel::H5 => 5,
                    HeadingLevel::H6 => 6,
                },
                id: id.map(|i| i.to_string()),
            }),
            Tag::BlockQuote(kind) => self.push(F::Quote {
                kind: kind.map(|k| {
                    match k {
                        BlockQuoteKind::Note => "note",
                        BlockQuoteKind::Tip => "tip",
                        BlockQuoteKind::Important => "important",
                        BlockQuoteKind::Warning => "warning",
                        BlockQuoteKind::Caution => "caution",
                    }
                    .to_string()
                }),
                title: None,
            }),
            Tag::CodeBlock(kind) => {
                let lang = match kind {
                    CodeBlockKind::Fenced(info) => info.split_whitespace().next().unwrap_or("").to_lowercase(),
                    CodeBlockKind::Indented => String::new(),
                };
                self.push(F::Code { lang, text: String::new() })
            }
            Tag::HtmlBlock => {}
            Tag::List(start) => self.push(F::List { ordered: start.is_some(), start: start.unwrap_or(1), items: vec![] }),
            Tag::Item => self.push(F::Item { task: None }),
            Tag::FootnoteDefinition(l) => self.push(F::Footnote(l.to_string())),
            Tag::Table(al) => self.push(F::Table {
                aligns: al
                    .iter()
                    .map(|a| match a {
                        Alignment::Left => Align::Left,
                        Alignment::Center => Align::Center,
                        Alignment::Right => Align::Right,
                        Alignment::None => Align::None,
                    })
                    .collect(),
                head: vec![],
                rows: vec![],
                row: vec![],
            }),
            Tag::TableHead | Tag::TableRow => {}
            Tag::TableCell => self.push(F::Cell),
            Tag::Emphasis => self.push(F::Emph),
            Tag::Strong => self.push(F::Strong),
            Tag::Strikethrough => self.push(F::Strike),
            Tag::Superscript => self.push(F::Sup),
            Tag::Subscript => self.push(F::Sub),
            Tag::Link { link_type, dest_url, .. } => {
                let url = dest_url.to_string();
                let wiki = matches!(link_type, LinkType::WikiLink { .. })
                    || (!url.contains("://") && !url.starts_with('#') && !url.starts_with("mailto:"));
                self.push(F::Link { url, wiki })
            }
            Tag::Image { link_type, dest_url, .. } => {
                self.push(F::Image { url: dest_url.to_string(), wiki: matches!(link_type, LinkType::WikiLink { .. }) })
            }
            Tag::DefinitionList | Tag::DefinitionListTitle | Tag::DefinitionListDefinition => self.push(F::Para),
            Tag::MetadataBlock(_) => self.push(F::Meta),
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::HtmlBlock => return,
            TagEnd::TableHead => {
                if let F::Table { head, row, .. } = &mut self.top().f {
                    *head = std::mem::take(row);
                }
                return;
            }
            TagEnd::TableRow => {
                if let F::Table { rows, row, .. } = &mut self.top().f {
                    rows.push(std::mem::take(row));
                }
                return;
            }
            _ => {}
        }
        let Node { f, blocks, inl } = self.stack.pop().unwrap();
        match f {
            F::Root => unreachable!(),
            F::Para => {
                if inl.is_empty() {
                    return;
                }
                // An image alone on its line is a figure (centered, captioned).
                if let [Inline::Image(img)] = inl.as_slice() {
                    let caption = caption_of(&img.alt, &img.url);
                    self.block(Block::Figure { image: img.clone(), caption });
                    return;
                }
                if let [Inline::Media(id)] = inl.as_slice() {
                    if !self.doc.media[*id].inline {
                        self.block(Block::Media { id: *id, caption: None });
                        return;
                    }
                }
                let dir = self.dir(&plain(&inl));
                self.block(Block::Para { dir, body: inl });
            }
            F::Heading { level, id } => {
                let p = plain(&inl);
                let id = id.unwrap_or_else(|| md::heading_slug(&p));
                self.doc.headings.push((level, id.clone(), p.clone()));
                let dir = self.dir(&p);
                self.block(Block::Heading { level, id, dir, body: inl });
            }
            F::Quote { kind, title } => match kind {
                Some(k) => {
                    let (def, color) = md::callout_style(&k);
                    let title = title.unwrap_or_else(|| vec![Inline::Text(def.to_string())]);
                    let dir = self.dir(&(plain(&title) + " " + &blocks_plain(&blocks)));
                    self.block(Block::Callout { kind: k, color: color.to_string(), title, dir, blocks });
                }
                None => self.block(Block::Quote { blocks }),
            },
            F::Code { lang, text } => self.code(&lang, &text),
            F::List { ordered, start, items } => self.block(Block::List { ordered, start, items }),
            F::Item { task } => {
                let mut bl = blocks;
                if !inl.is_empty() {
                    let dir = self.dir(&plain(&inl));
                    bl.push(Block::Para { dir, body: inl });
                }
                let dir = self.dir(&blocks_plain(&bl));
                if let F::List { items, .. } = &mut self.top().f {
                    items.push(Item { task, dir, blocks: bl });
                }
            }
            F::Footnote(label) => {
                let mut bl = blocks;
                if !inl.is_empty() {
                    let dir = self.dir(&plain(&inl));
                    bl.push(Block::Para { dir, body: inl });
                }
                self.doc.footnotes.push((label, bl));
            }
            F::Cell => {
                if let F::Table { row, .. } = &mut self.top().f {
                    row.push(inl);
                }
            }
            F::Table { aligns, head, rows, .. } => {
                let mut p = String::new();
                for c in head.iter().chain(rows.iter().flatten()) {
                    p.push_str(&plain(c));
                    p.push(' ');
                }
                let dir = self.dir(&p);
                self.block(Block::Table { dir, aligns, head, rows });
            }
            F::Emph => self.inline(Inline::Emph(inl)),
            F::Strong => self.inline(Inline::Strong(inl)),
            F::Strike => self.inline(Inline::Strike(inl)),
            F::Sup => self.inline(Inline::Sup(inl)),
            F::Sub => self.inline(Inline::Sub(inl)),
            F::Underline => self.inline(Inline::Underline(inl)),
            F::Mark => self.inline(Inline::Mark(None, inl)),
            F::Span(attrs) => self.inline(Inline::Span { attrs, body: inl }),
            F::Link { url, wiki } => {
                // `[[Note#Heading]]` with no alias: a readable name, as in the PDF.
                let body = if wiki && plain(&inl).trim() == url.trim() && url.contains('#') {
                    vec![Inline::Text(md::wiki_display(&url))]
                } else {
                    inl
                };
                self.inline(Inline::Link { url, wiki, body })
            }
            F::Image { url, wiki } => self.image(url, wiki, plain(&inl)),
            F::Div(attrs) => {
                // Unclosed `:::` at the end: still a div.
                self.block(Block::Div { attrs, blocks });
            }
            F::Meta => {}
        }
    }

    fn code(&mut self, lang: &str, text: &str) {
        let key = (lang.to_string(), text.trim().to_string());
        if let Some(t) = self.env.rendered.get(&key) {
            let id = self.media(t.clone(), vec![], false, false);
            self.block(Block::Media { id, caption: None });
            return;
        }
        if lang.is_empty() {
            self.block(Block::Code { lang: String::new(), text: text.trim_end_matches('\n').to_string() });
            return;
        }
        match blocks::render(lang, text, &mut self.ctx) {
            Some(Ok((typst, pkgs))) => {
                let tight = matches!(lang, "math" | "latex" | "tex");
                let id = self.media(typst, pkgs, false, tight);
                self.block(Block::Media { id, caption: None });
            }
            Some(Err(msg)) => self.block(Block::Error(format!("{lang} block: {msg}"))),
            None => self.block(Block::Code { lang: lang.to_string(), text: text.trim_end_matches('\n').to_string() }),
        }
    }

    fn image(&mut self, url: String, wiki: bool, alt: String) {
        // Obsidian size: ![alt|300](x.png), ![[x.png|300]] (alt "300" for wikilinks).
        let (alt, width) = match alt.rsplit_once('|') {
            Some((a, w)) if w.trim().parse::<f64>().is_ok() => (a.trim().to_string(), w.trim().parse().ok()),
            _ if wiki && alt.trim().parse::<f64>().is_ok() => (String::new(), alt.trim().parse().ok()),
            _ => (alt.trim().to_string(), None),
        };
        let alt = if wiki && alt == url { String::new() } else { alt };
        let file = url.split('#').next().unwrap_or("");
        let ext = file.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
        // Note embeds and database views.
        if ext == "base" {
            let key = ("base".to_string(), format!("!embed {}", url.trim()));
            if let Some(t) = self.env.rendered.get(&key) {
                let id = self.media(t.clone(), vec![], false, false);
                self.inline(Inline::Media(id));
                self.doc.media[id].inline = false;
            }
            return;
        }
        if (ext.is_empty() || ext == "md") && !url.contains("://") {
            if self.depth >= 4 {
                self.inline(Inline::Text("…".into()));
                return;
            }
            if let Some(md) = (self.env.resolve_note)(&url) {
                let mut sub = B {
                    stack: vec![Node { f: F::Root, blocks: vec![], inl: vec![] }],
                    env: self.env,
                    doc: Doc::default(),
                    depth: self.depth + 1,
                    ctx: BlockCtx::default(),
                    skip_break: false,
                };
                // Media ids must stay unique: let the sub-builder append to ours.
                sub.doc.media = std::mem::take(&mut self.doc.media);
                run_all(&mut sub, &md);
                let (blocks, sdoc) = sub.finish();
                self.doc.media = sdoc.media;
                self.doc.footnotes.extend(sdoc.footnotes);
                // Close the paragraph we're in: an embed is a block.
                self.flush_para_then(Block::Embed { blocks });
                return;
            }
        }
        // PDF pages are drawn by Typst (it reads PDFs).
        if ext == "pdf" {
            let Some(path) = (self.env.resolve_image)(file) else {
                self.inline(Inline::Text(format!("[missing PDF: {file}]")));
                return;
            };
            let frag = url.split_once('#').map(|(_, f)| f).unwrap_or("");
            let page = frag.split('&').find_map(|kv| kv.strip_prefix("page=")).and_then(|p| p.parse::<u32>().ok()).unwrap_or(1).max(1);
            let w = width.map(|px| format!("{:.1}pt", px * 0.75)).unwrap_or_else(|| "100%".into());
            let typst = format!(
                "#align(center, block(stroke: 0.5pt + luma(200), image({}, page: {page}, width: {w})))",
                crate::render::typst_str(&path)
            );
            let id = self.media(typst, vec![], false, false);
            self.inline(Inline::Media(id));
            self.doc.media[id].inline = false;
            return;
        }
        let path = if url.contains("://") { None } else { (self.env.resolve_image)(&url).map(|p| p.trim_start_matches('/').to_string()) };
        self.inline(Inline::Image(ImageRef { path, url, alt, width }));
    }

    /// End the current paragraph (if any) before a block that appeared inline.
    fn flush_para_then(&mut self, b: Block) {
        if matches!(self.top().f, F::Para) {
            let inl = std::mem::take(&mut self.top().inl);
            if !inl.is_empty() {
                let dir = self.dir(&plain(&inl));
                let n = self.stack.len();
                self.stack[n - 2].blocks.push(Block::Para { dir, body: inl });
            }
            let n = self.stack.len();
            self.stack[n - 2].blocks.push(b);
        } else {
            self.block(b);
        }
    }

    fn html(&mut self, h: &str) {
        let h = h.trim();
        if let Some(inner) = h.strip_prefix("<!--").and_then(|s| s.strip_suffix("-->")) {
            let inner = inner.trim();
            if let Some(kind) = inner.strip_prefix("nz:callout") {
                // Everything so far in this paragraph is the callout's title.
                let kind = kind.trim().to_string();
                let title = std::mem::take(&mut self.top().inl);
                if let Some(q) = self.stack.iter_mut().rev().find(|n| matches!(n.f, F::Quote { .. })) {
                    q.f = F::Quote { kind: Some(kind), title: Some(title) };
                }
                self.skip_break = true;
            } else if let Some(attrs) = inner.strip_prefix("nz:div") {
                self.push(F::Div(md::parse_attrs(attrs)));
            } else if inner == "nz:/div" {
                if matches!(self.top().f, F::Div(_)) {
                    self.end(TagEnd::Paragraph); // closes the Div (frame decides)
                }
            } else if let Some(n) = inner.strip_prefix("nz:vspace") {
                self.block(Block::VSpace(n.trim().parse().unwrap_or(1).clamp(1, 50)));
            } else if inner.eq_ignore_ascii_case("pagebreak") {
                self.block(Block::PageBreak);
            } else if inner.eq_ignore_ascii_case("toc") {
                self.block(Block::Toc);
            }
            return;
        }
        let lower = h.to_ascii_lowercase();
        if let Some(rest) = h.strip_prefix("<span data-nz='") {
            let attrs = rest.trim_end_matches('>').trim_end_matches('\'');
            self.push(F::Span(md::parse_attrs(attrs)));
        } else if lower == "</span>" || lower == "</u>" || lower == "</mark>" {
            if matches!(self.top().f, F::Span(_) | F::Underline | F::Mark) {
                self.end(TagEnd::Emphasis);
            }
        } else if lower == "<u>" {
            self.push(F::Underline);
        } else if lower == "<mark>" {
            self.push(F::Mark);
        } else if lower.starts_with("<br") {
            self.inline(Inline::Break);
        }
    }

    fn finish(mut self) -> (Vec<Block>, Doc) {
        while self.stack.len() > 1 {
            let tag = match self.top().f {
                F::Para => TagEnd::Paragraph,
                _ => TagEnd::Emphasis, // the frame decides what is closed
            };
            self.end(tag);
        }
        let root = self.stack.pop().unwrap();
        (root.blocks, self.doc)
    }
}

fn blocks_plain(bl: &[Block]) -> String {
    let mut s = String::new();
    for b in bl {
        match b {
            Block::Para { body, .. } | Block::Heading { body, .. } => s.push_str(&plain(body)),
            Block::Quote { blocks } | Block::Div { blocks, .. } | Block::Embed { blocks } | Block::Callout { blocks, .. } => {
                s.push_str(&blocks_plain(blocks))
            }
            Block::List { items, .. } => items.iter().for_each(|i| s.push_str(&blocks_plain(&i.blocks))),
            _ => {}
        }
        s.push(' ');
    }
    s
}

/// The PDF's figure rule: alt text that isn't a file name is a caption.
fn caption_of(alt: &str, url: &str) -> Option<String> {
    let is_filename = alt.is_empty() || alt == url || alt.contains('.') && !alt.contains(' ');
    (!is_filename).then(|| alt.to_string())
}

fn run_all(b: &mut B, src: &str) {
    let pre = md::preprocess(src);
    let mut options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_HEADING_ATTRIBUTES
        | Options::ENABLE_MATH
        | Options::ENABLE_GFM
        | Options::ENABLE_WIKILINKS
        | Options::ENABLE_SUPERSCRIPT
        | Options::ENABLE_SUBSCRIPT;
    options.remove(Options::ENABLE_SMART_PUNCTUATION);
    let events: Vec<(Event, Range<usize>)> = Parser::new_ext(&pre, options).into_offset_iter().collect();
    for (ev, _) in events {
        match ev {
            Event::Start(t) => b.start(t),
            Event::End(t) => b.end(t),
            Event::Text(t) => {
                if let F::Code { text, .. } = &mut b.top().f {
                    text.push_str(&t);
                } else {
                    b.inline(Inline::Text(t.to_string()));
                }
            }
            Event::Code(t) => b.inline(Inline::Code(t.to_string())),
            Event::InlineMath(m) => {
                let id = b.media(format!("#mi({})", crate::render::typst_str(&m)), vec!["mitex"], true, true);
                b.inline(Inline::Media(id));
            }
            Event::DisplayMath(m) => {
                let id = b.media(format!("#mitex({})", crate::render::typst_str(&m)), vec!["mitex"], false, true);
                b.inline(Inline::Media(id));
            }
            Event::Html(h) | Event::InlineHtml(h) => b.html(&h),
            Event::FootnoteReference(l) => b.inline(Inline::FootnoteRef(l.to_string())),
            // A single Enter is a line break, as in the editor and the PDF.
            Event::SoftBreak => {
                if std::mem::take(&mut b.skip_break) {
                    continue;
                }
                b.inline(Inline::Break)
            }
            Event::HardBreak => b.inline(Inline::Break),
            Event::Rule => b.block(Block::Rule),
            Event::TaskListMarker(done) => {
                if let Some(n) = b.stack.iter_mut().rev().find(|n| matches!(n.f, F::Item { .. })) {
                    n.f = F::Item { task: Some(done) };
                }
            }
        }
        if !matches!(b.top().f, F::Para) {
            b.skip_break = false;
        }
    }
}

/// Read `body` (a note without its frontmatter) into a document.
pub fn build(body: &str, env: &Env) -> Doc {
    let mut b = B {
        stack: vec![Node { f: F::Root, blocks: vec![], inl: vec![] }],
        env,
        doc: Doc::default(),
        depth: 0,
        ctx: BlockCtx::default(),
        skip_break: false,
    };
    run_all(&mut b, body);
    let (blocks, mut doc) = b.finish();
    doc.blocks = blocks;
    // Footnotes in the order they are first referenced.
    let mut order: HashMap<String, usize> = HashMap::new();
    fn refs(bl: &[Block], out: &mut Vec<String>) {
        fn inl(i: &[Inline], out: &mut Vec<String>) {
            for x in i {
                match x {
                    Inline::FootnoteRef(l) => out.push(l.clone()),
                    Inline::Strong(b)
                    | Inline::Emph(b)
                    | Inline::Strike(b)
                    | Inline::Underline(b)
                    | Inline::Mark(_, b)
                    | Inline::Sup(b)
                    | Inline::Sub(b)
                    | Inline::Link { body: b, .. }
                    | Inline::Span { body: b, .. } => inl(b, out),
                    _ => {}
                }
            }
        }
        for b in bl {
            match b {
                Block::Para { body, .. } | Block::Heading { body, .. } => inl(body, out),
                Block::Callout { title, blocks, .. } => {
                    inl(title, out);
                    refs(blocks, out)
                }
                Block::Quote { blocks } | Block::Div { blocks, .. } | Block::Embed { blocks } => refs(blocks, out),
                Block::List { items, .. } => items.iter().for_each(|i| refs(&i.blocks, out)),
                Block::Table { head, rows, .. } => {
                    head.iter().for_each(|c| inl(c, out));
                    rows.iter().flatten().for_each(|c| inl(c, out));
                }
                _ => {}
            }
        }
    }
    let mut seen = vec![];
    refs(&doc.blocks, &mut seen);
    for l in seen {
        let n = order.len();
        order.entry(l).or_insert(n);
    }
    doc.footnotes.sort_by_key(|(l, _)| order.get(l).copied().unwrap_or(usize::MAX));
    doc.footnotes.retain(|(l, _)| order.contains_key(l));
    doc
}

/// Does the text need an Arabic-script font (for embedding one in HTML)?
pub fn has_rtl(text: &str) -> bool {
    text.chars().any(is_rtl_char)
}
