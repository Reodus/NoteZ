//! Markdown → Typst.
//!
//! Supported beyond CommonMark: GFM tables, task lists, strikethrough,
//! footnotes, alerts (`> [!NOTE]`), `$math$` (LaTeX, via MiTeX), wikilinks,
//! heading attributes, and NoteZ extensions:
//!
//! - fenced divs: `::: {align=center dir=ltr font="Inter" columns=2}` … `:::`
//! - inline spans: `[text]{color=#c00 size=14pt font="Vazirmatn" underline highlight=#ff0}`
//! - `<!-- pagebreak -->`, `<!-- toc -->`
//! - special code blocks: chart, diagram, draw, math, typst (+ plugin blocks)
//!
//! Every paragraph/heading/list item picks its text direction from its first
//! strong character, so Persian and English mix correctly in one document.

use pulldown_cmark::{
    Alignment, BlockQuoteKind, CodeBlockKind, Event, HeadingLevel, LinkType, Options, Parser, Tag, TagEnd,
};
use std::collections::{BTreeSet, HashMap};
use std::ops::Range;

use super::blocks::{self, BlockCtx};
use super::{escape_markup, typst_str as q};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dir {
    Rtl,
    Ltr,
}

fn is_rtl_char(c: char) -> bool {
    matches!(c as u32, 0x0590..=0x08FF | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFF)
}

/// Direction of a word or text: that of its first strong character, if any.
fn first_strong(text: &str) -> Option<Dir> {
    text.chars().find_map(|c| {
        if is_rtl_char(c) {
            Some(Dir::Rtl)
        } else if c.is_alphabetic() {
            Some(Dir::Ltr)
        } else {
            None
        }
    })
}

/// Paragraph direction: that of the first strong character, except that
/// text starting with a Latin word but mostly Persian (`Windows یک سیستم
/// عامل است`) is right-to-left. The editor uses the same rule
/// (src/editor/bidi.ts).
pub fn detect_dir(text: &str) -> Option<Dir> {
    match first_strong(text)? {
        Dir::Rtl => Some(Dir::Rtl),
        Dir::Ltr => {
            let (mut rtl, mut ltr) = (0, 0);
            for w in text.split_whitespace() {
                match first_strong(w) {
                    Some(Dir::Rtl) => rtl += 1,
                    Some(Dir::Ltr) => ltr += 1,
                    None => {}
                }
            }
            Some(if rtl > ltr { Dir::Rtl } else { Dir::Ltr })
        }
    }
}

/// Pre-rendered blocks supplied by the frontend (Mermaid, plugin blocks):
/// (lang, trimmed code) → Typst.
pub type Rendered = HashMap<(String, String), String>;

pub struct Output {
    pub typst: String,
    /// (generated line, source line) checkpoints, both 0-based, relative to
    /// the converted text (the caller shifts them).
    pub checkpoints: Vec<(usize, usize)>,
    /// Packages the output needs imported.
    pub packages: BTreeSet<&'static str>,
}

// ---------------------------------------------------------------- preprocess

fn parse_attrs(s: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut chars = s.trim().trim_start_matches('{').trim_end_matches('}').chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        let mut key = String::new();
        while let Some(&c) = chars.peek() {
            if c == '=' || c.is_whitespace() {
                break;
            }
            key.push(c);
            chars.next();
        }
        if key.is_empty() {
            break;
        }
        let mut val = String::new();
        if chars.peek() == Some(&'=') {
            chars.next();
            if chars.peek() == Some(&'"') {
                chars.next();
                for c in chars.by_ref() {
                    if c == '"' {
                        break;
                    }
                    val.push(c);
                }
            } else {
                while let Some(&c) = chars.peek() {
                    if c.is_whitespace() {
                        break;
                    }
                    val.push(c);
                    chars.next();
                }
            }
        }
        out.push((key, val));
    }
    out
}

/// Obsidian compatibility (outside inline code): `%% comments %%` are
/// dropped, `<center>…</center>` becomes a centered span and
/// `==text==` a highlight. `in_comment` carries multi-line `%%` comments.
fn rewrite_obsidian(line: &str, in_comment: &mut bool) -> String {
    // Comments first (they may span lines).
    let mut prose = String::with_capacity(line.len());
    let mut rest = line;
    loop {
        if *in_comment {
            match rest.find("%%") {
                Some(i) => {
                    *in_comment = false;
                    rest = &rest[i + 2..];
                }
                None => break,
            }
        } else {
            match rest.find("%%") {
                Some(i) => {
                    prose.push_str(&rest[..i]);
                    *in_comment = true;
                    rest = &rest[i + 2..];
                }
                None => {
                    prose.push_str(rest);
                    break;
                }
            }
        }
    }
    if !prose.contains('<') && !prose.contains("==") {
        return prose;
    }
    let mut out = String::with_capacity(prose.len() + 32);
    for (i, seg) in prose.split('`').enumerate() {
        if i > 0 {
            out.push('`');
        }
        if i % 2 == 1 {
            out.push_str(seg);
            continue;
        }
        let seg = seg
            .replace("<center>", "<span data-nz='align=center'>")
            .replace("<CENTER>", "<span data-nz='align=center'>")
            .replace("</center>", "</span>")
            .replace("</CENTER>", "</span>");
        // ==highlight== : no space just inside the markers.
        let mut rest = seg.as_str();
        while let Some(a) = rest.find("==") {
            let after = &rest[a + 2..];
            let ok_open = after.chars().next().is_some_and(|c| !c.is_whitespace() && c != '=');
            let close = if ok_open { after.find("==") } else { None };
            match close {
                Some(b) if !after[..b].ends_with(char::is_whitespace) && b > 0 => {
                    out.push_str(&rest[..a]);
                    out.push_str("<mark>");
                    out.push_str(&after[..b]);
                    out.push_str("</mark>");
                    rest = &after[b + 2..];
                }
                _ => {
                    out.push_str(&rest[..a + 2]);
                    rest = after;
                }
            }
        }
        out.push_str(rest);
    }
    out
}

/// `> [!type]± Title` (Obsidian/GitHub callout header) →
/// `> Title<!--nz:callout type-->`. The marker sits after the title so the
/// line stays a normal paragraph line inside the quote.
fn rewrite_callout(line: &str) -> String {
    let t = line.trim_start();
    if !t.starts_with('>') {
        return line.to_string();
    }
    let lead = line.len() - t.len();
    let prefix_len = t.len() - t.trim_start_matches(|c: char| c == '>' || c == ' ' || c == '\t').len();
    let rest = &t[prefix_len..];
    let Some(after) = rest.strip_prefix("[!") else { return line.to_string() };
    let Some(close) = after.find(']') else { return line.to_string() };
    let kind = &after[..close];
    if kind.is_empty() || !kind.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return line.to_string();
    }
    let title = after[close + 1..].trim_start_matches(['+', '-']).trim();
    let kind = kind.to_lowercase();
    let title = if title.is_empty() { callout_style(&kind).0.to_string() } else { title.to_string() };
    format!("{}{}{title}<!--nz:callout {kind}-->", &line[..lead], &t[..prefix_len])
}

/// Default title and color of a callout type.
pub fn callout_style(kind: &str) -> (&'static str, &'static str) {
    match kind {
        "tip" | "hint" => ("Tip", "#1f9d55"),
        "success" | "check" | "done" => ("Success", "#1f9d55"),
        "important" => ("Important", "#8a4fd8"),
        "example" => ("Example", "#8a4fd8"),
        "warning" | "attention" => ("Warning", "#c98a10"),
        "caution" => ("Caution", "#d13c3c"),
        "danger" | "error" => ("Danger", "#d13c3c"),
        "bug" => ("Bug", "#d13c3c"),
        "failure" | "fail" | "missing" => ("Failure", "#d13c3c"),
        "question" | "faq" | "help" => ("Question", "#0e8f9e"),
        "abstract" | "summary" | "tldr" => ("Summary", "#0e8f9e"),
        "quote" | "cite" => ("Quote", "#7a7f8f"),
        "todo" => ("To do", "#2f6fde"),
        "info" => ("Info", "#2f6fde"),
        _ => ("Note", "#2f6fde"),
    }
}

/// Rewrite `[text]{attrs}` (outside inline code) into span markers.
fn rewrite_spans(line: &str) -> String {
    if !line.contains("]{") {
        return line.to_string();
    }
    let mut out = String::new();
    // Split on backticks: even segments are prose, odd are inline code.
    for (i, seg) in line.split('`').enumerate() {
        if i > 0 {
            out.push('`');
        }
        if i % 2 == 1 {
            out.push_str(seg);
            continue;
        }
        let mut rest = seg;
        while let Some(close) = rest.find("]{") {
            let Some(end) = rest[close..].find('}').map(|e| close + e) else { break };
            // Find the matching '[' for this ']' (allow nested brackets).
            let bytes = rest.as_bytes();
            let mut depth = 0i32;
            let mut open = None;
            for j in (0..close).rev() {
                match bytes[j] {
                    b']' => depth += 1,
                    b'[' if depth == 0 => {
                        open = Some(j);
                        break;
                    }
                    b'[' => depth -= 1,
                    _ => {}
                }
            }
            let Some(open) = open else {
                out.push_str(&rest[..end + 1]);
                rest = &rest[end + 1..];
                continue;
            };
            let attrs = &rest[close + 2..end];
            out.push_str(&rest[..open]);
            out.push_str(&format!("<span data-nz='{}'>", attrs.replace('\'', "")));
            out.push_str(&rest[open + 1..close]);
            out.push_str("</span>");
            rest = &rest[end + 1..];
        }
        out.push_str(rest);
    }
    out
}

/// Line-preserving rewrite of NoteZ syntax into HTML markers that the
/// CommonMark parser passes through.
pub fn preprocess(src: &str) -> String {
    let mut lines: Vec<(String, &str)> = Vec::new();
    let mut blank: Vec<usize> = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut in_comment = false;
    for line in src.split_inclusive('\n') {
        let (body, nl) = match line.strip_suffix('\n') {
            Some(b) => (b, "\n"),
            None => (line, ""),
        };
        let trimmed = body.trim_start();
        // Track fenced code blocks so we never rewrite inside them.
        let fence_char = trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
        if let Some(fc) = fence_char {
            let n = trimmed.chars().take_while(|c| *c == fc).count();
            if n >= 3 {
                match fence {
                    None => fence = Some((fc, n)),
                    Some((c, len)) if c == fc && n >= len && trimmed[n..].trim().is_empty() => fence = None,
                    _ => {}
                }
                lines.push((body.to_string(), nl));
                continue;
            }
        }
        if fence.is_some() {
            lines.push((body.to_string(), nl));
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix(":::") {
            let attrs = rest.trim();
            let marker = if attrs.is_empty() { "<!--nz:/div-->".to_string() } else { format!("<!--nz:div {}-->", attrs.replace("--", "")) };
            lines.push((marker, nl));
            continue;
        }
        let was_comment = in_comment;
        let body = rewrite_obsidian(body, &mut in_comment);
        let body = rewrite_callout(&body);
        let body = rewrite_spans(&body);
        if !was_comment && body.trim().is_empty() {
            blank.push(lines.len());
        }
        lines.push((body, nl));
    }
    mark_blank_runs(&mut lines, &blank);
    let mut out = String::with_capacity(src.len() + 64);
    for (body, nl) in lines {
        out.push_str(&body);
        out.push_str(nl);
    }
    out
}

/// Extra empty lines become vertical space, as they look in the editor
/// (Markdown would collapse them). In a run of `n >= 2` blank lines the
/// second becomes `<!--nz:vspace n-1-->`, so the line count is unchanged.
/// Skipped where an HTML block would break the structure: before indented
/// lines (list continuations, indented code) and between list items.
fn mark_blank_runs(lines: &mut [(String, &str)], blank: &[usize]) {
    let is_item = |l: &str| {
        let t = l.trim_start();
        t.starts_with("- ") || t.starts_with("* ") || t.starts_with("+ ") || {
            let d = t.chars().take_while(|c| c.is_ascii_digit()).count();
            d > 0 && (t[d..].starts_with(". ") || t[d..].starts_with(") "))
        }
    };
    let mut i = 0;
    while i < blank.len() {
        let start = blank[i];
        let mut end = start;
        while i + 1 < blank.len() && blank[i + 1] == end + 1 {
            i += 1;
            end += 1;
        }
        i += 1;
        let n = end - start + 1;
        if n < 2 || start == 0 || end + 1 >= lines.len() {
            continue;
        }
        let prev = &lines[start - 1].0;
        let next = &lines[end + 1].0;
        if next.starts_with([' ', '\t']) || (is_item(prev) && is_item(next)) || prev.trim_start().starts_with('|') && next.trim_start().starts_with('|') {
            continue;
        }
        lines[start + 1].0 = format!("<!--nz:vspace {}-->", n - 1);
    }
}

// ---------------------------------------------------------------- converter

enum Frame {
    Root,
    Paragraph,
    Heading { level: usize, id: Option<String> },
    /// Callout type (`note`, `tip`…) or a plain quote.
    Quote(Option<String>),
    List { start: Option<u64>, items: Vec<String>, tight: bool },
    Item { task: Option<bool> },
    Table { aligns: Vec<Alignment>, head: Vec<String>, rows: Vec<Vec<String>>, row: Vec<String>, in_head: bool },
    Cell,
    Code { lang: String },
    Emph,
    Strong,
    Strike,
    Sup,
    Sub,
    Link { url: String, wiki: bool },
    Image { url: String },
    Div(Vec<(String, String)>),
    Span(Vec<(String, String)>),
    Underline,
    Mark,
    Footnote,
}

struct Node {
    frame: Frame,
    buf: String,
    plain: String,
}

struct Converter<'a> {
    stack: Vec<Node>,
    base: Dir,
    rendered: &'a Rendered,
    footnotes: HashMap<String, String>,
    packages: BTreeSet<&'static str>,
    checkpoints: Vec<(usize, usize)>,
    out_lines: usize,
    line_starts: Vec<usize>,
    resolve_image: &'a dyn Fn(&str) -> Option<String>,
    block_ctx: BlockCtx,
    /// The note has right-to-left text: keep Latin runs' brackets with them.
    rtl: bool,
}

fn lang_of(d: Dir) -> &'static str {
    match d {
        Dir::Rtl => "\"fa\"",
        Dir::Ltr => "\"en\"",
    }
}

fn dir_kw(d: Dir) -> &'static str {
    match d {
        Dir::Rtl => "rtl",
        Dir::Ltr => "ltr",
    }
}

impl<'a> Converter<'a> {
    fn push(&mut self, frame: Frame) {
        self.stack.push(Node { frame, buf: String::new(), plain: String::new() });
    }

    fn top(&mut self) -> &mut Node {
        self.stack.last_mut().unwrap()
    }

    fn emit(&mut self, s: &str) {
        self.top().buf.push_str(s);
    }

    fn text(&mut self, t: &str) {
        let esc = escape_markup(t);
        let top = self.top();
        top.buf.push_str(&esc);
        top.plain.push_str(t);
    }

    /// Wrap `content` so it uses direction `d` if that differs from the base.
    fn directed(&self, plain: &str, content: String) -> String {
        match detect_dir(plain) {
            Some(d) if d != self.base => {
                format!("#[#set text(dir: {}, lang: {})\n{}]", dir_kw(d), lang_of(d), content)
            }
            _ => content,
        }
    }

    fn line_of(&self, offset: usize) -> usize {
        self.line_starts.partition_point(|&s| s <= offset).saturating_sub(1)
    }

    /// Append finished block-level output to the parent.
    fn deliver(&mut self, s: String, plain: String, src_offset: Option<usize>) {
        let depth = self.stack.len();
        if depth == 1 {
            if let Some(off) = src_offset {
                let l = self.line_of(off);
                self.checkpoints.push((self.out_lines, l));
            }
            self.out_lines += s.matches('\n').count();
        }
        let top = self.top();
        top.buf.push_str(&s);
        top.plain.push_str(&plain);
        top.plain.push(' ');
    }

    fn pop(&mut self) -> Node {
        self.stack.pop().expect("frame stack underflow")
    }

    fn start(&mut self, tag: Tag, range: &Range<usize>) {
        let _ = range;
        match tag {
            Tag::Paragraph => self.push(Frame::Paragraph),
            Tag::Heading { level, id, .. } => {
                let level = match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    HeadingLevel::H3 => 3,
                    HeadingLevel::H4 => 4,
                    HeadingLevel::H5 => 5,
                    HeadingLevel::H6 => 6,
                };
                self.push(Frame::Heading { level, id: id.map(|i| i.to_string()) });
            }
            Tag::BlockQuote(kind) => self.push(Frame::Quote(kind.map(|k| {
                match k {
                    BlockQuoteKind::Note => "note",
                    BlockQuoteKind::Tip => "tip",
                    BlockQuoteKind::Important => "important",
                    BlockQuoteKind::Warning => "warning",
                    BlockQuoteKind::Caution => "caution",
                }
                .to_string()
            }))),
            Tag::CodeBlock(kind) => {
                let lang = match kind {
                    CodeBlockKind::Fenced(info) => info.split_whitespace().next().unwrap_or("").to_lowercase(),
                    CodeBlockKind::Indented => String::new(),
                };
                self.push(Frame::Code { lang });
            }
            Tag::HtmlBlock => {}
            Tag::List(start) => self.push(Frame::List { start, items: vec![], tight: true }),
            Tag::Item => self.push(Frame::Item { task: None }),
            Tag::FootnoteDefinition(_) => self.push(Frame::Footnote),
            Tag::Table(aligns) => self.push(Frame::Table {
                aligns,
                head: vec![],
                rows: vec![],
                row: vec![],
                in_head: false,
            }),
            Tag::TableHead => {
                if let Frame::Table { in_head, .. } = &mut self.top().frame {
                    *in_head = true;
                }
            }
            Tag::TableRow => {}
            Tag::TableCell => self.push(Frame::Cell),
            Tag::Emphasis => self.push(Frame::Emph),
            Tag::Strong => self.push(Frame::Strong),
            Tag::Strikethrough => self.push(Frame::Strike),
            Tag::Superscript => self.push(Frame::Sup),
            Tag::Subscript => self.push(Frame::Sub),
            Tag::Link { link_type, dest_url, .. } => self.push(Frame::Link {
                url: dest_url.to_string(),
                wiki: matches!(link_type, LinkType::WikiLink { .. }),
            }),
            Tag::Image { dest_url, .. } => self.push(Frame::Image { url: dest_url.to_string() }),
            Tag::DefinitionList | Tag::DefinitionListTitle | Tag::DefinitionListDefinition => {
                self.push(Frame::Paragraph)
            }
            Tag::MetadataBlock(_) => self.push(Frame::Code { lang: "__meta".into() }),
        }
    }

    fn end(&mut self, tag: TagEnd, range: &Range<usize>) {
        match tag {
            TagEnd::HtmlBlock | TagEnd::TableRow => {
                if matches!(tag, TagEnd::TableRow) {
                    if let Frame::Table { rows, row, .. } = &mut self.top().frame {
                        rows.push(std::mem::take(row));
                    }
                }
                return;
            }
            TagEnd::TableHead => {
                if let Frame::Table { head, row, in_head, .. } = &mut self.top().frame {
                    *head = std::mem::take(row);
                    *in_head = false;
                }
                return;
            }
            _ => {}
        }
        let node = self.pop();
        let Node { frame, buf, plain } = node;
        let start = Some(range.start);
        match frame {
            Frame::Paragraph => {
                let body = self.directed(&plain, buf);
                self.deliver(format!("{body}\n\n"), plain, start);
            }
            Frame::Heading { level, id } => {
                // Explicit `{#id}`, else `h:<slug>` so `[[#Heading]]` links can find it.
                let label = match id {
                    Some(i) => format!(" <{}>", sanitize_label(&i)),
                    None => match heading_slug(&plain) {
                        s if s.is_empty() => String::new(),
                        s => format!(" <h:{s}>"),
                    },
                };
                let h = format!("#heading(level: {level})[{buf}]{label}");
                let body = self.directed(&plain, h);
                self.deliver(format!("{body}\n\n"), plain, start);
            }
            Frame::Quote(kind) => {
                let s = match kind {
                    None => format!("#quote(block: true)[\n{buf}]\n\n"),
                    Some(k) => {
                        let (title, color) = callout_style(&k);
                        // Callouts from `[!x] Title` lines carry their title in `buf`
                        // already; GitHub-style alerts get the default one.
                        let head = if buf.contains("<<nz-title>>") {
                            String::new()
                        } else {
                            format!("#text(weight: \"bold\", fill: rgb(\"{color}\"))[{title}] \\\n")
                        };
                        let buf = buf.replace("<<nz-title>>", "");
                        format!(
                            "#block(width: 100%, inset: (x: 12pt, y: 9pt), radius: 4pt, fill: rgb(\"{color}\").lighten(90%), stroke: (left: 3pt + rgb(\"{color}\")))[{head}{buf}]\n\n"
                        )
                    }
                };
                self.deliver(s, plain, start);
            }
            Frame::Code { lang } => {
                if lang == "__meta" {
                    return;
                }
                let s = self.code_block(&lang, &buf);
                self.deliver(s, String::new(), start);
            }
            Frame::List { start: num, items, tight } => {
                let func = match num {
                    Some(n) if n != 1 => format!("#enum(start: {n}, tight: {tight}"),
                    Some(_) => format!("#enum(tight: {tight}"),
                    None => format!("#list(tight: {tight}"),
                };
                let items: Vec<String> = items.into_iter().map(|i| format!("[{i}]")).collect();
                let body = format!("{func}, {})", items.join(", "));
                let body = self.directed(&plain, body);
                self.deliver(format!("{body}\n\n"), plain, start);
            }
            Frame::Item { task } => {
                let mut content = buf.trim_end().to_string();
                if let Some(done) = task {
                    let mark = if done { "☑" } else { "☐" };
                    content = format!("{mark} {content}");
                }
                let loose = content.contains("\n\n");
                if let Frame::List { items, tight, .. } = &mut self.top().frame {
                    items.push(content);
                    if loose {
                        *tight = false;
                    }
                }
                let top = self.top();
                top.plain.push_str(&plain);
                top.plain.push(' ');
            }
            Frame::Cell => {
                if let Frame::Table { row, .. } = &mut self.top().frame {
                    row.push(buf);
                }
                let top = self.top();
                top.plain.push_str(&plain);
                top.plain.push(' ');
            }
            Frame::Table { aligns, head, rows, .. } => {
                let cols = aligns.len().max(head.len()).max(1);
                let al: Vec<&str> = aligns
                    .iter()
                    .map(|a| match a {
                        Alignment::Left => "left",
                        Alignment::Center => "center",
                        Alignment::Right => "right",
                        Alignment::None => "start",
                    })
                    .collect();
                let mut cells = Vec::new();
                if !head.is_empty() {
                    let h: Vec<String> = head.iter().map(|c| format!("[{c}]")).collect();
                    cells.push(format!("table.header({})", h.join(", ")));
                }
                for r in &rows {
                    for i in 0..cols {
                        cells.push(format!("[{}]", r.get(i).map(String::as_str).unwrap_or("")));
                    }
                }
                let t = format!(
                    "#align(center, table(columns: {cols}, align: ({},), {}))",
                    al.join(", "),
                    cells.join(", ")
                );
                let body = self.directed(&plain, t);
                self.deliver(format!("{body}\n\n"), plain, start);
            }
            Frame::Emph => self.inline(format!("#emph[{buf}]"), plain),
            Frame::Strong => self.inline(format!("#strong[{buf}]"), plain),
            Frame::Strike => self.inline(format!("#strike[{buf}]"), plain),
            Frame::Sup => self.inline(format!("#super[{buf}]"), plain),
            Frame::Sub => self.inline(format!("#sub[{buf}]"), plain),
            Frame::Underline => self.inline(format!("#underline[{buf}]"), plain),
            Frame::Mark => self.inline(format!("#highlight[{buf}]"), plain),
            Frame::Link { url, wiki } => {
                let s = if let Some(slug) = url.strip_prefix('#').map(|h| heading_slug(&super::percent_decode(h))).filter(|s| !s.is_empty()) {
                    // A heading in this note: a real PDF link when it exists.
                    format!(
                        "#context {{ let t = query(label({})); if t.len() > 0 {{ link(t.first().location())[#text(fill: rgb(\"#2f5fc4\"))[{buf}]] }} else [#text(fill: rgb(\"#2f5fc4\"))[{buf}]] }}",
                        q(&format!("h:{slug}"))
                    )
                } else if wiki || url.starts_with('#') || !url.contains(':') {
                    // Note-to-note link: no target in a PDF, keep styled text.
                    format!("#text(fill: rgb(\"#2f5fc4\"))[{buf}]")
                } else {
                    format!("#link({})[{buf}]", q(&url))
                };
                self.inline(s, plain);
            }
            Frame::Image { url } => {
                let s = self.image(&url, &plain);
                self.inline(s, plain);
            }
            Frame::Footnote => {}
            Frame::Span(attrs) => {
                let s = span_markup(&attrs, &buf);
                self.inline(s, plain);
            }
            Frame::Div(_) | Frame::Root => {
                // Unbalanced; put it back.
                self.stack.push(Node { frame, buf, plain });
            }
        }
    }

    fn inline(&mut self, s: String, plain: String) {
        let top = self.top();
        top.buf.push_str(&s);
        top.plain.push_str(&plain);
    }

    fn image(&mut self, url: &str, alt: &str) -> String {
        // Obsidian-style size: ![alt|300](x.png) or ![[x.png|300]]
        let (alt, width) = match alt.rsplit_once('|') {
            Some((a, w)) if w.trim().parse::<f64>().is_ok() => (a.trim(), Some(w.trim().parse::<f64>().unwrap())),
            _ => (alt.trim(), None),
        };
        if url.starts_with("http://") || url.starts_with("https://") {
            return format!("#text(fill: luma(120))[\\[image: {}\\]]", escape_markup(url));
        }
        let Some(path) = (self.resolve_image)(url) else {
            return format!("#text(fill: red)[\\[missing image: {}\\]]", escape_markup(url));
        };
        let w = width.map(|px| format!("{:.1}pt", px * 0.75)).unwrap_or_else(|| "auto".into());
        let img = format!("nz-image({}, width: {w})", q(&path));
        let is_filename = alt.is_empty() || alt == url || alt.contains('.') && !alt.contains(' ');
        if is_filename {
            format!("#align(center, {img})")
        } else {
            format!("#figure({img}, caption: [{}])", escape_markup(alt))
        }
    }

    fn code_block(&mut self, lang: &str, code: &str) -> String {
        let trimmed = code.trim().to_string();
        if let Some(t) = self.rendered.get(&(lang.to_string(), trimmed.clone())) {
            return format!("{t}\n\n");
        }
        match blocks::render(lang, code, &mut self.block_ctx) {
            Some(Ok((typst, pkgs))) => {
                self.packages.extend(pkgs);
                format!("{typst}\n\n")
            }
            Some(Err(msg)) => format!("{}\n\n", blocks::error_box(lang, &msg)),
            None => format!(
                "#raw(block: true, lang: {}, {})\n\n",
                q(if lang.is_empty() { "txt" } else { lang }),
                q(code.trim_end_matches('\n'))
            ),
        }
    }

    fn html(&mut self, html: &str, block: bool) {
        let h = html.trim();
        if let Some(inner) = h.strip_prefix("<!--").and_then(|s| s.strip_suffix("-->")) {
            let inner = inner.trim();
            if let Some(kind) = inner.strip_prefix("nz:callout") {
                self.callout_title(kind.trim());
                return;
            }
            if let Some(attrs) = inner.strip_prefix("nz:div") {
                self.push(Frame::Div(parse_attrs(attrs)));
            } else if inner == "nz:/div" {
                self.close_div();
            } else if let Some(n) = inner.strip_prefix("nz:vspace") {
                let n: f32 = n.trim().parse().unwrap_or(1.0);
                self.deliver(format!("#v({:.1}em)\n\n", n * 1.2), String::new(), None);
            } else if inner.eq_ignore_ascii_case("pagebreak") {
                self.deliver("#pagebreak()\n\n".into(), String::new(), None);
            } else if inner.eq_ignore_ascii_case("toc") {
                self.deliver("#outline(depth: 3)\n\n".into(), String::new(), None);
            }
            return;
        }
        let lower = h.to_ascii_lowercase();
        if let Some(rest) = h.strip_prefix("<span data-nz='") {
            let attrs = rest.trim_end_matches('>').trim_end_matches('\'');
            self.push(Frame::Span(parse_attrs(attrs)));
        } else if lower == "</span>" || lower == "</u>" || lower == "</mark>" {
            if matches!(self.top().frame, Frame::Span(_) | Frame::Underline | Frame::Mark) {
                self.end(TagEnd::Emphasis, &(0..0)); // frame kind decides; tag unused
            }
        } else if lower == "<u>" {
            self.push(Frame::Underline);
        } else if lower == "<mark>" {
            self.push(Frame::Mark);
        } else if lower.starts_with("<br") {
            self.emit("#linebreak()");
        } else if block {
            // Unknown block HTML is dropped from the PDF.
        }
    }

    /// Everything written so far in the current paragraph is the callout's
    /// title: style it and mark the enclosing quote as a callout.
    fn callout_title(&mut self, kind: &str) {
        let Some(qi) = self.stack.iter().rposition(|n| matches!(n.frame, Frame::Quote(_))) else { return };
        if let Frame::Quote(k) = &mut self.stack[qi].frame {
            *k = Some(kind.to_string());
        }
        if !matches!(self.top().frame, Frame::Paragraph) {
            return;
        }
        let (_, color) = callout_style(kind);
        let title = std::mem::take(&mut self.top().buf);
        self.top().buf = format!("<<nz-title>>#text(weight: \"bold\", fill: rgb(\"{color}\"))[{}] \\\n", title.trim());
    }

    fn close_div(&mut self) {
        if !matches!(self.top().frame, Frame::Div(_)) {
            return;
        }
        let Node { frame: Frame::Div(attrs), buf, plain } = self.pop() else { unreachable!() };
        let s = div_markup(&attrs, &buf);
        self.deliver(s, plain, None);
    }

    fn finish(mut self) -> Output {
        while self.stack.len() > 1 {
            if matches!(self.top().frame, Frame::Div(_)) {
                self.close_div();
            } else {
                let n = self.pop();
                self.top().buf.push_str(&n.buf);
            }
        }
        Output { typst: self.pop().buf, checkpoints: self.checkpoints, packages: self.packages }
    }
}

/// Label-safe slug of a heading's text (`[[#Heading]]` targets).
fn heading_slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() || matches!(c, '_' | '.') {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_string()
}

fn sanitize_label(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ':')).collect()
}

/// Typst `text(...)` args from span/div attributes.
fn text_args(attrs: &[(String, String)]) -> Vec<String> {
    let mut a = Vec::new();
    for (k, v) in attrs {
        match k.as_str() {
            "font" if !v.is_empty() => a.push(format!("font: ({}, \"Vazirmatn\")", q(v))),
            "size" if super::is_length(v) => a.push(format!("size: {v}")),
            "color" => {
                if let Some(c) = super::styles::color(v) {
                    a.push(format!("fill: {c}"));
                }
            }
            "bold" => a.push("weight: \"bold\"".into()),
            "weight" if v.chars().all(|c| c.is_ascii_alphanumeric()) && !v.is_empty() => {
                if v.chars().all(|c| c.is_ascii_digit()) {
                    a.push(format!("weight: {v}"));
                } else {
                    a.push(format!("weight: {}", q(v)));
                }
            }
            "italic" => a.push("style: \"italic\"".into()),
            "dir" if v == "rtl" || v == "ltr" => {
                a.push(format!("dir: {v}"));
                a.push(format!("lang: {}", if v == "rtl" { "\"fa\"" } else { "\"en\"" }));
            }
            _ => {}
        }
    }
    a
}

fn span_markup(attrs: &[(String, String)], body: &str) -> String {
    let args = text_args(attrs);
    let mut s = if args.is_empty() { body.to_string() } else { format!("#text({})[{body}]", args.join(", ")) };
    for (k, v) in attrs {
        match k.as_str() {
            "underline" => s = format!("#underline[{s}]"),
            "strike" => s = format!("#strike[{s}]"),
            "highlight" | "bg" => {
                let fill = super::styles::color(v).unwrap_or_else(|| "rgb(\"#fff3a3\")".into());
                s = format!("#highlight(fill: {fill})[{s}]");
            }
            _ => {}
        }
    }
    if let Some((_, a)) = attrs.iter().find(|(k, _)| k == "align") {
        if matches!(a.as_str(), "left" | "right" | "center" | "start" | "end") {
            s = format!("#align({a})[{s}]");
        }
    }
    s
}

fn div_markup(attrs: &[(String, String)], body: &str) -> String {
    let mut sets = Vec::new();
    let mut columns = None;
    let mut boxed = None;
    for (k, v) in attrs {
        match (k.as_str(), v.as_str()) {
            ("align", "justify") => sets.push("#set par(justify: true)".to_string()),
            ("align", a @ ("left" | "right" | "center" | "start" | "end")) => {
                sets.push(format!("#set par(justify: false)\n#set align({a})"))
            }
            ("columns", n) => columns = n.parse::<u32>().ok().filter(|c| (2..=4).contains(c)),
            ("box", c) => boxed = Some(super::styles::color(c).unwrap_or_else(|| "rgb(\"#7b93d1\")".into())),
            _ => {}
        }
    }
    let args = text_args(attrs);
    if !args.is_empty() {
        sets.push(format!("#set text({})", args.join(", ")));
    }
    let inner = format!("{}\n{}", sets.join("\n"), body);
    let inner = match columns {
        Some(n) => format!("#columns({n})[{inner}]"),
        None => inner,
    };
    match boxed {
        Some(c) => format!(
            "#block(width: 100%, inset: 12pt, radius: 6pt, stroke: 0.8pt + {c}, fill: {c}.lighten(92%))[{inner}]\n\n"
        ),
        None => format!("#block(width: 100%)[{inner}]\n\n"),
    }
}

pub struct Options2<'a> {
    pub base: Dir,
    pub rendered: &'a Rendered,
    pub resolve_image: &'a dyn Fn(&str) -> Option<String>,
}

pub fn convert(src: &str, opts: &Options2) -> Output {
    let pre = preprocess(src);
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

    let mut line_starts = vec![0];
    line_starts.extend(pre.match_indices('\n').map(|(i, _)| i + 1));

    let new_conv = |line_starts: Vec<usize>| Converter {
        stack: vec![Node { frame: Frame::Root, buf: String::new(), plain: String::new() }],
        base: opts.base,
        rendered: opts.rendered,
        footnotes: HashMap::new(),
        packages: BTreeSet::new(),
        checkpoints: vec![],
        out_lines: 0,
        line_starts,
        resolve_image: opts.resolve_image,
        block_ctx: BlockCtx::default(),
        rtl: src.chars().any(super::bidi::is_rtl_char),
    };

    // Pass 1: footnote definitions → Typst, keyed by label.
    let mut footnotes = HashMap::new();
    let mut packages = BTreeSet::new();
    let mut i = 0;
    let mut skip = vec![false; events.len()];
    while i < events.len() {
        if let Event::Start(Tag::FootnoteDefinition(label)) = &events[i].0 {
            let label = label.to_string();
            let mut depth = 0;
            let mut j = i;
            loop {
                match &events[j].0 {
                    Event::Start(_) => depth += 1,
                    Event::End(_) => depth -= 1,
                    _ => {}
                }
                skip[j] = true;
                if depth == 0 {
                    break;
                }
                j += 1;
                if j >= events.len() {
                    break;
                }
            }
            let mut c = new_conv(vec![0]);
            for (ev, r) in &events[i + 1..j.min(events.len())] {
                run(&mut c, ev.clone(), r);
            }
            let out = c.finish();
            packages.extend(out.packages);
            footnotes.insert(label, out.typst.trim().to_string());
            i = j + 1;
        } else {
            i += 1;
        }
    }

    // Pass 2: the document.
    let mut c = new_conv(line_starts);
    c.footnotes = footnotes;
    c.packages = packages;
    for (idx, (ev, r)) in events.into_iter().enumerate() {
        if !skip[idx] {
            run(&mut c, ev, &r);
        }
    }
    c.finish()
}

fn run(c: &mut Converter, ev: Event, r: &Range<usize>) {
    match ev {
        Event::Start(tag) => c.start(tag, r),
        Event::End(tag) => c.end(tag, r),
        Event::Text(t) => {
            if matches!(c.top().frame, Frame::Code { .. }) {
                c.emit(&t);
            } else if c.rtl {
                c.text(&super::bidi::mark_runs(&t));
            } else {
                c.text(&t);
            }
        }
        Event::Code(t) => {
            let s = format!("#raw({})", q(&t));
            c.inline(s, t.to_string());
        }
        Event::InlineMath(m) => {
            c.packages.insert("mitex");
            c.inline(format!("#mi({})", q(&m)), String::new());
        }
        Event::DisplayMath(m) => {
            c.packages.insert("mitex");
            c.inline(format!("#mitex({})", q(&m)), String::new());
        }
        Event::Html(h) => c.html(&h, true),
        Event::InlineHtml(h) => c.html(&h, false),
        Event::FootnoteReference(label) => {
            let body = c.footnotes.get(label.as_ref()).cloned().unwrap_or_else(|| "?".into());
            c.emit(&format!("#footnote[{body}]"));
        }
        // A single Enter is a line break, as in Obsidian ("strict line breaks" off).
        Event::SoftBreak => {
            let top = c.top();
            if !top.buf.ends_with("\\\n") {
                top.buf.push_str(" \\\n");
            }
            top.plain.push(' ');
        }
        Event::HardBreak => c.emit(" \\\n"),
        Event::Rule => c.deliver(
            "#line(length: 100%, stroke: 0.5pt + luma(170))\n\n".into(),
            String::new(),
            Some(r.start),
        ),
        Event::TaskListMarker(done) => {
            if let Frame::Item { task } = &mut c.top().frame {
                *task = Some(done);
            } else if let Some(node) = c.stack.iter_mut().rev().find(|n| matches!(n.frame, Frame::Item { .. })) {
                if let Frame::Item { task } = &mut node.frame {
                    *task = Some(done);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conv(src: &str) -> String {
        let rendered = Rendered::new();
        let resolve = |u: &str| Some(format!("/{u}"));
        convert(src, &Options2 { base: Dir::Rtl, rendered: &rendered, resolve_image: &resolve }).typst
    }

    #[test]
    fn obsidian_callouts() {
        let out = conv("> [!tip] نکتهٔ مهم\n> متن **پررنگ**\n\n> [!QUOTE]\n> quoted\n\n> [!NOTE]\n> gfm\n");
        assert!(out.contains("#1f9d55") && out.contains("نکتهٔ مهم"), "{out}");
        assert!(out.contains("[Quote]"), "{out}");
        assert!(!out.contains("[!"), "{out}");
        assert!(!out.contains("nz-title"), "{out}");
    }

    #[test]
    fn obsidian_syntax() {
        let out = conv("<center>تصویر ۱: شرح</center>\n\nمتن ==مهم== و `a==b` %%پنهان%% پایان\n\n%%\nchunk\n%%\nآخر\n");
        assert!(out.contains("#align(center)["), "{out}");
        assert!(out.contains("شرح"), "{out}");
        assert!(out.contains("#highlight"), "{out}");
        assert!(!out.contains("پنهان") && !out.contains("chunk"), "{out}");
        assert!(out.contains("a==b"), "{out}");
        assert!(out.contains("آخر"), "{out}");
    }

    #[test]
    fn direction_detection() {
        assert_eq!(detect_dir("سلام world"), Some(Dir::Rtl));
        assert_eq!(detect_dir("123 hello سلام"), Some(Dir::Ltr));
        assert_eq!(detect_dir("123 !!"), None);
        assert_eq!(detect_dir("windows یک سیستم عامل باحال"), Some(Dir::Rtl));
        assert_eq!(detect_dir("Visual Studio Code ویرایشگر"), Some(Dir::Ltr));
    }

    #[test]
    fn same_note_heading_links() {
        let out = conv("[[#مقدمه اول|برو]]\n\n## مقدمه اول\n\n[x](#Intro%20Two)\n\n# Intro Two\n");
        assert!(out.contains("<h:مقدمه-اول>"), "{out}");
        assert!(out.contains("label(\"h:مقدمه-اول\")"), "{out}");
        assert!(out.contains("<h:intro-two>") && out.contains("label(\"h:intro-two\")"), "{out}");
    }

    #[test]
    fn blank_lines_become_space() {
        let out = conv("a\nb\n\n\n\nc\n\nd\n");
        assert!(out.contains("a \\\nb"), "{out}");
        assert_eq!(out.matches("#v(").count(), 1, "{out}");
        assert!(out.contains("#v(2.4em)"), "{out}");
        // Lists stay one list; indented continuations stay attached.
        let out = conv("- x\n\n\n- y\n\n\n  more\n");
        assert!(!out.contains("#v("), "{out}");
        // Inside code fences nothing changes.
        let out = conv("```\nx\n\n\n\ny\n```\n");
        assert!(!out.contains("#v("), "{out}");
        // Line count is preserved.
        assert_eq!(preprocess("a\n\n\n\nb\n").lines().count(), 5);
    }

    #[test]
    fn mixed_paragraphs() {
        let out = conv("# عنوان\n\nسلام دنیا\n\nHello world\n");
        assert!(out.contains("#heading(level: 1)[عنوان]"));
        assert!(out.contains("سلام دنیا"));
        assert!(out.contains("#[#set text(dir: ltr, lang: \"en\")\nHello world"));
    }

    #[test]
    fn escapes_special_chars() {
        let out = conv("a*b #c $d [e] 1. f // g\n");
        assert!(out.contains("a\\*b \\#c"), "{out}");
        assert!(out.contains("\\[e\\]"));
        assert!(out.contains("\\/\\/"));
    }

    #[test]
    fn spans_and_divs() {
        let out = conv("::: {align=center}\nمتن [رنگی]{color=#ff0000 underline}\n:::\n");
        assert!(out.contains("#set align(center)"), "{out}");
        assert!(out.contains("#underline[#text(fill: rgb(\"#ff0000\"))[رنگی]]"), "{out}");
    }

    #[test]
    fn spans_not_rewritten_in_code() {
        let pre = preprocess("`[a]{b}` and\n```\n[x]{y}\n```\n");
        assert!(pre.contains("`[a]{b}`"));
        assert!(pre.contains("[x]{y}"));
    }

    #[test]
    fn lists_tables_footnotes() {
        let out = conv("- a\n- [x] b\n\n| A | B |\n|:-|-:|\n| 1 | 2 |\n\nText[^n]\n\n[^n]: note\n");
        assert!(out.contains("#list(tight: true, [a], [☑ b])"), "{out}");
        assert!(out.contains("Text#footnote["), "{out}");
        assert!(out.contains("table(columns: 2, align: (left, right,)"), "{out}");
        assert!(out.contains("note]]"), "{out}");
    }

    #[test]
    fn code_and_math() {
        let out = conv("```rust\nfn main() {}\n```\n\n$x^2$\n");
        assert!(out.contains("#raw(block: true, lang: \"rust\", \"fn main() {}\")"), "{out}");
        assert!(out.contains("#mi(\"x^2\")"));
    }

    #[test]
    fn checkpoints_track_lines() {
        let rendered = Rendered::new();
        let resolve = |u: &str| Some(u.to_string());
        let out = convert("a\n\nb\n\n# c\n", &Options2 { base: Dir::Rtl, rendered: &rendered, resolve_image: &resolve });
        let src_lines: Vec<usize> = out.checkpoints.iter().map(|c| c.1).collect();
        assert_eq!(src_lines, vec![0, 2, 4]);
    }
}
