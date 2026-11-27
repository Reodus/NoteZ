mod annotations;
mod bases;
mod blockidx;
mod commands;
mod export;
mod history;
mod links;
mod markdown_images;
mod query;
mod render;
mod srs;
mod sync;
mod vault;

use render::world::NoteWorld;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub use commands::dispatch;

pub struct AppState {
    vault: Mutex<Option<PathBuf>>,
    /// Text of every note (search, backlinks, graph); built when a vault opens.
    index: Arc<Mutex<Option<vault::Index>>>,
    /// Long-lived world for the open note: incremental compiles are fast.
    world: Mutex<NoteWorld>,
    /// Separate world for small snippets (inline diagram previews).
    snippets: Mutex<NoteWorld>,
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

impl AppState {
    /// `packages`: bundled Typst packages folder (None → source tree, for dev).
    pub fn new(packages: Option<PathBuf>) -> Self {
        let bundled = packages.filter(|d| d.is_dir()).unwrap_or_else(render::world::dev_packages_dir);
        AppState {
            vault: Mutex::new(None),
            index: Arc::new(Mutex::new(None)),
            world: Mutex::new(NoteWorld::new(bundled.clone())),
            snippets: Mutex::new(NoteWorld::new(bundled)),
            history: Mutex::new(history::Config::default()),
            sync_lock: Mutex::new(()),
        }
    }
}

pub fn warm_up() {
    render::world::warm_up();
}
