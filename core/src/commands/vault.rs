use crate::{annotations, history, links, vault, AppState, Res};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub(super) fn open_vault(state: &AppState, path: String) -> Res<Vec<vault::Entry>> {
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

pub(super) fn list_tree(state: &AppState) -> Res<Vec<vault::Entry>> {
    vault::tree(&state.root()?)
}

pub(super) fn list_notes(state: &AppState) -> Res<Vec<String>> {
    Ok(vault::all_notes(&state.root()?))
}

pub(super) fn read_note(state: &AppState, path: String) -> Res<String> {
    vault::read(&state.root()?, &path)
}

pub(super) fn write_note(state: &AppState, path: String, content: String) -> Res<()> {
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

pub(super) fn create_note(state: &AppState, path: String) -> Res<()> {
    vault::create(&state.root()?, &path)?;
    state.with_index(|i, _| i.put(&path, ""))
}

pub(super) fn create_folder(state: &AppState, path: String) -> Res<()> {
    vault::create_dir(&state.root()?, &path)
}

/// Rename/move a note or folder; with `update_links`, rewrite the links that
/// point to it. Returns the (new) paths of the notes rewritten.
pub(super) fn duplicate_entry(state: &AppState, path: String) -> Res<String> {
    let to = vault::duplicate(&state.root()?, &path)?;
    state.with_index(|i, r| i.refresh(r, &to))?;
    Ok(to)
}

pub(super) fn rename_entry(state: &AppState, from: String, to: String, update_links: bool) -> Res<Vec<String>> {
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

pub(super) fn delete_entry(state: &AppState, path: String) -> Res<()> {
    let root = state.root()?;
    state.keep(&root, &path, "deleted");
    vault::delete(&root, &path)?;
    state.with_index(|i, r| i.refresh(r, &path))
}

/// Files changed on disk outside the app (from the shell's watcher).
pub(super) fn index_update(state: &AppState, paths: Vec<String>) -> Res<()> {
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

pub(super) fn import_attachment(state: &AppState, source: String, dir: Option<String>) -> Res<String> {
    vault::import_attachment(&state.root()?, Path::new(&source), dir.as_deref().unwrap_or("attachments"))
}

pub(super) fn save_attachment(state: &AppState, name: String, data: String, dir: Option<String>) -> Res<String> {
    let bytes = vault::base64_decode(&data)?;
    vault::save_attachment(&state.root()?, dir.as_deref().unwrap_or("attachments"), &name, &bytes)
}

#[derive(Serialize, Deserialize, Clone)]
pub(super) struct PluginManifest {
    id: String,
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    author: String,
}

pub(super) fn list_plugins(state: &AppState) -> Res<Vec<PluginManifest>> {
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

pub(super) fn read_plugin(state: &AppState, id: String) -> Res<String> {
    vault::read(&state.root()?, &format!(".notez/plugins/{id}/main.js"))
}
