//! Rendering pipeline: note text → Typst source (+ prelude) → SVG / PDF.

pub mod bidi;
pub mod blocks;
pub mod compile;
pub mod md;
pub mod script;
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

/// Built-in theme `name` (or default) as YAML, overlaid with
/// `<vault>/.notez/styles/<name>.yaml`.
fn theme_value(vault: Option<&Path>, name: &str) -> serde_yaml_ng::Value {
    let builtin = styles::BUILTIN_THEMES
        .iter()
        .find(|(n, _)| *n == name)
        .or_else(|| styles::BUILTIN_THEMES.iter().find(|(n, _)| *n == "default"))
        .map(|(_, y)| *y)
        .unwrap_or("");
    let mut v: serde_yaml_ng::Value = serde_yaml_ng::from_str(builtin).unwrap_or_default();
    if let Some(dir) = vault {
        let file = dir.join(".notez/styles").join(format!("{name}.yaml"));
        if let Some(over) = std::fs::read_to_string(file).ok().and_then(|y| serde_yaml_ng::from_str(&y).ok()) {
            // Only a file that is a valid theme on its own may overlay.
            if styles::theme_from_value(&over).is_some() {
                styles::merge_layer(&mut v, &over);
            }
        }
    }
    v
}

/// Built-in theme `name` (or default), overlaid with `<vault>/.notez/styles/<name>.yaml`.
/// An explicit `null` in the vault file clears the built-in value.
pub fn load_theme(vault: Option<&Path>, name: &str) -> Theme {
    let mut theme = styles::theme_from_value(&theme_value(vault, name))
        .or_else(|| styles::builtin(name))
        .or_else(|| styles::builtin("default"))
        .unwrap_or_default();
    theme.name.get_or_insert_with(|| name.to_string());
    theme
}

/// Effective theme of a note: its theme plus the frontmatter's `lang`,
/// `page` and `styles` (`fm_yaml` is the raw frontmatter, so an explicit
/// `null` there clears a theme value too).
pub fn theme_for(vault: Option<&Path>, fm: &FrontMatter, fm_yaml: Option<&str>) -> Theme {
    let name = fm.theme.as_deref().unwrap_or("default");
    let mut v = theme_value(vault, name);
    let over = fm_yaml.and_then(|y| serde_yaml_ng::from_str::<serde_yaml_ng::Value>(y).ok());
    if let Some(serde_yaml_ng::Value::Mapping(m)) = over {
        let mut layer = serde_yaml_ng::Mapping::new();
        for key in ["lang", "page", "styles"] {
            if let Some(x) = m.get(key) {
                layer.insert(key.into(), x.clone());
            }
        }
        let layer = serde_yaml_ng::Value::Mapping(layer);
        if styles::theme_from_value(&layer).is_some() {
            styles::merge_layer(&mut v, &layer);
        }
    }
    let mut theme = styles::theme_from_value(&v).unwrap_or_else(|| load_theme(vault, name));
    theme.name.get_or_insert_with(|| name.to_string());
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

/// Markdown that `![[url]]` embeds: a note (without its frontmatter), a
/// heading's section or a `^block`. `this` is the embedding note's text
/// (for `![[#^id]]`).
fn embedded_note(vault: Option<&Path>, note_dir: &str, this: &str, url: &str) -> Option<String> {
    let url = percent_decode(url.trim());
    let (name, sub) = match url.split_once('#') {
        Some((n, s)) => (n.trim(), Some(s.trim())),
        None => (url.as_str(), None),
    };
    let owned;
    let text = if name.is_empty() {
        this
    } else {
        let vault = vault?;
        let file = if name.to_ascii_lowercase().ends_with(".md") { name.to_string() } else { format!("{name}.md") };
        let rel = resolve_image(Some(vault), note_dir, &file)?;
        owned = std::fs::read_to_string(vault.join(rel.trim_start_matches('/'))).ok()?;
        &owned
    };
    let (s, e) = match sub.filter(|s| !s.is_empty()) {
        Some(sub) => crate::blockidx::find(text, sub)?,
        None => {
            let lines: Vec<&str> = text.lines().collect();
            (crate::blockidx::body_start(&lines), lines.len().saturating_sub(1))
        }
    };
    Some(crate::blockidx::slice(text, s, e))
}

pub struct Built {
    pub main_path: String,
    pub source: String,
    pub map: SourceMap,
    /// Non-fatal problems (bad frontmatter...).
    pub notes: Vec<String>,
}

pub(crate) const HELPERS: &str = "#let notez-fonts = (\"New Computer Modern\", \"Vazirmatn\")\n#let notez-digits(s, zero) = s.clusters().map(c => if c.len() == 1 and c >= \"0\" and c <= \"9\" { str.from-unicode(zero + int(c)) } else { c }).join()\n#let nz-image(path, width: auto) = layout(region => {\n  let im = image(path)\n  if width != auto { image(path, width: width) } else if measure(im).width > region.width { image(path, width: 100%) } else { im }\n})\n";

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
        let mut theme = load_theme(vault, &theme_name);
        theme.resolve_lang(text);
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
    for (script, c) in script::script_samples(body) {
        if !world::covers(c) {
            notes.push(format!(
                "No font has {script:?} letters (like “{c}”): install a font for them or name one under `fonts:` in the theme."
            ));
        }
    }
    let mut theme = theme_for(vault, &fm, split_frontmatter(text).0);
    theme.resolve_lang(&format!("{} {body}", fm.title.as_deref().unwrap_or("")));
    let meta = Meta { title: fm.title.as_deref(), author: fm.author.as_deref(), date: fm.date.as_deref() };
    let base = if theme.is_rtl() { md::Dir::Rtl } else { md::Dir::Ltr };
    let lang = theme.lang_code().unwrap_or_else(|| "en".into());
    let resolve = |url: &str| resolve_image(vault, note_dir, url);
    let resolve_note = |url: &str| embedded_note(vault, note_dir, text, url);
    let out = md::convert(body, &md::Options2 { base, lang: &lang, rendered, resolve_image: &resolve, resolve_note: &resolve_note, depth: 0 });

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

    /// Only pages that changed are sent again; an edit on page 3 of 3
    /// leaves pages 1 and 2 alone.
    #[test]
    fn preview_skips_unchanged_pages() {
        let para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(12);
        let text: String = (0..30).map(|i| format!("## Part {i}\n\n{para}\n\n")).collect();
        let render = |t: &str, known: &[String]| {
            let built = build(None, "Long.md", t, &md::Rendered::new());
            let mut world = world::NoteWorld::new(world::dev_packages_dir());
            world.prepare(&built.main_path, built.source.clone(), vec![]).unwrap();
            compile::preview_diff(&world, &built.map, known)
        };
        let first = render(&text, &[]);
        assert!(first.pages.len() >= 3, "{} pages", first.pages.len());
        assert!(first.pages.iter().all(Option::is_some));
        let same = render(&text, &first.hashes);
        assert!(same.pages.iter().all(Option::is_none), "nothing changed, nothing sent");
        let edited = render(&format!("{text}One more line at the end."), &first.hashes);
        let sent: Vec<usize> = edited.pages.iter().enumerate().filter(|(_, p)| p.is_some()).map(|(i, _)| i).collect();
        assert_eq!(sent, vec![edited.pages.len() - 1]);
    }

    /// ```nasm/```arm/```riscv/… blocks are highlighted in the PDF with the
    /// bundled grammars (asm.sublime-syntax and its MIPS variant). The cases
    /// in asm_cases.json are shared with the editor's test
    /// (scripts/test-asm.ts), so both color the same tokens.
    #[test]
    fn assembly_highlighting() {
        use typst::layout::{Frame, FrameItem};
        fn walk(f: &Frame, out: &mut Vec<(String, String)>) {
            for (_, item) in f.items() {
                match item {
                    FrameItem::Group(g) => walk(&g.frame, out),
                    FrameItem::Text(t) => {
                        if let typst::visualize::Paint::Solid(c) = &t.fill {
                            out.push((t.text.to_string(), c.to_hex().to_string()));
                        }
                    }
                    _ => {}
                }
            }
        }
        let cases: Vec<(String, String, Vec<(String, String)>)> =
            serde_json::from_str(include_str!("asm_cases.json")).unwrap();
        for (lang, code, expect) in cases {
            let note = format!("```{lang}\n{code}\n```\n");
            let built = build(None, "Asm.md", &note, &md::Rendered::new());
            let mut world = world::NoteWorld::new(world::dev_packages_dir());
            world.prepare(&built.main_path, built.source.clone(), vec![]).unwrap();
            let doc = typst::compile::<typst_layout::PagedDocument>(&world).output.expect("compiles");
            let mut runs = vec![];
            for page in doc.pages() {
                walk(&page.frame, &mut runs);
            }
            let mut pos = 0;
            for (word, kind) in expect {
                let want = match kind.as_str() {
                    "mnemonic" | "modifier" => "#d73948",
                    "register" => "#8b41b1",
                    "number" => "#b60157",
                    "comment" => "#74747c",
                    "label" => "#1d6c76",
                    "directive" => "#4b69c6",
                    "string" => "#198810",
                    "plain" => "#000000",
                    k => panic!("unknown kind {k}"),
                };
                // in order: each word is looked for after the previous one
                let at = runs[pos..]
                    .iter()
                    .position(|(t, _)| *t == word || t.trim() == word || t.split_whitespace().any(|w| w == word))
                    .unwrap_or_else(|| panic!("{lang}: {word:?} not found after run {pos} in {runs:?}"));
                pos += at + 1;
                let got = runs[pos - 1].1.as_str();
                assert_eq!(got, want, "{lang}: {word} should be a {kind}");
            }
        }
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
            assert!(pages >= 1, "theme {theme}: {pages} pages");
        }
    }

    /// Every note of examples/multilingual-vault: detected language and
    /// direction, the language's own page digits, no missing fonts, no errors
    /// (needs the bundled fonts: `npm run fonts`).
    #[test]
    fn multilingual_vault() {
        if !std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts/noto/NotoSansSC-Regular.otf").exists() {
            eprintln!("skipped: bundled fonts missing (npm run fonts)");
            return;
        }
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../examples/multilingual-vault");
        let expect = [
            ("English", "en", false, "1"), ("Persian", "fa", true, "۱"), ("Arabic", "ar", true, "١"),
            ("Urdu", "ur", true, "۱"), ("Chinese", "zh", false, "1"),
            ("Japanese", "ja", false, "1"), ("Korean", "ko", false, "1"), ("Hindi", "hi", false, "1"),
            ("Bengali", "bn", false, "১"), ("Thai", "th", false, "1"), ("Russian", "ru", false, "1"),
            ("Greek", "el", false, "1"), ("Amharic", "am", false, "1"), ("Mixed", "en", false, "1"),
        ];
        for (name, lang, rtl, digit) in expect {
            let text = std::fs::read_to_string(dir.join(format!("{name}.md"))).unwrap();
            let built = build(None, &format!("{name}.md"), &text, &md::Rendered::new());
            let (base, _) = script::split_lang(lang);
            assert!(built.source.contains(&format!("lang: \"{base}\"")), "{name}: lang {lang}");
            assert!(built.source.contains(if rtl { "dir: rtl)" } else { "dir: ltr)" }), "{name}: direction");
            assert!(built.source.contains(&format!("numbering: \"{digit}\"")), "{name}: page digits {digit}");
            assert!(built.notes.iter().all(|n| !n.starts_with("No font")), "{name}: {:?}", built.notes);
            let (errs, pages) = compile_errors(&format!("{name}.md"), &text);
            assert!(errs.is_empty(), "{name}: {errs:#?}");
            assert_eq!(pages, 1, "{name}");
            // No glyph fell back to .notdef (a box): every script found a font.
            let missing = tofu_of(&built);
            assert!(missing.is_empty(), "{name}: no font for {missing:?}");
        }
        // The check itself works: Linear B has no bundled font.
        let built = build(None, "LinearB.md", "\u{10000}\u{10001}", &md::Rendered::new());
        assert!(!tofu_of(&built).is_empty(), "the .notdef check must catch a script without a font");
        fn tofu_of(built: &Built) -> Vec<String> {
            let mut world = world::NoteWorld::new(world::dev_packages_dir());
            world.prepare(&built.main_path, built.source.clone(), vec![]).unwrap();
            let doc = typst::compile::<typst_layout::PagedDocument>(&world).output.expect("compiles");
            fn tofu(f: &typst::layout::Frame, out: &mut Vec<String>) {
                for (_, item) in f.items() {
                    match item {
                        typst::layout::FrameItem::Group(g) => tofu(&g.frame, out),
                        typst::layout::FrameItem::Text(t) => {
                            for g in t.glyphs.iter().filter(|g| g.id == 0) {
                                out.push(t.text[g.range()].to_string());
                            }
                        }
                        _ => {}
                    }
                }
            }
            let mut missing = vec![];
            doc.pages().iter().for_each(|p| tofu(&p.frame, &mut missing));
            missing
        }
        // Mixed: spans and blocks with their own languages.
        let text = std::fs::read_to_string(dir.join("Mixed.md")).unwrap();
        let built = build(None, "Mixed.md", &text, &md::Rendered::new());
        assert!(built.source.contains("lang: \"ja\", dir: ltr, font: (\"Noto Sans JP\",) + notez-fonts"), "{}", built.source);
        assert!(built.source.contains("lang: \"ar\", dir: rtl"), "{}", built.source);
        assert!(built.source.contains("dir: rtl, lang: \"fa\""), "{}", built.source);
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
    fn blocks_compile_with_links_and_embeds() {
        let dir = std::env::temp_dir().join(format!("nz-embed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Other.md"), "---\ntitle: o\n---\n# Part\n\nSecret *one* ^s1\n\n# Rest\n\nNot this\n").unwrap();
        let text = "# A ^h\n\nPara ^p1\n\n| a |\n|---|\n| 1 |\n\n^t1\n\nSee [[#^p1|para]] and [[#^t1]].\n\n![[Other#^s1]]\n\n![[Other#Part]]\n\n![[Other]]\n\n![[#^p1]]\n";
        let built = build(Some(&dir), "n.md", text, &md::Rendered::new());
        assert_eq!(built.source.matches("Secret").count(), 3, "{}", built.source);
        assert_eq!(built.source.matches("Not this").count(), 1, "{}", built.source);
        assert!(!built.source.contains("title: o"));
        let mut world = world::NoteWorld::new(world::dev_packages_dir());
        world.set_vault(Some(dir.clone()));
        world.prepare(&built.main_path, built.source.clone(), vec![]).unwrap();
        let p = compile::preview(&world, &built.map);
        let errs: Vec<_> = p.diagnostics.iter().filter(|d| d.severity == "error").map(|d| d.message.clone()).collect();
        assert!(errs.is_empty(), "{errs:?}\n{}", built.source);
        let _ = std::fs::remove_dir_all(&dir);
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
