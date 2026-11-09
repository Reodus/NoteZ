//! Portable Markdown: the note rewritten so GitHub, VS Code and other
//! Markdown apps show it as NoteZ does. Written line by line, so the user's
//! own formatting is kept; only NoteZ/Obsidian syntax is translated:
//!
//! - `[[Note]]`, `[[Note|text]]`, `[[Note#Heading]]` → `[text](rel/Note.md#heading)`
//! - `![[img.png|300]]`, `![](img.png)` → files copied to `<name>_files/`
//! - `![[doc.pdf#page=2]]`, chart/flow/mindmap/timeline/diagram/draw/typst
//!   blocks and database views → SVG drawn by the PDF engine (the source
//!   stays below it in a collapsed `<details>`); mermaid and math stay as is
//! - `![[Other note]]` → that note's text, inlined
//! - callouts → GitHub alerts; `==mark==`, `[t]{…}`, `::: {…}` → HTML
//! - `%% comments %%`, block ids and `<!-- pagebreak -->` are removed;
//!   `<!-- toc -->` becomes a list of links

use std::collections::HashMap;
use std::path::Path;

use super::model::MediaSrc;
use super::{draw_items, html};
use crate::render::blocks::{self, BlockCtx};
use crate::render::md::{self, Rendered};
use crate::render::world::NoteWorld;
use crate::render::{self as r};

type Res<T> = Result<T, String>;

/// Blocks GitHub draws itself.
const NATIVE: &[&str] = &["mermaid", "math"];

struct Out<'a> {
    root: &'a Path,
    note: String,
    files_dir: std::path::PathBuf,
    /// "<name>_files" as written in links.
    files_ref: String,
    /// vault path → exported file name
    copied: HashMap<String, String>,
    media: Vec<(MediaSrc, String)>,
    warnings: Vec<String>,
    resolve_note: &'a dyn Fn(&str, &str) -> Option<String>,
    rendered: &'a Rendered,
    ctx: BlockCtx,
}

/// Percent-encode what would end a Markdown link target.
fn url_path(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '(' => "%28".to_string(),
            ')' => "%29".to_string(),
            '<' => "%3C".to_string(),
            '>' => "%3E".to_string(),
            c => c.to_string(),
        })
        .collect()
}

/// GitHub's heading anchor: lowercase, spaces → '-', punctuation dropped.
pub fn github_slug(s: &str) -> String {
    s.trim()
        .chars()
        .flat_map(char::to_lowercase)
        .filter_map(|c| match c {
            ' ' => Some('-'),
            c if c.is_alphanumeric() || c == '-' || c == '_' => Some(c),
            _ => None,
        })
        .collect()
}

/// `to` relative to the folder `from_dir` (both vault-relative).
fn relative(from_dir: &str, to: &str) -> String {
    let a: Vec<&str> = from_dir.split('/').filter(|s| !s.is_empty()).collect();
    let b: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let mut parts: Vec<&str> = vec![".."; a.len() - common];
    parts.extend(&b[common..]);
    parts.join("/")
}

impl<'a> Out<'a> {
    fn note_dir(&self) -> &str {
        self.note.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
    }

    /// Copy a vault file next to the export; returns its link target.
    fn copy(&mut self, rel: &str) -> Option<String> {
        let rel = rel.trim_start_matches('/').to_string();
        if let Some(name) = self.copied.get(&rel) {
            return Some(format!("{}/{}", self.files_ref, url_path(name)));
        }
        let src = self.root.join(&rel);
        let base = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        let (stem, ext) = base.rsplit_once('.').map(|(s, e)| (s.to_string(), format!(".{e}"))).unwrap_or((base.clone(), String::new()));
        let mut name = base.clone();
        let mut n = 1;
        while self.copied.values().any(|v| *v == name) {
            name = format!("{stem}-{n}{ext}");
            n += 1;
        }
        std::fs::create_dir_all(&self.files_dir).ok()?;
        std::fs::copy(&src, self.files_dir.join(&name)).ok()?;
        self.copied.insert(rel, name.clone());
        Some(format!("{}/{}", self.files_ref, url_path(&name)))
    }

    /// Queue something to draw; returns its future link target.
    fn draw(&mut self, typst: String, packages: Vec<&'static str>, stem: &str) -> String {
        let name = format!("{stem}-{}.svg", self.media.len() + 1);
        self.media.push((MediaSrc { typst, packages, inline: false, tight: false }, name.clone()));
        format!("{}/{}", self.files_ref, url_path(&name))
    }

    fn image(&mut self, url: &str, alt: &str, width: Option<f64>) -> String {
        let file = url.split('#').next().unwrap_or("");
        if url.contains("://") {
            return format!("![{alt}]({url})");
        }
        let ext = file.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
        let Some(rel) = r::resolve_image(Some(self.root), self.note_dir(), file) else {
            self.warnings.push(format!("missing file: {file}"));
            return format!("![{alt}]({})", url_path(url));
        };
        let target = if ext == "pdf" {
            let frag = url.split_once('#').map(|(_, f)| f).unwrap_or("");
            let page = frag.split('&').find_map(|kv| kv.strip_prefix("page=")).and_then(|p| p.parse::<u32>().ok()).unwrap_or(1).max(1);
            let typst = format!("#align(center, block(stroke: 0.5pt + luma(200), image({}, page: {page})))", r::typst_str(&rel));
            let stem = file.rsplit('/').next().unwrap_or(file).trim_end_matches(".pdf").replace(' ', "-");
            self.draw(typst, vec![], &format!("{stem}-page{page}"))
        } else {
            match self.copy(&rel) {
                Some(t) => t,
                None => return format!("![{alt}]({})", url_path(url)),
            }
        };
        match width {
            Some(w) => format!("<img src=\"{target}\" alt=\"{}\" width=\"{w}\">", super::xml_escape(alt)),
            None => format!("![{alt}]({target})"),
        }
    }

    /// `[[target|alias]]` → a Markdown link relative to this note's folder.
    fn wikilink(&mut self, inner: &str) -> String {
        let (target, alias) = match inner.split_once('|') {
            Some((t, a)) => (t.trim(), Some(a.trim())),
            None => (inner.trim(), None),
        };
        let (name, sub) = match target.split_once('#') {
            Some((n, s)) => (n.trim(), Some(s.trim())),
            None => (target, None),
        };
        let text = alias.map(str::to_string).unwrap_or_else(|| if sub.is_some() { md::wiki_display(target) } else { name.rsplit('/').next().unwrap_or(name).to_string() });
        let anchor = sub.filter(|s| !s.starts_with('^')).map(|s| format!("#{}", github_slug(s))).unwrap_or_default();
        if name.is_empty() {
            return format!("[{text}]({anchor})");
        }
        match (self.resolve_note)(&self.note, name) {
            Some(path) => format!("[{text}]({}{anchor})", url_path(&relative(self.note_dir(), &path))),
            None => {
                self.warnings.push(format!("link to a missing note: {name}"));
                text
            }
        }
    }

    /// Rewrite one line of prose (outside code blocks and inline code).
    fn prose(&mut self, seg: &str, depth: u8, out_lines: &mut Vec<String>) -> String {
        let mut s = seg.to_string();
        // Embeds and wikilinks.
        let embed = regex::Regex::new(r"!\[\[([^\]]+)\]\]").unwrap();
        let mut res = String::new();
        let mut last = 0;
        for c in embed.captures_iter(&s.clone()) {
            let m = c.get(0).unwrap();
            res.push_str(&s[last..m.start()]);
            last = m.end();
            let inner = &c[1];
            let (target, size) = match inner.rsplit_once('|') {
                Some((t, w)) if w.trim().parse::<f64>().is_ok() => (t.trim(), w.trim().parse().ok()),
                _ => (inner.split('|').next().unwrap_or(inner).trim(), None),
            };
            let file = target.split('#').next().unwrap_or("");
            let ext = file.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
            if ext == "base" {
                let key = ("base".to_string(), format!("!embed {}", target));
                match self.rendered.get(&key) {
                    Some(t) => {
                        let link = self.draw(t.clone(), vec![], "view");
                        res.push_str(&format!("![{target}]({link})"));
                    }
                    None => res.push_str(target),
                }
            } else if ext.is_empty() || ext == "md" {
                // An embedded note: its text, inlined.
                match r::embedded_note(Some(self.root), self.note_dir(), "", target).filter(|_| depth < 4) {
                    Some(md) => {
                        let body = self.text(&md, depth + 1);
                        out_lines.push(String::new());
                        out_lines.extend(body);
                        out_lines.push(String::new());
                    }
                    None => res.push_str(&self.wikilink(target)),
                }
            } else {
                res.push_str(&self.image(target, "", size));
            }
        }
        res.push_str(&s[last..]);
        s = res;
        // ![alt|300](url)
        let img = regex::Regex::new(r"!\[([^\]]*)\]\(([^)\s]+)\)").unwrap();
        s = replace_all(&img, &s, |c| {
            let (alt, w) = match c[1].rsplit_once('|') {
                Some((a, w)) if w.trim().parse::<f64>().is_ok() => (a.trim().to_string(), w.trim().parse().ok()),
                _ => (c[1].to_string(), None),
            };
            let url = r::percent_decode(c[2].trim_start_matches('<').trim_end_matches('>'));
            self.image(&url, &alt, w)
        });
        let wl = regex::Regex::new(r"\[\[([^\]]+)\]\]").unwrap();
        s = replace_all(&wl, &s, |c| self.wikilink(&c[1]));
        // ==mark==
        let mark = regex::Regex::new(r"==([^\s=](?:[^=]*[^\s=])?)==").unwrap();
        s = mark.replace_all(&s, "<mark>$1</mark>").into_owned();
        // [text]{attrs}
        let span = regex::Regex::new(r"\[([^\[\]]*)\]\{([^}]*)\}").unwrap();
        s = replace_all(&span, &s, |c| html::span(&md::parse_attrs(&c[2]), c[1].to_string()));
        s
    }

    /// Rewrite a whole Markdown text into lines.
    fn text(&mut self, src: &str, depth: u8) -> Vec<String> {
        let mut out: Vec<String> = vec![];
        let lines: Vec<&str> = src.lines().collect();
        let mut i = 0;
        let mut in_comment = false;
        let heads: Vec<(usize, String)> = lines
            .iter()
            .filter_map(|l| {
                let t = l.trim_start();
                let n = t.chars().take_while(|c| *c == '#').count();
                (n > 0 && n <= 3 && t[n..].starts_with(' ')).then(|| (n, t[n..].trim().to_string()))
            })
            .collect();
        // The frontmatter stays (GitHub shows it as a table).
        if depth == 0 && lines.first() == Some(&"---") {
            if let Some(end) = lines.iter().skip(1).position(|l| l.trim_end() == "---" || l.trim_end() == "...") {
                out.extend(lines[..end + 2].iter().map(|l| l.to_string()));
                i = end + 2;
            }
        }
        while i < lines.len() {
            let line = lines[i];
            let t = line.trim_start();
            // Fenced code.
            let fc = t.chars().next().filter(|c| *c == '`' || *c == '~');
            if let Some(fc) = fc {
                let n = t.chars().take_while(|c| *c == fc).count();
                if n >= 3 && !in_comment {
                    let fence = &t[..n];
                    let lang = t[n..].split_whitespace().next().unwrap_or("").to_lowercase();
                    let mut j = i + 1;
                    while j < lines.len() {
                        let u = lines[j].trim();
                        if u.starts_with(fence) && u.chars().all(|c| c == fc) {
                            break;
                        }
                        j += 1;
                    }
                    let code = lines[i + 1..j.min(lines.len())].join("\n");
                    let block = lines[i..(j + 1).min(lines.len())].iter().map(|l| l.to_string()).collect::<Vec<_>>();
                    i = j + 1;
                    let key = (lang.clone(), code.trim().to_string());
                    let drawn = if NATIVE.contains(&lang.as_str()) || lang.is_empty() {
                        None
                    } else if let Some(t) = self.rendered.get(&key) {
                        Some((t.clone(), vec![]))
                    } else {
                        match blocks::render(&lang, &code, &mut self.ctx) {
                            Some(Ok((t, p))) => Some((t, p)),
                            Some(Err(e)) => {
                                self.warnings.push(format!("{lang} block: {e}"));
                                None
                            }
                            None => None,
                        }
                    };
                    match drawn {
                        Some((typst, pkgs)) => {
                            let link = self.draw(typst, pkgs, &lang);
                            out.push(format!("![{lang}]({link})"));
                            out.push(String::new());
                            out.push("<details><summary>Source</summary>".into());
                            out.push(String::new());
                            out.extend(block);
                            out.push(String::new());
                            out.push("</details>".into());
                        }
                        None => out.extend(block),
                    }
                    continue;
                }
            }
            i += 1;
            // %% comments %% (may span lines)
            let mut prose_line = String::new();
            let mut rest = line;
            loop {
                if in_comment {
                    match rest.find("%%") {
                        Some(k) => {
                            in_comment = false;
                            rest = &rest[k + 2..];
                        }
                        None => break,
                    }
                } else {
                    match rest.find("%%") {
                        Some(k) => {
                            prose_line.push_str(&rest[..k]);
                            in_comment = true;
                            rest = &rest[k + 2..];
                        }
                        None => {
                            prose_line.push_str(rest);
                            break;
                        }
                    }
                }
            }
            if prose_line.trim().is_empty() && line.contains("%%") {
                continue;
            }
            let l = prose_line;
            let tl = l.trim();
            // ::: blocks → HTML divs (blank lines keep the Markdown inside working).
            if let Some(attrs) = tl.strip_prefix(":::") {
                if attrs.trim().is_empty() {
                    out.push(String::new());
                    out.push("</div>".into());
                } else {
                    let (style, dir) = html::div_style(&md::parse_attrs(attrs));
                    let style = if style.is_empty() { String::new() } else { format!(" style=\"{style}\"") };
                    out.push(format!("<div{dir}{style}>"));
                    out.push(String::new());
                }
                continue;
            }
            if tl.eq_ignore_ascii_case("<!-- pagebreak -->") {
                continue;
            }
            if tl.eq_ignore_ascii_case("<!-- toc -->") {
                for (n, h) in &heads {
                    out.push(format!("{}- [{h}](#{})", "  ".repeat(n - 1), github_slug(h)));
                }
                continue;
            }
            // Callouts → GitHub alerts.
            if let Some(c) = callout(&l) {
                out.extend(c);
                continue;
            }
            // Block ids (`text ^id`) are NoteZ/Obsidian only.
            let l = match crate::blockidx::trailing_id(&l) {
                Some(id) => l.trim_end()[..l.trim_end().len() - id.len() - 1].trim_end().to_string(),
                None => l,
            };
            // Prose outside inline code.
            let mut extra = vec![];
            let mut res = String::new();
            for (k, seg) in l.split('`').enumerate() {
                if k > 0 {
                    res.push('`');
                }
                if k % 2 == 1 {
                    res.push_str(seg);
                } else {
                    res.push_str(&self.prose(seg, depth, &mut extra));
                }
            }
            if !extra.is_empty() {
                if !res.trim().is_empty() {
                    out.push(res);
                }
                out.extend(extra);
            } else {
                out.push(res);
            }
        }
        out
    }
}

fn replace_all(re: &regex::Regex, s: &str, mut f: impl FnMut(&regex::Captures) -> String) -> String {
    let mut out = String::new();
    let mut last = 0;
    for c in re.captures_iter(s) {
        let m = c.get(0).unwrap();
        out.push_str(&s[last..m.start()]);
        out.push_str(&f(&c));
        last = m.end();
    }
    out.push_str(&s[last..]);
    out
}

/// `> [!tip]- Title` → `> [!TIP]` + `> **Title**` (GitHub knows five kinds).
fn callout(line: &str) -> Option<Vec<String>> {
    let t = line.trim_start();
    let lead = &line[..line.len() - t.len()];
    let q = t.len() - t.trim_start_matches(|c: char| c == '>' || c == ' ').len();
    if q == 0 || !t.starts_with('>') {
        return None;
    }
    let prefix = &t[..q];
    let rest = t[q..].strip_prefix("[!")?;
    let close = rest.find(']')?;
    let kind = rest[..close].to_lowercase();
    if kind.is_empty() || !kind.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    let title = rest[close + 1..].trim_start_matches(['+', '-']).trim();
    let gh = match kind.as_str() {
        "tip" | "hint" | "success" | "check" | "done" => "TIP",
        "important" | "example" => "IMPORTANT",
        "warning" | "attention" | "question" | "faq" | "help" => "WARNING",
        "caution" | "danger" | "error" | "bug" | "failure" | "fail" | "missing" => "CAUTION",
        _ => "NOTE",
    };
    let (default, _) = md::callout_style(&kind);
    let mut v = vec![format!("{lead}{prefix}[!{gh}]")];
    let title = if title.is_empty() { default } else { title };
    // GitHub's own title is the kind; keep the note's when it says more.
    if !title.eq_ignore_ascii_case(gh) {
        v.push(format!("{lead}{}**{title}**", prefix.trim_end().to_string() + " "));
    }
    Some(v)
}

/// Export `text` (the note at vault path `note`) to `output`, with
/// attachments and drawings in `<stem>_files/` beside it.
pub fn write(
    world: &mut NoteWorld,
    root: &Path,
    note: &str,
    text: &str,
    rendered: &Rendered,
    resolve_note: &dyn Fn(&str, &str) -> Option<String>,
    output: &Path,
) -> Res<Vec<String>> {
    let stem = output.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "note".into());
    let dir = output.parent().unwrap_or(Path::new("."));
    let files_ref = format!("{stem}_files");
    let mut o = Out {
        root,
        note: note.trim_start_matches('/').to_string(),
        files_dir: dir.join(&files_ref),
        files_ref: url_path(&files_ref),
        copied: HashMap::new(),
        media: vec![],
        warnings: vec![],
        resolve_note,
        rendered,
        ctx: BlockCtx::default(),
    };
    let lines = o.text(text, 0);
    if !o.media.is_empty() {
        let theme = super::prepare(Some(root), note, text, rendered).theme;
        let items: Vec<MediaSrc> = o.media.iter().map(|(m, _)| m.clone()).collect();
        let drawn = draw_items(world, &theme, note, &items, true, false);
        std::fs::create_dir_all(&o.files_dir).map_err(|e| e.to_string())?;
        for ((_, name), d) in o.media.iter().zip(drawn) {
            match d.svg {
                Some(svg) => std::fs::write(o.files_dir.join(name), svg).map_err(|e| e.to_string())?,
                None => o.warnings.push(format!("{name}: {}", d.error.unwrap_or_default())),
            }
        }
    }
    let mut md = lines.join("\n");
    md.push('\n');
    std::fs::write(output, md).map_err(|e| e.to_string())?;
    o.warnings.dedup();
    Ok(o.warnings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_and_paths() {
        assert_eq!(github_slug("Hello, World!"), "hello-world");
        assert_eq!(github_slug("مقدمه اول"), "مقدمه-اول");
        assert_eq!(relative("a/b", "a/c/N.md"), "../c/N.md");
        assert_eq!(relative("", "x/N.md"), "x/N.md");
    }

    #[test]
    fn callouts_become_github_alerts() {
        assert_eq!(callout("> [!tip]- Be quick"), Some(vec!["> [!TIP]".into(), "> **Be quick**".into()]));
        assert_eq!(callout("> [!warning]"), Some(vec!["> [!WARNING]".into()]));
        assert_eq!(callout("> plain quote"), None);
    }
}
