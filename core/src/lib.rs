mod annotations;
mod bases;
mod blockidx;
mod export;
mod history;
mod sync;
mod links;
mod query;
mod render;
mod vault;
mod srs;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use serde_json::{json, Value};

use render::compile::{self, Diagnostic, SourceMap};
use render::md::Rendered;
use render::styles::{self, Theme};
use render::world::NoteWorld;

pub struct AppState {
    vault: Mutex<Option<PathBuf>>,
    /// Text of every note (search, backlinks, graph); built when a vault opens.
    index: Arc<Mutex<Option<vault::Index>>>,
    /// Long-lived world for the open note: incremental compiles are fast.
    world: Arc<Mutex<NoteWorld>>,
    /// Separate world for small snippets (inline diagram previews).
    snippets: Arc<Mutex<NoteWorld>>,
    /// File history settings (from the UI's preferences).
    history: Mutex<history::Config>,
    /// Sync runs one at a time.
    sync_lock: Mutex<()>,
}

impl AppState {
    fn root(&self) -> Result<PathBuf, String> {
        self.vault.lock().unwrap().clone().ok_or_else(|| "no vault open".into())
    }
    fn root_opt(&self) -> Option<PathBuf> {
        self.vault.lock().unwrap().clone()
    }
    fn hist(&self) -> history::Config {
        self.history.lock().unwrap().clone()
    }
    /// Keep the current content of `rel` in history before it changes.
    /// History problems never block the change itself.
    fn keep(&self, root: &Path, rel: &str, reason: &str) {
        if let Err(e) = history::keep(root, &self.hist(), rel, reason) {
            eprintln!("history: {rel}: {e}");
        }
    }
    /// Write a note changed by a vault-wide operation, keeping its old text.
    fn rewrite(&self, root: &Path, rel: &str, text: &str, reason: &str) -> Res<()> {
        self.keep(root, rel, reason);
        vault::write(root, rel, text)?;
        self.with_index(|i, _| i.put(rel, text))
    }
    /// Run `f` on the note index, building it first if needed.
    fn with_index<T>(&self, f: impl FnOnce(&mut vault::Index, &Path) -> T) -> Res<T> {
        let root = self.root()?;
        let mut idx = self.index.lock().unwrap();
        let idx = idx.get_or_insert_with(|| vault::Index::build(&root));
        Ok(f(idx, &root))
    }
}

type Res<T> = Result<T, String>;

// ------------------------------------------------------------------ vault

fn open_vault(state: &AppState, path: String) -> Res<Vec<vault::Entry>> {
    let root = PathBuf::from(path);
    let tree = vault::tree(&root)?;
    *state.vault.lock().unwrap() = Some(root.clone());
    // Build the index in the background; queries before it is done wait for it.
    {
        let index = state.index.clone();
        let mut guard = index.lock().unwrap();
        *guard = None;
        drop(guard);
        let r = root.clone();
        std::thread::spawn(move || {
            let mut g = index.lock().unwrap();
            if g.is_none() {
                *g = Some(vault::Index::build(&r));
            }
        });
    }
    state.world.lock().unwrap().set_vault(Some(root.clone()));
    state.snippets.lock().unwrap().set_vault(Some(root));
    Ok(tree)
}

fn list_tree(state: &AppState) -> Res<Vec<vault::Entry>> {
    vault::tree(&state.root()?)
}

fn list_notes(state: &AppState) -> Res<Vec<String>> {
    Ok(vault::all_notes(&state.root()?))
}

fn read_note(state: &AppState, path: String) -> Res<String> {
    vault::read(&state.root()?, &path)
}

fn write_note(state: &AppState, path: String, content: String) -> Res<()> {
    let root = state.root()?;
    if history::tracked(&path) {
        let old = vault::resolve(&root, &path).ok().and_then(|p| std::fs::read(p).ok());
        if let Err(e) = history::on_save(&root, &state.hist(), &path, old.as_deref(), content.as_bytes()) {
            eprintln!("history: {path}: {e}");
        }
    }
    vault::write(&root, &path, &content)?;
    state.with_index(|i, _| i.put(&path, &content))
}

fn create_note(state: &AppState, path: String) -> Res<()> {
    vault::create(&state.root()?, &path)?;
    state.with_index(|i, _| i.put(&path, ""))
}

fn create_folder(state: &AppState, path: String) -> Res<()> {
    vault::create_dir(&state.root()?, &path)
}

/// Rename/move a note or folder; with `update_links`, rewrite the links that
/// point to it. Returns the (new) paths of the notes rewritten.
fn duplicate_entry(state: &AppState, path: String) -> Res<String> {
    let to = vault::duplicate(&state.root()?, &path)?;
    state.with_index(|i, r| i.refresh(r, &to))?;
    Ok(to)
}

fn rename_entry(state: &AppState, from: String, to: String, update_links: bool) -> Res<Vec<String>> {
    let root = state.root()?;
    let plan = if update_links { state.with_index(|i, r| links::plan_rename(i, r, &from, &to))? } else { vec![] };
    vault::rename(&root, &from, &to)?;
    history::rename(&root, &from, &to);
    annotations::rename(&root, &from, &to);
    state.with_index(|i, r| {
        i.refresh(r, &from);
        i.refresh(r, &to);
    })?;
    let mut changed = Vec::new();
    for (note, text) in plan {
        let note = if note == from { to.clone() } else if let Some(rest) = note.strip_prefix(&format!("{from}/")) { format!("{to}/{rest}") } else { note };
        state.rewrite(&root, &note, &text, "before-link-update")?;
        changed.push(note);
    }
    Ok(changed)
}

fn delete_entry(state: &AppState, path: String) -> Res<()> {
    let root = state.root()?;
    state.keep(&root, &path, "deleted");
    vault::delete(&root, &path)?;
    state.with_index(|i, r| i.refresh(r, &path))
}

/// Files changed on disk outside the app (from the shell's watcher).
fn index_update(state: &AppState, paths: Vec<String>) -> Res<()> {
    let cfg = state.hist();
    state.with_index(|i, r| {
        for p in &paths {
            // Changed or removed outside the app: keep the text we had.
            let p = p.trim_matches('/');
            let prefix = format!("{p}/");
            let olds: Vec<(String, String)> = i
                .paths()
                .filter(|k| *k == p || k.starts_with(&prefix))
                .filter_map(|k| i.text(k).map(|t| (k.clone(), t.to_string())))
                .collect();
            for (k, old) in olds {
                let disk = std::fs::read(r.join(&k)).ok();
                if disk.as_deref() != Some(old.as_bytes()) {
                    let reason = if disk.is_none() { "deleted" } else { "outside" };
                    if let Err(e) = history::record(r, &cfg, &k, old.as_bytes(), reason) {
                        eprintln!("history: {k}: {e}");
                    }
                }
            }
            i.refresh(r, p);
        }
    })
}

// ---------------------------------------------------------------- history

fn history_text(state: &AppState, h: String) -> Res<String> {
    let bytes = history::get_object(&state.root()?, &h)?;
    String::from_utf8(bytes).map_err(|_| "not a text file".into())
}

fn history_restore(state: &AppState, path: String, h: String) -> Res<String> {
    let root = state.root()?;
    let text = history::restore(&root, &state.hist(), &path, &h)?;
    state.with_index(|i, _| i.put(&path, &text))?;
    Ok(text)
}

fn snapshot_restore(state: &AppState, id: String, paths: Option<Vec<String>>, remove_added: bool) -> Res<Vec<String>> {
    let root = state.root()?;
    let done = history::restore_snapshot(&root, &state.hist(), &id, paths.as_deref(), remove_added)?;
    state.with_index(|i, r| done.iter().for_each(|p| i.refresh(r, p)))?;
    Ok(done)
}

fn sync_run(state: &AppState, remote: sync::Remote, passphrase: String) -> Res<sync::Report> {
    let root = state.root()?;
    let Ok(_guard) = state.sync_lock.try_lock() else {
        return Err("a sync is already running".into());
    };
    let report = sync::run(&root, &remote, &passphrase, &state.hist())?;
    state.with_index(|i, r| report.changed.iter().for_each(|p| i.refresh(r, p)))?;
    Ok(report)
}

fn search(state: &AppState, query: String, exclude: Vec<String>) -> Res<Vec<query::Hit>> {
    state.with_index(|i, _| query::search(i, &query, 500, &exclude))?
}

fn replace_preview(state: &AppState, opts: query::ReplaceOpts, exclude: Vec<String>) -> Res<Vec<query::FileChanges>> {
    state.with_index(|i, _| query::replace_preview(i, &opts, &exclude))?
}

/// Rename a tag in every note; returns the paths changed.
fn rename_tag(state: &AppState, from: String, to: String) -> Res<Vec<String>> {
    let root = state.root()?;
    let writes = state.with_index(|i, _| query::rename_tag(i, &from, &to))?;
    let mut done = vec![];
    for (p, text) in writes {
        state.rewrite(&root, &p, &text, "before-tag-rename")?;
        done.push(p);
    }
    Ok(done)
}

/// Replace in `paths` and write them; returns the paths changed.
fn replace_apply(state: &AppState, opts: query::ReplaceOpts, paths: Vec<String>) -> Res<Vec<String>> {
    let root = state.root()?;
    let writes = state.with_index(|i, _| query::replace_apply(i, &opts, &paths))??;
    let mut done = vec![];
    for (p, text) in writes {
        state.rewrite(&root, &p, &text, "before-replace")?;
        done.push(p);
    }
    Ok(done)
}

fn backlinks(state: &AppState, path: String, exclude: Vec<String>) -> Res<Vec<blockidx::Backlink>> {
    state.with_index(|i, r| blockidx::backlinks(i, r, &path, &exclude))
}

#[derive(Serialize)]
struct BlockIdResult {
    id: String,
    /// The note's new text when the id was added and `text` was given
    /// (an open note: the UI applies it to its buffer).
    text: Option<String>,
    changed: bool,
}

/// The `^id` of the block at `line` (1-based) of `path`, added when missing.
/// With `text` (the open note's buffer) nothing is written: the new text is
/// returned instead.
fn block_id(state: &AppState, path: String, line: usize, text: Option<String>, want: Option<String>) -> Res<BlockIdResult> {
    state.with_index(|i, root| {
        let given = text.is_some();
        let text = match text {
            Some(t) => t,
            None => i.text(&path).map(String::from).ok_or_else(|| format!("{path}: not in the vault"))?,
        };
        let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
        let (id, new) = blockidx::ensure_id(&text, line.saturating_sub(1), seed ^ typst::utils::hash128(&path) as u64, want.as_deref())
            .ok_or_else(|| "no block on that line".to_string())?;
        let changed = new.is_some();
        if let (Some(new), false) = (&new, given) {
            let _ = history::on_save(root, &state.hist(), &path, Some(text.as_bytes()), new.as_bytes());
            std::fs::write(vault::resolve(root, &path)?, new).map_err(|e| e.to_string())?;
            i.put(&path, new);
        }
        Ok(BlockIdResult { id, text: if given { new } else { None }, changed })
    })?
}

#[derive(Serialize)]
struct Section {
    path: String,
    text: String,
    /// 1-based first and last line in the note.
    start: usize,
    end: usize,
}

/// Resolve a link (`Note`, `Note#Heading`, `Note#^id`, `#^id`) written in
/// `from` to the note and the lines it points at.
fn note_section(state: &AppState, from: String, link: String) -> Res<Option<Section>> {
    state.with_index(|i, root| {
        let link = link.split('|').next().unwrap_or("").trim();
        let (name, sub) = match link.split_once('#') {
            Some((n, s)) => (n.trim(), Some(s)),
            None => (link, None),
        };
        let name = render::percent_decode(name);
        let path = if name.is_empty() {
            from.clone()
        } else {
            match links::Resolver::new(i, root).resolve(&from, &name) {
                Some((p, _)) if p.ends_with(".md") || p.ends_with(".typ") => p,
                _ => return None,
            }
        };
        let text = i.text(&path)?;
        let (s, e) = match sub.filter(|s| !s.is_empty()) {
            Some(sub) => blockidx::find(text, sub)?,
            None => {
                let lines: Vec<&str> = text.lines().collect();
                (blockidx::body_start(&lines), lines.len().saturating_sub(1))
            }
        };
        Some(Section { text: blockidx::slice(text, s, e), path, start: s + 1, end: e + 1 })
    })
}

#[derive(Deserialize)]
struct MentionItem {
    path: String,
    line: usize,
    at: usize,
    len: usize,
    text: String,
}

fn link_mentions(state: &AppState, link: String, items: Vec<MentionItem>) -> Res<Vec<String>> {
    let root = state.root()?;
    let items: Vec<_> = items.into_iter().map(|m| (m.path, m.line, m.at, m.len, m.text)).collect();
    let writes = state.with_index(|i, _| blockidx::link_mentions(i, &link, &items))?;
    let mut done = vec![];
    for (p, text) in writes {
        state.rewrite(&root, &p, &text, "before-link-update")?;
        done.push(p);
    }
    Ok(done)
}

fn import_attachment(state: &AppState, source: String, dir: Option<String>) -> Res<String> {
    vault::import_attachment(&state.root()?, Path::new(&source), dir.as_deref().unwrap_or("attachments"))
}

fn save_attachment(state: &AppState, name: String, data: String, dir: Option<String>) -> Res<String> {
    let bytes = vault::base64_decode(&data)?;
    vault::save_attachment(&state.root()?, dir.as_deref().unwrap_or("attachments"), &name, &bytes)
}

// ----------------------------------------------------------------- render

#[derive(Deserialize)]
struct RenderedBlock {
    lang: String,
    code: String,
    typst: String,
}

fn rendered_map(blocks: Vec<RenderedBlock>) -> Rendered {
    blocks.into_iter().map(|b| ((b.lang, b.code.trim().to_string()), b.typst)).collect()
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
    let mut want: Vec<(String, String)> = vec![];
    for (lang, code) in data_fences(text) {
        want.push((lang, code));
    }
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

fn prepare(state: &AppState, path: &str, text: &str, blocks: Vec<RenderedBlock>) -> Res<(Arc<Mutex<NoteWorld>>, SourceMap, Vec<String>)> {
    let root = state.root_opt();
    let mut map = rendered_map(blocks);
    data_blocks(state, path, text, &mut map);
    let built = render::build(root.as_deref(), path, text, &map);
    let world = state.world.clone();
    world.lock().unwrap().prepare(&built.main_path, built.source, vec![])?;
    Ok((world, built.map, built.notes))
}

#[derive(Serialize)]
struct PreviewResult {
    #[serde(flatten)]
    preview: compile::PreviewDiff,
    notes: Vec<String>,
}

fn render_preview(
    state: &AppState,
    path: String,
    text: String,
    blocks: Vec<RenderedBlock>,
    known: Vec<String>,
) -> Res<PreviewResult> {
    let (world, map, notes) = prepare(state, &path, &text, blocks)?;
    let w = world.lock().unwrap();
    Ok(PreviewResult { preview: compile::preview_diff(&w, &map, &known), notes })
}

fn export_pdf(
    state: &AppState,
    path: String,
    text: String,
    blocks: Vec<RenderedBlock>,
    output: String,
) -> Result<(), Vec<Diagnostic>> {
    let err = |m: String| vec![Diagnostic { severity: "error", message: m, hints: vec![], line: None, column: None, file: None }];
    let (world, map, _) = prepare(state, &path, &text, blocks).map_err(err)?;
    let w = world.lock().unwrap();
    let bytes = compile::pdf(&w, &map)?;
    std::fs::write(&output, bytes).map_err(|e| err(e.to_string()))
}

/// A Markdown note read for Word/HTML export, with its ```base/```query
/// views run like the PDF's.
fn export_prepare(state: &AppState, path: &str, text: &str, blocks: Vec<RenderedBlock>) -> export::Prepared {
    let root = state.root_opt();
    let mut map = rendered_map(blocks);
    data_blocks(state, path, text, &mut map);
    export::prepare(root.as_deref(), path, text, &map)
}

/// Export a note as one self-contained HTML file. Returns warnings.
fn export_html(state: &AppState, path: String, text: String, blocks: Vec<RenderedBlock>, output: String) -> Res<Vec<String>> {
    let p = export_prepare(state, &path, &text, blocks);
    let drawn = export::draw(&mut state.snippets.lock().unwrap(), &p, true, false);
    let (html, mut warnings) = export::html::write(&p, &drawn);
    warnings.extend(p.warnings.iter().cloned());
    std::fs::write(&output, html).map_err(|e| e.to_string())?;
    Ok(warnings)
}

/// Export a note as a Word document (.docx). Returns warnings.
fn export_docx(state: &AppState, path: String, text: String, blocks: Vec<RenderedBlock>, output: String) -> Res<Vec<String>> {
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
fn export_markdown(state: &AppState, path: String, text: String, blocks: Vec<RenderedBlock>, output: String) -> Res<Vec<String>> {
    let root = state.root()?;
    let mut map = rendered_map(blocks);
    data_blocks(state, &path, &text, &mut map);
    let resolve_note = |from: &str, target: &str| -> Option<String> {
        state.with_index(|idx, r| links::Resolver::new(idx, r).resolve(from, target).map(|(p, _)| p)).ok().flatten()
    };
    export::markdown::write(&mut state.snippets.lock().unwrap(), &root, &path, &text, &map, &resolve_note, Path::new(&output))
}

/// Typst source a note compiles to (for "View generated Typst").
fn generated_typst(state: &AppState, path: String, text: String, blocks: Vec<RenderedBlock>) -> String {
    let mut map = rendered_map(blocks);
    data_blocks(state, &path, &text, &mut map);
    render::build(state.root_opt().as_deref(), &path, &text, &map).source
}

/// Render one special block (chart, flow, ...) to SVG for inline previews.
fn render_block(state: &AppState, lang: String, code: String) -> Res<String> {
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
fn theme_thumbnail(state: &AppState, id: String) -> Res<String> {
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
fn block_typst(lang: String, code: String) -> Res<String> {
    let mut ctx = render::blocks::BlockCtx::default();
    match render::blocks::render(&lang, &code, &mut ctx) {
        Some(r) => r.map(|(t, _)| t),
        None => Err(format!("no renderer for `{lang}`")),
    }
}

/// Absolute path of an image referenced from a note (relative path, or an
/// Obsidian-style bare file name found anywhere in the vault).
fn resolve_asset(state: &AppState, note: String, url: String) -> Res<Option<String>> {
    let root = state.root()?;
    let dir = note.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
    Ok(render::resolve_image(Some(&root), &dir, &url).map(|rel| root.join(rel.trim_start_matches('/')).to_string_lossy().into_owned()))
}

/// Markdown → HTML for the in-app Help (the bundled docs).
fn markdown_html(text: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_FOOTNOTES | Options::ENABLE_MATH;
    let mut out = String::new();
    html::push_html(&mut out, Parser::new_ext(text, opts));
    out
}

fn list_fonts() -> Vec<String> {
    render::world::font_families()
}

// ----------------------------------------------------------------- themes

#[derive(Serialize)]
struct ThemeInfo {
    id: String,
    name: String,
    description: String,
    builtin: bool,
    customized: bool,
}

fn list_themes(state: &AppState) -> Vec<ThemeInfo> {
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
fn get_theme(state: &AppState, id: String) -> Theme {
    render::load_theme(state.root_opt().as_deref(), &id)
}

/// Effective theme of a note (theme + its frontmatter overrides).
fn note_theme(state: &AppState, path: String, text: String) -> Theme {
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
fn save_theme(state: &AppState, id: String, theme: Theme) -> Res<()> {
    let safe: String = id.chars().filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_')).collect();
    if safe.is_empty() {
        return Err("invalid theme id".into());
    }
    let yaml = serde_yaml_ng::to_string(&theme).map_err(|e| e.to_string())?;
    vault::write(&state.root()?, &format!(".notez/styles/{safe}.yaml"), &yaml)
}

/// Remove vault overrides of a theme (built-ins return to factory settings).
fn reset_theme(state: &AppState, id: String) -> Res<()> {
    let root = state.root()?;
    let p = root.join(".notez/styles").join(format!("{id}.yaml"));
    if p.exists() {
        std::fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------- plugins

#[derive(Serialize, Deserialize, Clone)]
struct PluginManifest {
    id: String,
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    author: String,
}

fn list_plugins(state: &AppState) -> Res<Vec<PluginManifest>> {
    let dir = state.root()?.join(".notez/plugins");
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(vec![]) };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let manifest = e.path().join("manifest.json");
        if let Ok(text) = std::fs::read_to_string(&manifest) {
            match serde_json::from_str::<PluginManifest>(&text) {
                Ok(m) if m.id == e.file_name().to_string_lossy() => out.push(m),
                Ok(m) => eprintln!("plugin {}: folder name must equal id", m.id),
                Err(err) => eprintln!("plugin {}: {err}", manifest.display()),
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn read_plugin(state: &AppState, id: String) -> Res<String> {
    vault::read(&state.root()?, &format!(".notez/plugins/{id}/main.js"))
}

impl AppState {
    /// `packages`: bundled Typst packages folder (None → source tree, for dev).
    pub fn new(packages: Option<PathBuf>) -> Self {
        let bundled = packages.filter(|d| d.is_dir()).unwrap_or_else(render::world::dev_packages_dir);
        AppState {
            vault: Mutex::new(None),
            index: Arc::new(Mutex::new(None)),
            world: Arc::new(Mutex::new(NoteWorld::new(bundled.clone()))),
            snippets: Arc::new(Mutex::new(NoteWorld::new(bundled))),
            history: Mutex::new(history::Config::default()),
            sync_lock: Mutex::new(()),
        }
    }
}

pub fn warm_up() {
    render::world::warm_up();
}

fn arg<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, Value> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null)).map_err(|e| json!(format!("bad argument `{key}`: {e}")))
}

/// Optional argument: missing or null → default.
fn opt<T: serde::de::DeserializeOwned + Default>(args: &Value, key: &str) -> T {
    args.get(key).cloned().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

fn out<T: Serialize, E: Serialize>(r: Result<T, E>) -> Result<Value, Value> {
    match r {
        Ok(v) => Ok(serde_json::to_value(v).unwrap_or(Value::Null)),
        Err(e) => Err(serde_json::to_value(e).unwrap_or(Value::Null)),
    }
}

fn ok<T: Serialize>(v: T) -> Result<Value, Value> {
    out::<T, ()>(Ok(v))
}

/// Run one command from the UI.
pub fn dispatch(state: &AppState, cmd: &str, a: &Value) -> Result<Value, Value> {
    match cmd {
        "open_vault" => out(open_vault(state, arg(a, "path")?)),
        "list_tree" => out(list_tree(state)),
        "list_notes" => out(list_notes(state)),
        "read_note" => out(read_note(state, arg(a, "path")?)),
        "write_note" => out(write_note(state, arg(a, "path")?, arg(a, "content")?)),
        "create_note" => out(create_note(state, arg(a, "path")?)),
        "create_folder" => out(create_folder(state, arg(a, "path")?)),
        "rename_entry" => out(rename_entry(state, arg(a, "from")?, arg(a, "to")?, opt(a, "update_links"))),
        "link_refs" => out(state.with_index(|i, r| links::refs(i, r, &arg::<String>(a, "path").unwrap_or_default()))),
        "link_info" => out(state.with_index(|i, _| links::info(i))),
        "delete_entry" => out(delete_entry(state, arg(a, "path")?)),
        "duplicate_entry" => out(duplicate_entry(state, arg(a, "path")?)),
        "search" => out(search(state, arg(a, "query")?, opt(a, "exclude"))),
        "replace_preview" => out(replace_preview(state, arg(a, "opts")?, opt(a, "exclude"))),
        "replace_apply" => out(replace_apply(state, arg(a, "opts")?, arg(a, "paths")?)),
        "rename_tag" => out(rename_tag(state, arg(a, "from")?, arg(a, "to")?)),
        "list_tags" => out(state.with_index(|i, _| query::list_tags(i, &opt::<Vec<String>>(a, "exclude")))),
        "note_meta" => out(state.with_index(|i, _| query::note_meta(i))),
        "backlinks" => out(backlinks(state, arg(a, "path")?, opt(a, "exclude"))),
        "unlinked_mentions" => out(state.with_index(|i, _| blockidx::unlinked(i, &arg::<String>(a, "path").unwrap_or_default(), &opt::<Vec<String>>(a, "exclude"), 300))),
        "link_mentions" => out(link_mentions(state, arg(a, "link")?, arg(a, "items")?)),
        "block_search" => out(state.with_index(|i, _| blockidx::search(i, &opt::<String>(a, "query"), &opt::<String>(a, "from"), &opt::<Vec<String>>(a, "exclude"), 60))),
        "block_id" => out(block_id(state, arg(a, "path")?, arg(a, "line")?, opt(a, "text"), opt(a, "id"))),
        "note_section" => out(note_section(state, opt(a, "from"), arg(a, "link")?)),
        "base_query" => out(state.with_index(|i, r| {
            bases::query(i, r, &opt::<String>(a, "src"), opt::<Option<String>>(a, "view").as_deref(), opt::<Option<String>>(a, "this").as_deref(), &opt::<Vec<String>>(a, "exclude"))
        }).and_then(|r| r)),
        "query_block" => out(state.with_index(|i, r| bases::query_block(i, r, &opt::<String>(a, "src"), opt::<Option<String>>(a, "this").as_deref(), &opt::<Vec<String>>(a, "exclude"))).and_then(|r| r)),
        "base_eval" => out(state.with_index(|i, r| bases::eval_for(i, r, &opt::<String>(a, "expr"), &opt::<String>(a, "path"))).and_then(|r| r)),
        "pdf_links" => out(state.with_index(|i, r| annotations::links_to(i, r, &arg::<String>(a, "path").unwrap_or_default(), &opt::<Vec<String>>(a, "exclude")))),
        "srs_overview" => out(state.with_index(|i, r| srs::overview(i, r, &opt::<Vec<String>>(a, "exclude"), &opt::<srs::Settings>(a, "settings")))),
        "srs_queue" => out(state.with_index(|i, r| srs::queue(i, r, opt::<Option<String>>(a, "deck").as_deref(), &opt::<Vec<String>>(a, "exclude"), &opt::<srs::Settings>(a, "settings")))),
        "srs_grade" => {
            let (id, g): (String, u8) = (arg(a, "id")?, arg(a, "grade")?);
            out(state.root().and_then(|r| srs::grade(&r, &id, g, &opt::<srs::Settings>(a, "settings"))))
        }
        "srs_restore" => {
            let id: String = arg(a, "id")?;
            out(state.root().and_then(|r| srs::restore(&r, &id, opt(a, "prev"))))
        }
        "srs_stats" => out(state.with_index(|i, r| srs::stats(i, r, &opt::<Vec<String>>(a, "exclude")))),
        "srs_load" => out(state.root().map(|r| srs::load(&r).cards)),
        "property_names" => out(state.with_index(|i, _| bases::property_names(i, &opt::<Vec<String>>(a, "exclude")))),
        "property_values" => out(state.with_index(|i, _| bases::property_values(i, &opt::<String>(a, "name"), &opt::<Vec<String>>(a, "exclude")))),
        "graph_links" => out(state.with_index(|i, r| links::graph(i, r, &opt::<Vec<String>>(a, "exclude")))),
        "index_update" => out(index_update(state, arg(a, "paths")?)),
        "history_config" => {
            *state.history.lock().unwrap() = arg(a, "config")?;
            ok(true)
        }
        "history_list" => out(state.root().map(|r| history::list(&r, &opt::<String>(a, "path")))),
        "history_text" => out(history_text(state, arg(a, "hash")?)),
        "history_restore" => out(history_restore(state, arg(a, "path")?, arg(a, "hash")?)),
        "history_deleted" => out(state.root().map(|r| history::deleted(&r))),
        "history_keep" => out(state.root().map(|r| state.keep(&r, &opt::<String>(a, "path"), &opt::<String>(a, "reason")))),
        "history_cleanup" => {
            // In the background: it walks every stored object.
            let (r, cfg) = (state.root(), state.hist());
            if let Ok(r) = r {
                std::thread::spawn(move || {
                    if let Err(e) = history::cleanup(&r, &cfg) {
                        eprintln!("history cleanup: {e}");
                    }
                });
            }
            ok(true)
        }
        "snapshot_create" => out(state.root().and_then(|r| history::create_snapshot(&r, &opt::<String>(a, "label"), opt(a, "auto")))),
        "sync_run" => out(sync_run(state, arg(a, "remote")?, opt(a, "passphrase"))),
        "sync_test" => out(sync::test(&arg::<sync::Remote>(a, "remote")?, &opt::<String>(a, "passphrase"))),
        "sync_status" => out(state.root().map(|r| sync::status(&r))),
        "sync_cleanup" => out(sync::cleanup(&arg::<sync::Remote>(a, "remote")?, &opt::<String>(a, "passphrase"))),
        "snapshot_list" => out(state.root().map(|r| history::list_snapshots(&r))),
        "snapshot_diff" => out(state.root().and_then(|r| history::diff_snapshot(&r, &opt::<String>(a, "id")))),
        "snapshot_text" => out(state.root().and_then(|r| history::snapshot_text(&r, &opt::<String>(a, "id"), &opt::<String>(a, "path")))),
        "snapshot_restore" => out(snapshot_restore(state, arg(a, "id")?, opt(a, "paths"), opt(a, "remove_added"))),
        "snapshot_delete" => out(state.root().and_then(|r| history::delete_snapshot(&r, &opt::<String>(a, "id")))),
        "import_attachment" => out(import_attachment(state, arg(a, "source")?, opt(a, "dir"))),
        "save_attachment" => out(save_attachment(state, arg(a, "name")?, arg(a, "data")?, opt(a, "dir"))),
        "render_preview" => out(render_preview(state, arg(a, "path")?, arg(a, "text")?, arg(a, "blocks")?, a.get("known").and_then(|k| serde_json::from_value(k.clone()).ok()).unwrap_or_default())),
        "export_pdf" => out(export_pdf(state, arg(a, "path")?, arg(a, "text")?, arg(a, "blocks")?, arg(a, "output")?)),
        "export_html" => out(export_html(state, arg(a, "path")?, arg(a, "text")?, arg(a, "blocks")?, arg(a, "output")?)),
        "export_docx" => out(export_docx(state, arg(a, "path")?, arg(a, "text")?, arg(a, "blocks")?, arg(a, "output")?)),
        "export_markdown" => out(export_markdown(state, arg(a, "path")?, arg(a, "text")?, arg(a, "blocks")?, arg(a, "output")?)),
        "generated_typst" => ok(generated_typst(state, arg(a, "path")?, arg(a, "text")?, arg(a, "blocks")?)),
        "render_block" => out(render_block(state, arg(a, "lang")?, arg(a, "code")?)),
        "block_typst" => out(block_typst(arg(a, "lang")?, arg(a, "code")?)),
        "resolve_asset" => out(resolve_asset(state, arg(a, "note")?, arg(a, "url")?)),
        "list_fonts" => ok(list_fonts()),
        "markdown_html" => ok(markdown_html(&arg::<String>(a, "text")?)),
        "list_themes" => ok(list_themes(state)),
        "get_theme" => ok(get_theme(state, arg(a, "id")?)),
        "theme_thumbnail" => out(theme_thumbnail(state, arg(a, "id")?)),
        "note_theme" => ok(note_theme(state, arg(a, "path")?, arg(a, "text")?)),
        "save_theme" => out(save_theme(state, arg(a, "id")?, arg(a, "theme")?)),
        "reset_theme" => out(reset_theme(state, arg(a, "id")?)),
        "list_plugins" => out(list_plugins(state)),
        "read_plugin" => out(read_plugin(state, arg(a, "id")?)),
        _ => Err(json!(format!("unknown command `{cmd}`"))),
    }
}

#[cfg(test)]
mod data_fence_tests {
    #[test]
    fn data_fences_found() {
        let t = "a\n```base\nviews: []\n```\n````md\n```query\nx\n```\n````\n~~~ query\ntag:a\n~~~\n";
        let f = super::data_fences(t);
        assert_eq!(f, vec![("base".to_string(), "views: []".to_string()), ("query".to_string(), "tag:a".to_string())]);
    }
}
