mod links;
mod render;
mod vault;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use serde_json::{json, Value};

use render::compile::{self, Diagnostic, Preview, SourceMap};
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
}

impl AppState {
    fn root(&self) -> Result<PathBuf, String> {
        self.vault.lock().unwrap().clone().ok_or_else(|| "no vault open".into())
    }
    fn root_opt(&self) -> Option<PathBuf> {
        self.vault.lock().unwrap().clone()
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
    vault::write(&state.root()?, &path, &content)?;
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
fn rename_entry(state: &AppState, from: String, to: String, update_links: bool) -> Res<Vec<String>> {
    let root = state.root()?;
    let plan = if update_links { state.with_index(|i, r| links::plan_rename(i, r, &from, &to))? } else { vec![] };
    vault::rename(&root, &from, &to)?;
    state.with_index(|i, r| {
        i.refresh(r, &from);
        i.refresh(r, &to);
    })?;
    let mut changed = Vec::new();
    for (note, text) in plan {
        let note = if note == from { to.clone() } else if let Some(rest) = note.strip_prefix(&format!("{from}/")) { format!("{to}/{rest}") } else { note };
        vault::write(&root, &note, &text)?;
        state.with_index(|i, _| i.put(&note, &text))?;
        changed.push(note);
    }
    Ok(changed)
}

fn delete_entry(state: &AppState, path: String) -> Res<()> {
    vault::delete(&state.root()?, &path)?;
    state.with_index(|i, r| i.refresh(r, &path))
}

/// Files changed on disk outside the app (from the shell's watcher).
fn index_update(state: &AppState, paths: Vec<String>) -> Res<()> {
    state.with_index(|i, r| paths.iter().for_each(|p| i.refresh(r, p)))
}

fn search(state: &AppState, query: String, exclude: Vec<String>) -> Res<Vec<vault::SearchHit>> {
    state.with_index(|i, _| vault::search(i, &query, 300, &exclude))
}

fn backlinks(state: &AppState, path: String) -> Res<Vec<vault::SearchHit>> {
    state.with_index(|i, _| vault::backlinks(i, &path))
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

fn prepare(state: &AppState, path: &str, text: &str, blocks: Vec<RenderedBlock>) -> Res<(Arc<Mutex<NoteWorld>>, SourceMap, Vec<String>)> {
    let root = state.root_opt();
    let built = render::build(root.as_deref(), path, text, &rendered_map(blocks));
    let world = state.world.clone();
    world.lock().unwrap().prepare(&built.main_path, built.source, vec![])?;
    Ok((world, built.map, built.notes))
}

#[derive(Serialize)]
struct PreviewResult {
    #[serde(flatten)]
    preview: Preview,
    notes: Vec<String>,
}

fn render_preview(
    state: &AppState,
    path: String,
    text: String,
    blocks: Vec<RenderedBlock>,
) -> Res<PreviewResult> {
    let (world, map, notes) = prepare(state, &path, &text, blocks)?;
    let w = world.lock().unwrap();
    Ok(PreviewResult { preview: compile::preview(&w, &map), notes })
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

/// Typst source a note compiles to (for "View generated Typst").
fn generated_typst(state: &AppState, path: String, text: String, blocks: Vec<RenderedBlock>) -> String {
    render::build(state.root_opt().as_deref(), &path, &text, &rendered_map(blocks)).source
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
        "{imports}#set page(width: auto, height: auto, margin: 6pt, fill: none)\n#set text(font: (\"New Computer Modern\", \"Vazirmatn\"), size: 11pt)\n{typst}\n"
    );
    let mut w = state.snippets.lock().unwrap();
    w.prepare("/__snippet__.typ", src, vec![])?;
    compile::snippet_svg(&w)
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
    render::theme_for(root.as_deref(), &fm)
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
        "search" => out(search(state, arg(a, "query")?, opt(a, "exclude"))),
        "backlinks" => out(backlinks(state, arg(a, "path")?)),
        "graph_links" => out(state.with_index(|i, r| links::graph(i, r, &opt::<Vec<String>>(a, "exclude")))),
        "index_update" => out(index_update(state, arg(a, "paths")?)),
        "import_attachment" => out(import_attachment(state, arg(a, "source")?, opt(a, "dir"))),
        "save_attachment" => out(save_attachment(state, arg(a, "name")?, arg(a, "data")?, opt(a, "dir"))),
        "render_preview" => out(render_preview(state, arg(a, "path")?, arg(a, "text")?, arg(a, "blocks")?)),
        "export_pdf" => out(export_pdf(state, arg(a, "path")?, arg(a, "text")?, arg(a, "blocks")?, arg(a, "output")?)),
        "generated_typst" => ok(generated_typst(state, arg(a, "path")?, arg(a, "text")?, arg(a, "blocks")?)),
        "render_block" => out(render_block(state, arg(a, "lang")?, arg(a, "code")?)),
        "block_typst" => out(block_typst(arg(a, "lang")?, arg(a, "code")?)),
        "resolve_asset" => out(resolve_asset(state, arg(a, "note")?, arg(a, "url")?)),
        "list_fonts" => ok(list_fonts()),
        "list_themes" => ok(list_themes(state)),
        "get_theme" => ok(get_theme(state, arg(a, "id")?)),
        "note_theme" => ok(note_theme(state, arg(a, "path")?, arg(a, "text")?)),
        "save_theme" => out(save_theme(state, arg(a, "id")?, arg(a, "theme")?)),
        "reset_theme" => out(reset_theme(state, arg(a, "id")?)),
        "list_plugins" => out(list_plugins(state)),
        "read_plugin" => out(read_plugin(state, arg(a, "id")?)),
        _ => Err(json!(format!("unknown command `{cmd}`"))),
    }
}
