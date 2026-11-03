//! The Typst `World`: where the compiler gets sources, files, fonts and
//! packages from.
//!
//! - Project files come from the vault folder, with an in-memory overlay for
//!   unsaved editor buffers and generated sources.
//! - Packages come from the bundled `typst-packages/` folder first, then the
//!   user's Typst cache, then Typst Universe (downloaded on demand).
//! - Fonts: Typst's embedded fonts + bundled Vazirmatn + system fonts.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_kit::datetime::Time;
use typst_kit::downloader::SystemDownloader;
use typst_kit::files::{FileLoader, FileStore, FsRoot};
use typst_kit::fonts::FontStore;
use typst_kit::packages::{FsPackages, SystemPackages, UniversePackages};

static BUNDLED_FONTS: &[&[u8]] = &[
    include_bytes!("../../fonts/Vazirmatn-Light.ttf"),
    include_bytes!("../../fonts/Vazirmatn-Regular.ttf"),
    include_bytes!("../../fonts/Vazirmatn-Medium.ttf"),
    include_bytes!("../../fonts/Vazirmatn-SemiBold.ttf"),
    include_bytes!("../../fonts/Vazirmatn-Bold.ttf"),
];

/// Scanning system fonts takes a moment, so it happens once, lazily.
static FONTS: LazyLock<Arc<FontStore>> = LazyLock::new(|| {
    let mut store = FontStore::new();
    store.extend(typst_kit::fonts::embedded());
    for data in BUNDLED_FONTS {
        store.extend(Font::iter(Bytes::new(*data)).map(|f| {
            let info = f.info().clone();
            (f, info)
        }));
    }
    store.extend(typst_kit::fonts::system());
    Arc::new(store)
});

/// Kick off font scanning in the background so the first compile is fast.
pub fn warm_up() {
    std::thread::spawn(|| LazyLock::force(&FONTS));
}

/// Sorted, de-duplicated font family names (for the font pickers).
pub fn font_families() -> Vec<String> {
    let mut names: Vec<String> = FONTS.book().families().map(|(name, _)| name.to_string()).collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    names
}

/// Bundled packages folder used when running from source.
pub fn dev_packages_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("typst-packages")
}

struct Loader {
    vault: Option<FsRoot>,
    /// In-memory files that shadow the vault (unsaved buffers, generated code).
    overlay: HashMap<FileId, Bytes>,
    packages: SystemPackages,
}

impl FileLoader for Loader {
    fn load(&self, id: FileId) -> FileResult<Bytes> {
        if let Some(bytes) = self.overlay.get(&id) {
            return Ok(bytes.clone());
        }
        match id.root() {
            VirtualRoot::Project => match &self.vault {
                Some(root) => root.load(id.vpath()),
                None => Err(FileError::AccessDenied),
            },
            VirtualRoot::Package(spec) => self.packages.obtain(spec)?.load(id.vpath()),
        }
    }
}

pub struct NoteWorld {
    library: LazyHash<Library>,
    fonts: Arc<FontStore>,
    store: FileStore<Loader>,
    main: FileId,
    time: Time,
}

pub fn project_file(path: &str) -> Result<FileId, String> {
    let vpath = VirtualPath::new(path).map_err(|e| format!("bad path {path}: {e:?}"))?;
    Ok(RootedPath::new(VirtualRoot::Project, vpath).intern())
}

impl NoteWorld {
    pub fn new(bundled: PathBuf) -> Self {
        Self::with_package_cache(bundled, FsPackages::system_cache())
    }

    /// `bundled` holds packages shipped with the app; `cache` is where
    /// downloaded packages are stored (vendoring passes the bundled folder).
    pub fn with_package_cache(bundled: PathBuf, cache: Option<FsPackages>) -> Self {
        let packages = SystemPackages::from_parts(
            Some(FsPackages::new(bundled)),
            cache,
            UniversePackages::new(SystemDownloader::new(concat!("notez/", env!("CARGO_PKG_VERSION")))),
        );
        let loader = Loader { vault: None, overlay: HashMap::new(), packages };
        Self {
            library: LazyHash::new(Library::default()),
            fonts: FONTS.clone(),
            store: FileStore::new(loader),
            main: project_file("/main.typ").unwrap(),
            time: Time::system(),
        }
    }

    /// Point the world at a vault folder (relative images/includes resolve there).
    pub fn set_vault(&mut self, root: Option<PathBuf>) {
        self.store.loader_mut().vault = root.map(FsRoot::new);
        self.store.reset();
    }

    /// Prepare a compile: `main_path` is the vault-relative virtual location of
    /// the main source (so relative paths resolve next to the note) and `text`
    /// its content. Extra in-memory files can be supplied too.
    pub fn prepare(&mut self, main_path: &str, text: String, extra: Vec<(String, Bytes)>) -> Result<(), String> {
        let main = project_file(main_path)?;
        let loader = self.store.loader_mut();
        loader.overlay.clear();
        loader.overlay.insert(main, Bytes::from_string(text));
        for (path, bytes) in extra {
            loader.overlay.insert(project_file(&path)?, bytes);
        }
        self.main = main;
        self.store.reset();
        self.time.reset();
        Ok(())
    }

    pub fn main_source(&self) -> FileResult<Source> {
        self.store.source(self.main)
    }
}

impl World for NoteWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }
    fn book(&self) -> &LazyHash<FontBook> {
        self.fonts.book()
    }
    fn main(&self) -> FileId {
        self.main
    }
    fn source(&self, id: FileId) -> FileResult<Source> {
        self.store.source(id)
    }
    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.store.file(id)
    }
    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.font(index)
    }
    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        self.time.today(offset)
    }
}
