use crate::{bases, export, links, render, vault, AppState, Res};
use render::compile::{self, Diagnostic};
use render::md::Rendered;
use render::styles::{self, Theme};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Deserialize)]
pub(super) struct RenderedBlock {
    lang: String,
    code: String,
    typst: String,
}

fn rendered_blocks(state: &AppState, path: &str, text: &str, blocks: Vec<RenderedBlock>) -> Rendered {
    let mut map = blocks.into_iter().map(|b| ((b.lang, b.code.trim().to_string()), b.typst)).collect();
    data_blocks(state, path, text, &mut map);
    map
}

/// The ```base / ```query fences of `text`: (lang, trimmed code).
fn data_fences(text: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    let mut open: Option<(String, String, Vec<&str>)> = None; // (fence, lang, lines)
    for line in text.lines() {
        let t = line.trim();
        if let Some((fence, lang, body)) = &mut open {
            if t.starts_with(fence.as_str()) && t.chars().all(|c| c == fence.chars().next().unwrap()) {
                out.push((lang.clone(), body.join("\n").trim().to_string()));
                open = None;
            } else {
                body.push(line);
            }
            continue;
        }
        let ch = t.chars().next();
        if ch != Some('`') && ch != Some('~') {
            continue;
        }
        let n = t.chars().take_while(|&c| Some(c) == ch).count();
        if n < 3 {
            continue;
        }
        let lang = t[n..].trim();
        // Any other fence is skipped whole (so a ```base inside ````md isn't run).
        open = Some((t[..n].to_string(), lang.to_string(), vec![]));
    }
    out.retain(|(l, _)| l == "base" || l == "query");
    out
}

/// ```base / ```query blocks and ![[x.base]] embeds of `text`, run against
/// the vault and added to `map` as Typst (the renderer looks them up there).
fn data_blocks(state: &AppState, path: &str, text: &str, map: &mut Rendered) {
    let mut want = data_fences(text);
    let embed = regex::Regex::new(r"!\[\[([^\]|]+?\.base(?:#[^\]|]*)?)(?:\|[^\]]*)?\]\]").unwrap();
    for c in embed.captures_iter(text) {
        want.push(("base".into(), format!("!embed {}", c[1].trim())));
    }
    if want.is_empty() || state.root_opt().is_none() {
        return;
    }
    let _ = state.with_index(|idx, root| {
        for (lang, code) in want {
            let key = (lang.clone(), code.clone());
            if map.contains_key(&key) {
                continue;
            }
            let r = if lang == "query" {
                bases::query_block(idx, root, &code, Some(path), &[])
            } else if let Some(target) = code.strip_prefix("!embed ") {
                let (file, view) = match target.split_once('#') {
                    Some((f, v)) => (f.trim(), Some(v.trim())),
                    None => (target, None),
                };
                let resolved = links::Resolver::new(idx, root).resolve(path, file).map(|(p, _)| p);
                match resolved.and_then(|p| vault::read(root, &p).ok().map(|t| (p, t))) {
                    // `this` is the embedding note, as in Obsidian.
                    Some((_, src)) => bases::query(idx, root, &src, view.filter(|v| !v.is_empty()), Some(path), &[]),
                    None => Err(format!("{file} was not found")),
                }
            } else {
                bases::query(idx, root, &code, None, Some(path), &[])
            };
            let typst = match r {
                Ok(r) => bases::to_typst(&r),
                Err(e) => format!("#block(fill: rgb(\"#fdecec\"), inset: 8pt, radius: 4pt, width: 100%)[#text(fill: rgb(\"#a33\"))[{}: {}]]", lang, render::escape_markup(&e)),
            };
            map.insert(key, typst);
        }
    });
}

fn build_document(state: &AppState, path: &str, text: &str, blocks: Vec<RenderedBlock>) -> render::Built {
    let root = state.root_opt();
    let map = rendered_blocks(state, path, text, blocks);
    render::build(root.as_deref(), path, text, &map)
}

#[derive(Serialize)]
pub(super) struct PreviewResult {
    #[serde(flatten)]
    preview: compile::PreviewDiff,
    notes: Vec<String>,
}

pub(super) fn render_preview(
    state: &AppState,
    path: String,
    text: String,
    blocks: Vec<RenderedBlock>,
    known: Vec<String>,
) -> Res<PreviewResult> {
    let built = build_document(state, &path, &text, blocks);
    // Hold the same guard from preparation through compilation so another
    // preview or export cannot replace the source of this request.
    let mut world = state.world.lock().unwrap();
    world.prepare(&built.main_path, built.source, vec![])?;
    Ok(PreviewResult { preview: compile::preview_diff(&world, &built.map, &known), notes: built.notes })
}

pub(super) fn export_pdf(
    state: &AppState,
    path: String,
    text: String,
    blocks: Vec<RenderedBlock>,
    output: String,
) -> Result<(), Vec<Diagnostic>> {
    let err = |m: String| vec![Diagnostic { severity: "error", message: m, hints: vec![], line: None, column: None, file: None }];
    let built = build_document(state, &path, &text, blocks);
    let bytes = {
        let mut world = state.world.lock().unwrap();
        world.prepare(&built.main_path, built.source, vec![]).map_err(err)?;
        compile::pdf(&world, &built.map)?
    };
    std::fs::write(&output, bytes).map_err(|e| err(e.to_string()))
}

/// A Markdown note read for Word/HTML export, with its ```base/```query
/// views run like the PDF's.
fn export_prepare(state: &AppState, path: &str, text: &str, blocks: Vec<RenderedBlock>) -> export::Prepared {
    let root = state.root_opt();
    let map = rendered_blocks(state, path, text, blocks);
    export::prepare(root.as_deref(), path, text, &map)
}

/// Export a note as one self-contained HTML file. Returns warnings.
pub(super) fn export_html(state: &AppState, path: String, text: String, blocks: Vec<RenderedBlock>, output: String) -> Res<Vec<String>> {
    let p = export_prepare(state, &path, &text, blocks);
    let drawn = export::draw(&mut state.snippets.lock().unwrap(), &p, true, false);
    let (html, mut warnings) = export::html::write(&p, &drawn);
    warnings.extend(p.warnings.iter().cloned());
    std::fs::write(&output, html).map_err(|e| e.to_string())?;
    Ok(warnings)
}

/// Export a note as a Word document (.docx). Returns warnings.
pub(super) fn export_docx(state: &AppState, path: String, text: String, blocks: Vec<RenderedBlock>, output: String) -> Res<Vec<String>> {
    let mut p = export_prepare(state, &path, &text, blocks);
    export::docx::convert_images(&mut p);
    let drawn = export::draw(&mut state.snippets.lock().unwrap(), &p, false, true);
    let (bytes, mut warnings) = export::docx::write(&p, &drawn)?;
    warnings.extend(p.warnings.iter().cloned());
    std::fs::write(&output, bytes).map_err(|e| e.to_string())?;
    Ok(warnings)
}

/// Export a note as portable Markdown: `output` plus `<name>_files/` with
/// its attachments and drawings. Returns warnings.
pub(super) fn export_markdown(state: &AppState, path: String, text: String, blocks: Vec<RenderedBlock>, output: String) -> Res<Vec<String>> {
    let root = state.root()?;
    let map = rendered_blocks(state, &path, &text, blocks);
    let resolve_note = |from: &str, target: &str| -> Option<String> {
        state.with_index(|idx, r| links::Resolver::new(idx, r).resolve(from, target).map(|(p, _)| p)).ok().flatten()
    };
    export::markdown::write(&mut state.snippets.lock().unwrap(), &root, &path, &text, &map, &resolve_note, Path::new(&output))
}

/// Typst source a note compiles to (for "View generated Typst").
pub(super) fn generated_typst(state: &AppState, path: String, text: String, blocks: Vec<RenderedBlock>) -> String {
    build_document(state, &path, &text, blocks).source
}

/// Render one special block (chart, flow, ...) to SVG for inline previews.
pub(super) fn render_block(state: &AppState, lang: String, code: String) -> Res<String> {
    let mut ctx = render::blocks::BlockCtx::default();
    let (typst, pkgs) = match render::blocks::render(&lang, &code, &mut ctx) {
        Some(r) => r?,
        None => return Err(format!("no renderer for `{lang}`")),
    };
    let imports: String = render::PACKAGES.iter().filter(|(n, _)| pkgs.contains(n)).map(|(_, i)| *i).collect();
    let src = format!(
        "{imports}{}#let notez-fonts = {fonts}\n#set page(width: auto, height: auto, margin: 6pt, fill: none)\n#set text(font: notez-fonts, size: 11pt)\n{typst}\n",
        render::HELPERS,
        fonts = render::styles::default_font_array(),
    );
    let mut w = state.snippets.lock().unwrap();
    w.prepare("/__snippet__.typ", src, vec![])?;
    compile::snippet_svg(&w)
}

/// A sample note in a theme's language, for the Themes dialog thumbnails.
fn theme_sample(theme: &render::styles::Theme) -> &'static str {
    let lang = theme.sample.clone().or_else(|| theme.lang.clone()).unwrap_or_default();
    let lang = render::script::normalize_lang(&lang).map(|l| render::script::split_lang(&l).0).unwrap_or_default();
    if matches!(lang.as_str(), "ar" | "fa" | "ur" | "ps" | "ckb") {
        "# مقدمة\n\nهذا نص تجريبي يوضح شكل الفقرات والعناوين في هذا النمط. تتغير الخطوط والألوان والمسافات مع كل نمط، لكن النص يبقى كما هو.\n\n## التفاصيل\n\nيمكن تعديل كل نمط من لوحة الأنماط أو من ملف YAML.\n\n> اقتباس قصير للتوضيح.\n"
    } else if matches!(lang.as_str(), "zh" | "ja" | "ko") {
        "# 引言\n\n这是一段示例文字，用来展示此主题中段落和标题的样子。每个主题的字体、颜色和间距都不同，而文字内容保持不变。\n\n## 细节\n\n每个样式都可以在样式面板或 YAML 文件中修改。\n\n> 一段简短的引文。\n"
    } else if matches!(lang.as_str(), "hi" | "mr" | "ne" | "sa") {
        "# परिचय\n\nयह एक नमूना पाठ है जो इस थीम में अनुच्छेदों और शीर्षकों का रूप दिखाता है। हर थीम में फ़ॉन्ट, रंग और अंतर बदलते हैं, पर पाठ वही रहता है।\n\n## विवरण\n\nहर शैली को शैली पैनल या YAML फ़ाइल से बदला जा सकता है।\n\n> एक छोटा उद्धरण।\n"
    } else {
        "# Introduction\n\nThis sample text shows how paragraphs and headings look in this theme. Fonts, colors and spacing change from theme to theme; the words stay the same. It works in any language: العربية, 中文, हिन्दी, Ελληνικά.\n\n## Details\n\nEvery style can be changed in the Styles panel or in a YAML file, for one note or for the whole theme.\n\n> A short quotation, to show the quote style.\n\n```\nfn main() {}\n```\n"
    }
}

/// First page of a sample note in a theme, as SVG.
pub(super) fn theme_thumbnail(state: &AppState, id: String) -> Res<String> {
    let root = state.root_opt();
    let theme = render::load_theme(root.as_deref(), &id);
    let name = theme.name.clone().unwrap_or_else(|| id.clone());
    let text = format!("---\ntitle: \"{}\"\nauthor: NoteZ\ndate: today\ntheme: {id}\n---\n\n{}", name.replace('"', "'"), theme_sample(&theme));
    let built = render::build(root.as_deref(), "__theme_preview__.md", &text, &Rendered::default());
    let mut w = state.snippets.lock().unwrap();
    w.prepare(&built.main_path, built.source, vec![])?;
    compile::first_page_svg(&w)
}

/// Typst code for a special block (for inserting diagrams into .typ notes).
pub(super) fn block_typst(lang: String, code: String) -> Res<String> {
    let mut ctx = render::blocks::BlockCtx::default();
    match render::blocks::render(&lang, &code, &mut ctx) {
        Some(r) => r.map(|(t, _)| t),
        None => Err(format!("no renderer for `{lang}`")),
    }
}

/// Absolute path of an image referenced from a note (relative path, or an
/// Obsidian-style bare file name found anywhere in the vault).
pub(super) fn resolve_asset(state: &AppState, note: String, url: String) -> Res<Option<String>> {
    let root = state.root()?;
    let dir = note.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
    Ok(render::resolve_image(Some(&root), &dir, &url).map(|rel| root.join(rel.trim_start_matches('/')).to_string_lossy().into_owned()))
}

/// Markdown → HTML for the in-app Help (the bundled docs).
pub(super) fn markdown_html(text: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_FOOTNOTES | Options::ENABLE_MATH;
    let mut out = String::new();
    html::push_html(&mut out, Parser::new_ext(text, opts));
    out
}

pub(super) fn list_fonts() -> Vec<String> {
    render::world::font_families()
}

// ----------------------------------------------------------------- themes

#[derive(Serialize)]
pub(super) struct ThemeInfo {
    id: String,
    name: String,
    description: String,
    builtin: bool,
    customized: bool,
}

pub(super) fn list_themes(state: &AppState) -> Vec<ThemeInfo> {
    let root = state.root_opt();
    let custom_dir = root.as_ref().map(|r| r.join(".notez/styles"));
    let mut custom: Vec<String> = custom_dir
        .as_ref()
        .and_then(|d| std::fs::read_dir(d).ok())
        .map(|it| {
            it.flatten()
                .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".yaml").map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    custom.sort();
    let mut out = Vec::new();
    for (id, _) in styles::BUILTIN_THEMES {
        let t = render::load_theme(root.as_deref(), id);
        out.push(ThemeInfo {
            id: id.to_string(),
            name: t.name.unwrap_or_else(|| id.to_string()),
            description: t.description.unwrap_or_default(),
            builtin: true,
            customized: custom.iter().any(|c| c == id),
        });
    }
    for id in custom.into_iter().filter(|c| styles::builtin(c).is_none()) {
        let t = render::load_theme(root.as_deref(), &id);
        out.push(ThemeInfo {
            name: t.name.clone().unwrap_or_else(|| id.clone()),
            description: t.description.unwrap_or_default(),
            id,
            builtin: false,
            customized: true,
        });
    }
    out
}

/// Fully resolved theme (built-in + vault overrides).
pub(super) fn get_theme(state: &AppState, id: String) -> Theme {
    render::load_theme(state.root_opt().as_deref(), &id)
}

/// Effective theme of a note (theme + its frontmatter overrides).
pub(super) fn note_theme(state: &AppState, path: String, text: String) -> Theme {
    let root = state.root_opt();
    if path.ends_with(".typ") {
        let id = text
            .lines()
            .next()
            .and_then(|l| l.trim().strip_prefix("// theme:"))
            .map(|t| t.trim().to_string())
            .unwrap_or_else(|| "default".into());
        return render::load_theme(root.as_deref(), &id);
    }
    let (fm, ..) = render::parse_frontmatter(&text);
    render::theme_for(root.as_deref(), &fm, render::split_frontmatter(&text).0)
}

/// Save a theme into the vault (`.notez/styles/<id>.yaml`).
pub(super) fn save_theme(state: &AppState, id: String, theme: Theme) -> Res<()> {
    let safe: String = id.chars().filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_')).collect();
    if safe.is_empty() {
        return Err("invalid theme id".into());
    }
    let yaml = serde_yaml_ng::to_string(&theme).map_err(|e| e.to_string())?;
    vault::write(&state.root()?, &format!(".notez/styles/{safe}.yaml"), &yaml)
}

/// Remove vault overrides of a theme (built-ins return to factory settings).
pub(super) fn reset_theme(state: &AppState, id: String) -> Res<()> {
    let root = state.root()?;
    let p = root.join(".notez/styles").join(format!("{id}.yaml"));
    if p.exists() {
        std::fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{render_preview, AppState};

    #[test]
    fn concurrent_previews_keep_each_requests_source() {
        let state = AppState::new(None);
        let start = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            for (path, text, pages) in [
                ("short.typ", "First page", 1),
                ("long.typ", "First page\n#pagebreak()\nSecond page", 2),
            ] {
                let (state, start) = (&state, &start);
                scope.spawn(move || {
                    start.wait();
                    for _ in 0..4 {
                        let result = render_preview(state, path.into(), text.into(), vec![], vec![]).unwrap();
                        assert_eq!(result.preview.pages.len(), pages, "{path}");
                    }
                });
            }
        });
    }

    #[test]
    fn data_fences_found() {
        let t = "a\n```base\nviews: []\n```\n````md\n```query\nx\n```\n````\n~~~ query\ntag:a\n~~~\n";
        let f = super::data_fences(t);
        assert_eq!(f, vec![("base".to_string(), "views: []".to_string()), ("query".to_string(), "tag:a".to_string())]);
    }
}
