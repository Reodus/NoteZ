//! Rendering pipeline: note text → Typst source (+ prelude) → SVG / PDF.

pub mod bidi;
pub mod blocks;
pub mod compile;
pub mod md;
pub mod styles;
pub mod world;

use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use compile::SourceMap;
use styles::{Meta, PageStyle, TextStyle, Theme};

/// Pinned versions of the bundled Typst packages.
pub const PACKAGES: &[(&str, &str)] = &[
    ("cetz", "#import \"@preview/cetz:0.5.3\"\n"),
    ("fletcher", "#import \"@preview/fletcher:0.5.8\" as fletcher: diagram, node, edge\n"),
    ("lilaq", "#import \"@preview/lilaq:0.6.0\" as lq\n"),
    ("mitex", "#import \"@preview/mitex:0.2.7\": mitex, mi\n"),
];

/// A Typst string literal.
pub fn typst_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '\\' => o.push_str("\\\\"),
            '"' => o.push_str("\\\""),
            '\n' => o.push_str("\\n"),
            '\r' => {}
            '\t' => o.push_str("\\t"),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// Escape text so Typst markup shows it literally.
pub fn escape_markup(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    let mut prev_digit = false;
    for (i, c) in s.chars().enumerate() {
        match c {
            // `(` and a leading `.` are escaped too: right after an embedded
            // call (`#linebreak()`, `#link(..)[..]`) they would otherwise
            // continue it as arguments / a method call.
            '\\' | '*' | '_' | '`' | '$' | '#' | '@' | '<' | '>' | '[' | ']' | '~' | '=' | '-' | '+' | '/' | '(' => {
                o.push('\\');
                o.push(c);
            }
            '.' if prev_digit || i == 0 => o.push_str("\\."),
            c => o.push(c),
        }
        prev_digit = c.is_ascii_digit();
    }
    o
}

pub fn is_length(s: &str) -> bool {
    let s = s.trim();
    let end = s.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(s.len());
    end > 0 && s[..end].parse::<f64>().is_ok() && matches!(&s[end..], "pt" | "mm" | "cm" | "in" | "em")
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "kebab-case")]
pub struct FrontMatter {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub author: Option<String>,
    pub date: Option<String>,
    pub theme: Option<String>,
    pub lang: Option<String>,
    pub toc: Option<bool>,
    pub page: Option<PageStyle>,
    pub styles: BTreeMap<String, TextStyle>,
}

/// Split `---\nyaml\n---\n` off the top. Returns (yaml, body, body start line).
pub fn split_frontmatter(text: &str) -> (Option<&str>, &str, usize) {
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else {
        return (None, text, 0);
    };
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" || line.trim_end() == "..." {
            let yaml = &rest[..offset];
            let body = &rest[offset + line.len()..];
            let lines = 1 + yaml.matches('\n').count() + 1;
            return (Some(yaml), body, lines);
        }
        offset += line.len();
    }
    (None, text, 0)
}

pub fn parse_frontmatter(text: &str) -> (FrontMatter, &str, usize, Option<String>) {
    let (yaml, body, line) = split_frontmatter(text);
    match yaml {
        None => (FrontMatter::default(), body, line, None),
        Some(y) => match serde_yaml_ng::from_str::<FrontMatter>(y) {
            Ok(fm) => (fm, body, line, None),
            Err(e) => (FrontMatter::default(), body, line, Some(format!("frontmatter: {e}"))),
        },
    }
}

/// Built-in theme `name` (or default), overlaid with `<vault>/.notez/styles/<name>.yaml`.
pub fn load_theme(vault: Option<&Path>, name: &str) -> Theme {
    let mut theme = styles::builtin(name).or_else(|| styles::builtin("default")).unwrap_or_default();
    if let Some(v) = vault {
        let file = v.join(".notez/styles").join(format!("{name}.yaml"));
        if let Ok(y) = std::fs::read_to_string(file) {
            if let Ok(t) = styles::parse_theme(&y) {
                theme.merge(&t);
            }
        }
    }
    theme.name.get_or_insert_with(|| name.to_string());
    theme
}

pub fn theme_for(vault: Option<&Path>, fm: &FrontMatter) -> Theme {
    let mut theme = load_theme(vault, fm.theme.as_deref().unwrap_or("default"));
    let over = Theme {
        lang: fm.lang.clone(),
        page: fm.page.clone().unwrap_or_default(),
        styles: fm.styles.clone(),
        ..Default::default()
    };
    theme.merge(&over);
    theme
}

pub(crate) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// Lexically normalise "a/b/../c" → "a/c"; None if it escapes the root.
fn normalize(path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

fn find_by_name(dir: &Path, name: &str, depth: usize) -> Option<std::path::PathBuf> {
    if depth > 8 {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for e in entries.flatten() {
        let fname = e.file_name();
        let fname = fname.to_string_lossy();
        if fname.starts_with('.') {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            subdirs.push(p);
        } else if fname == name {
            return Some(p);
        }
    }
    subdirs.into_iter().find_map(|d| find_by_name(&d, name, depth + 1))
}

/// Resolve an image reference from a note to an absolute (vault-rooted) Typst path.
pub fn resolve_image(vault: Option<&Path>, note_dir: &str, url: &str) -> Option<String> {
    let vault = vault?;
    let url = percent_decode(url.trim());
    let rel = if let Some(abs) = url.strip_prefix('/') {
        normalize(abs)?
    } else {
        normalize(&format!("{note_dir}/{url}"))?
    };
    if vault.join(&rel).is_file() {
        return Some(format!("/{rel}"));
    }
    // Obsidian-style: search the vault by file name.
    let name = url.rsplit('/').next()?;
    let found = find_by_name(vault, name, 0)?;
    let rel = found.strip_prefix(vault).ok()?.to_string_lossy().replace('\\', "/");
    Some(format!("/{rel}"))
}

pub struct Built {
    pub main_path: String,
    pub source: String,
    pub map: SourceMap,
    /// Non-fatal problems (bad frontmatter...).
    pub notes: Vec<String>,
}

const HELPERS: &str = "#let nz-image(path, width: auto) = layout(region => {\n  let im = image(path)\n  if width != auto { image(path, width: width) } else if measure(im).width > region.width { image(path, width: 100%) } else { im }\n})\n";

fn imports(pkgs: &BTreeSet<&str>) -> String {
    PACKAGES.iter().filter(|(n, _)| pkgs.contains(n)).map(|(_, i)| *i).collect()
}

/// Packages a hand-written Typst note appears to use.
fn sniff_packages(text: &str) -> BTreeSet<&'static str> {
    let mut s = BTreeSet::new();
    if text.contains("cetz.") {
        s.insert("cetz");
    }
    if text.contains("fletcher.") || text.contains("diagram(") {
        s.insert("fletcher");
    }
    if text.contains("lq.") {
        s.insert("lilaq");
    }
    if text.contains("mitex(") || text.contains("#mi(") {
        s.insert("mitex");
    }
    s
}

pub fn build(vault: Option<&Path>, note_path: &str, text: &str, rendered: &md::Rendered) -> Built {
    let note_path = note_path.trim_start_matches('/');
    let note_dir = note_path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let mut notes = Vec::new();

    if note_path.ends_with(".typ") {
        // `// theme: academic` on the first line picks a theme.
        let theme_name = text
            .lines()
            .next()
            .and_then(|l| l.trim().strip_prefix("// theme:"))
            .map(|t| t.trim().to_string())
            .unwrap_or_else(|| "default".into());
        let theme = load_theme(vault, &theme_name);
        let meta = Meta { title: None, author: None, date: None };
        let prelude = format!("{}{}{}", imports(&sniff_packages(text)), HELPERS, styles::prelude(&theme, &meta));
        let prelude_lines = prelude.matches('\n').count();
        return Built {
            main_path: format!("/{note_path}"),
            source: format!("{prelude}{text}"),
            map: SourceMap { prelude_lines, checkpoints: vec![] },
            notes,
        };
    }

    let (fm, body, body_line, fm_err) = parse_frontmatter(text);
    notes.extend(fm_err);
    let theme = theme_for(vault, &fm);
    let meta = Meta { title: fm.title.as_deref(), author: fm.author.as_deref(), date: fm.date.as_deref() };
    let base = if theme.is_rtl() { md::Dir::Rtl } else { md::Dir::Ltr };
    let resolve = |url: &str| resolve_image(vault, note_dir, url);
    let out = md::convert(body, &md::Options2 { base, rendered, resolve_image: &resolve });

    let mut head = format!("{}{}{}", imports(&out.packages), HELPERS, styles::prelude(&theme, &meta));
    head.push_str(&styles::title_block(&theme, &meta, fm.subtitle.as_deref()));
    if fm.toc == Some(true) {
        head.push_str("#outline(depth: 3)\n#pagebreak(weak: true)\n");
    }
    let head_lines = head.matches('\n').count();
    let checkpoints = out.checkpoints.iter().map(|&(g, s)| (g + head_lines, s + body_line)).collect();
    Built {
        main_path: if note_dir.is_empty() { "/__notez__.typ".into() } else { format!("/{note_dir}/__notez__.typ") },
        source: format!("{head}{}", out.typst),
        map: SourceMap { prelude_lines: head_lines, checkpoints },
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_split() {
        let (y, body, line) = split_frontmatter("---\ntitle: X\n---\n# Hi\n");
        assert_eq!(y, Some("title: X\n"));
        assert_eq!(body, "# Hi\n");
        assert_eq!(line, 3);
        assert_eq!(split_frontmatter("# no fm").0, None);
    }

    #[test]
    fn string_escape() {
        assert_eq!(typst_str("a\"b\\c\nd"), "\"a\\\"b\\\\c\\nd\"");
    }

    /// Downloads the pinned packages (and their dependencies) into
    /// `typst-packages/`. Run once: `cargo test vendor_packages -- --ignored`
    #[test]
    #[ignore]
    fn vendor_packages() {
        use typst_kit::packages::FsPackages;
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("typst-packages");
        std::fs::create_dir_all(&dir).unwrap();
        let mut world = world::NoteWorld::with_package_cache(dir.clone(), Some(FsPackages::new(&dir)));
        let all: BTreeSet<&str> = PACKAGES.iter().map(|(n, _)| *n).collect();
        let src = format!(
            "{}#cetz.canvas({{ import cetz.draw: *; circle((0,0)) }})\n#diagram(node((0,0), [a]), edge(\"->\"), node((1,0), [b]))\n#lq.diagram(lq.plot((1,2,3), (1,4,9)))\n#mi(\"x^2\") #mitex(\"\\\\frac{{a}}{{b}}\")\n",
            imports(&all)
        );
        world.prepare("/main.typ", src, vec![]).unwrap();
        let p = compile::preview(&world, &SourceMap::default());
        let errs: Vec<_> = p.diagnostics.iter().filter(|d| d.severity == "error").map(|d| &d.message).collect();
        assert!(errs.is_empty(), "{errs:?}");
        assert_eq!(p.pages.len(), 1);
    }

    fn compile_errors(note_path: &str, text: &str) -> (Vec<String>, usize) {
        let built = build(None, note_path, text, &md::Rendered::new());
        let mut world = world::NoteWorld::new(world::dev_packages_dir());
        world.prepare(&built.main_path, built.source.clone(), vec![]).unwrap();
        let p = compile::preview(&world, &built.map);
        let errs: Vec<String> = p
            .diagnostics
            .iter()
            .filter(|d| d.severity == "error")
            .map(|d| format!("line {:?}: {} {:?}", d.line, d.message, d.hints))
            .collect();
        if !errs.is_empty() {
            for (i, l) in built.source.lines().enumerate() {
                eprintln!("{:4} {l}", i + 1);
            }
        }
        (errs, p.pages.len())
    }

    #[test]
    fn showcase_compiles_with_every_theme() {
        let showcase = include_str!("../../../examples/sample-vault/Showcase.md");
        for (theme, _) in styles::BUILTIN_THEMES {
            let text = showcase.replace("theme: default", &format!("theme: {theme}"));
            let (errs, pages) = compile_errors("Showcase.md", &text);
            assert!(errs.is_empty(), "theme {theme}: {errs:#?}");
            assert!(pages >= 2, "theme {theme}: {pages} pages");
        }
    }

    /// Compile every note of a real vault (read-only):
    /// `NOTEZ_VAULT=/path/vault cargo test vault_compiles -- --ignored --nocapture`
    /// Optional `NOTEZ_OUT=dir` writes the PDFs there.
    #[test]
    #[ignore]
    fn vault_compiles() {
        let vault = std::path::PathBuf::from(std::env::var("NOTEZ_VAULT").expect("NOTEZ_VAULT"));
        let out = std::env::var("NOTEZ_OUT").ok().map(std::path::PathBuf::from);
        let notes = crate::vault::all_notes(&vault);
        let mut failed = Vec::new();
        let mut world = world::NoteWorld::new(world::dev_packages_dir());
        world.set_vault(Some(vault.clone()));
        for rel in &notes {
            let text = std::fs::read_to_string(vault.join(rel)).unwrap();
            let built = build(Some(&vault), rel, &text, &md::Rendered::new());
            world.prepare(&built.main_path, built.source.clone(), vec![]).unwrap();
            let p = compile::preview(&world, &built.map);
            let errs: Vec<String> = p
                .diagnostics
                .iter()
                .filter(|d| d.severity == "error")
                .map(|d| format!("line {:?}: {}", d.line, d.message))
                .collect();
            if errs.is_empty() {
                if let Some(dir) = &out {
                    if let Ok(pdf) = compile::pdf(&world, &built.map) {
                        let name = rel.replace('/', "__").replace(".md", ".pdf").replace(".typ", ".pdf");
                        std::fs::create_dir_all(dir).unwrap();
                        std::fs::write(dir.join(name), pdf).unwrap();
                    }
                }
            } else {
                eprintln!("FAIL {rel}: {}", errs.join(" | "));
                failed.push(rel.clone());
            }
        }
        eprintln!("{} notes, {} failed", notes.len(), failed.len());
        assert!(failed.is_empty(), "{failed:#?}");
    }

    /// `NOTEZ_MD=/path/file.md cargo test md_file_compiles -- --ignored`
    #[test]
    #[ignore]
    fn md_file_compiles() {
        let path = std::env::var("NOTEZ_MD").expect("NOTEZ_MD");
        let text = std::fs::read_to_string(&path).unwrap();
        let (errs, pages) = compile_errors("Check.md", &text);
        assert!(errs.is_empty(), "{errs:#?}");
        eprintln!("ok: {pages} pages");
        if let Ok(out) = std::env::var("NOTEZ_OUT") {
            let built = build(None, "Check.md", &text, &md::Rendered::new());
            let mut world = world::NoteWorld::new(world::dev_packages_dir());
            world.prepare(&built.main_path, built.source, vec![]).unwrap();
            let pdf = compile::pdf(&world, &built.map).unwrap_or_else(|e| panic!("{}", e[0].message));
            std::fs::write(out, pdf).unwrap();
        }
    }

    #[test]
    fn typst_note_compiles_and_maps_errors() {
        let (errs, pages) = compile_errors("a/b.typ", "= Title\n\nسلام #strong[world]\n");
        assert!(errs.is_empty(), "{errs:?}");
        assert_eq!(pages, 1);
        let built = build(None, "b.typ", "ok\n#undefined-thing\n", &md::Rendered::new());
        let mut world = world::NoteWorld::new(world::dev_packages_dir());
        world.prepare(&built.main_path, built.source, vec![]).unwrap();
        let p = compile::preview(&world, &built.map);
        let e = p.diagnostics.iter().find(|d| d.severity == "error").expect("an error");
        assert_eq!(e.line, Some(2), "{}", e.message);
    }

    #[test]
    fn markdown_errors_map_to_note_lines() {
        let text = "---\ntitle: x\n---\n\nfine\n\n```typst\n#undefined-thing\n```\n";
        let built = build(None, "n.md", text, &md::Rendered::new());
        let mut world = world::NoteWorld::new(world::dev_packages_dir());
        world.prepare(&built.main_path, built.source, vec![]).unwrap();
        let p = compile::preview(&world, &built.map);
        let e = p.diagnostics.iter().find(|d| d.severity == "error").expect("an error");
        assert_eq!(e.line, Some(7), "{}", e.message);
    }

    #[test]
    fn normalize_paths() {
        assert_eq!(normalize("a/./b/../c.png").as_deref(), Some("a/c.png"));
        assert_eq!(normalize("../x"), None);
    }
}

#[cfg(test)]
mod export_tests {
    use super::*;

    /// Writes showcase PDFs for visual inspection:
    /// `NOTEZ_OUT=/tmp/x cargo test export_showcase -- --ignored`
    #[test]
    #[ignore]
    fn export_showcase() {
        let out = std::path::PathBuf::from(std::env::var("NOTEZ_OUT").expect("NOTEZ_OUT"));
        std::fs::create_dir_all(&out).unwrap();
        let showcase = include_str!("../../../examples/sample-vault/Showcase.md");
        for (theme, _) in styles::BUILTIN_THEMES {
            let text = showcase.replace("theme: default", &format!("theme: {theme}"));
            let built = build(None, "Showcase.md", &text, &md::Rendered::new());
            let mut world = world::NoteWorld::new(world::dev_packages_dir());
            world.prepare(&built.main_path, built.source.clone(), vec![]).unwrap();
            let pdf = compile::pdf(&world, &built.map).unwrap_or_else(|e| panic!("{}", e[0].message));
            std::fs::write(out.join(format!("{theme}.pdf")), pdf).unwrap();
            std::fs::write(out.join(format!("{theme}.typ")), built.source).unwrap();
        }
    }
}
