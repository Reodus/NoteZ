//! Vault: a plain folder of notes (.md / .typ). All paths crossing IPC are
//! relative to the vault root; `resolve` rejects anything escaping it.

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

pub const NOTE_EXTS: &[&str] = &["md", "typ"];

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    /// Path relative to vault root, '/'-separated.
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<Entry>,
}

/// Join `rel` onto `root`, refusing absolute paths and `..` components.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    for c in rel_path.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("invalid path: {rel}")),
        }
    }
    Ok(root.join(rel_path))
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

fn is_note(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| NOTE_EXTS.contains(&e))
}

fn build(root: &Path, dir: &Path) -> std::io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for item in fs::read_dir(dir)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        let path = item.path();
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let is_dir = item.file_type()?.is_dir();
        if is_dir {
            entries.push(Entry { name, path: rel, is_dir, children: build(root, &path)? });
        } else {
            // Every file: the UI shows notes, images and PDFs (and, if asked, the rest).
            entries.push(Entry { name, path: rel, is_dir, children: vec![] });
        }
    }
    // Folders first, then case-insensitive by name.
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

pub fn tree(root: &Path) -> Result<Vec<Entry>, String> {
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    build(root, root).map_err(|e| e.to_string())
}

pub fn read(root: &Path, rel: &str) -> Result<String, String> {
    fs::read_to_string(resolve(root, rel)?).map_err(|e| e.to_string())
}

pub fn write(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    let path = resolve(root, rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

/// Create a new note; fails if it already exists.
pub fn create(root: &Path, rel: &str) -> Result<(), String> {
    let path = resolve(root, rel)?;
    if !is_note(&path) {
        return Err("note must end in .md or .typ".into());
    }
    if path.exists() {
        return Err(format!("already exists: {rel}"));
    }
    write(root, rel, "")
}

pub fn create_dir(root: &Path, rel: &str) -> Result<(), String> {
    fs::create_dir_all(resolve(root, rel)?).map_err(|e| e.to_string())
}

pub fn rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let dst = resolve(root, to)?;
    if dst.exists() {
        return Err(format!("already exists: {to}"));
    }
    fs::rename(resolve(root, from)?, dst).map_err(|e| e.to_string())
}

/// Copy a file or folder next to itself as "name 1.ext" (first free number);
/// returns the new vault path.
pub fn duplicate(root: &Path, rel: &str) -> Result<String, String> {
    let src = resolve(root, rel)?;
    if rel.is_empty() || !src.exists() {
        return Err(format!("not found: {rel}"));
    }
    let (dir, name) = rel.rsplit_once('/').map(|(d, n)| (format!("{d}/"), n)).unwrap_or((String::new(), rel));
    let (base, ext) = match name.rsplit_once('.') {
        Some((b, e)) if !src.is_dir() && !b.is_empty() => (b, format!(".{e}")),
        _ => (name, String::new()),
    };
    let to = (1..1000)
        .map(|n| format!("{dir}{base} {n}{ext}"))
        .find(|c| resolve(root, c).map(|p| !p.exists()).unwrap_or(false))
        .ok_or("no free name")?;
    fn copy_all(from: &Path, to: &Path) -> std::io::Result<()> {
        if from.is_dir() {
            fs::create_dir_all(to)?;
            for item in fs::read_dir(from)? {
                let item = item?;
                copy_all(&item.path(), &to.join(item.file_name()))?;
            }
            Ok(())
        } else {
            fs::copy(from, to).map(|_| ())
        }
    }
    copy_all(&src, &resolve(root, &to)?).map_err(|e| e.to_string())?;
    Ok(to)
}

pub fn delete(root: &Path, rel: &str) -> Result<(), String> {
    let path = resolve(root, rel)?;
    if rel.is_empty() || path == root {
        return Err("refusing to delete vault root".into());
    }
    if path.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rejects_escape() {
        let root = Path::new("/vault");
        assert!(resolve(root, "../etc/passwd").is_err());
        assert!(resolve(root, "/etc/passwd").is_err());
        assert!(resolve(root, "a/../../b").is_err());
        assert_eq!(resolve(root, "a/b.md").unwrap(), PathBuf::from("/vault/a/b.md"));
    }

    #[test]
    fn duplicate_picks_free_name() {
        let dir = std::env::temp_dir().join(format!("notez-dup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("f/sub")).unwrap();
        fs::write(dir.join("f/a.md"), "x").unwrap();
        fs::write(dir.join("f/a 1.md"), "y").unwrap();
        fs::write(dir.join("f/sub/p.png"), "z").unwrap();
        assert_eq!(duplicate(&dir, "f/a.md").unwrap(), "f/a 2.md");
        assert_eq!(fs::read_to_string(dir.join("f/a 2.md")).unwrap(), "x");
        assert_eq!(duplicate(&dir, "f/sub").unwrap(), "f/sub 1");
        assert!(dir.join("f/sub 1/p.png").is_file());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tree_lists_all_files() {
        let dir = std::env::temp_dir().join(format!("notez-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::create_dir_all(dir.join(".notez")).unwrap();
        fs::write(dir.join("a.md"), "").unwrap();
        fs::write(dir.join("b.typ"), "").unwrap();
        fs::write(dir.join("c.png"), "").unwrap();
        fs::write(dir.join("sub/d.md"), "").unwrap();
        let t = tree(&dir).unwrap();
        let names: Vec<_> = t.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["sub", "a.md", "b.typ", "c.png"]);
        assert_eq!(t[0].children[0].path, "sub/d.md");
        fs::remove_dir_all(&dir).unwrap();
    }
}

// ------------------------------------------------------------------ search

/// Normalise for matching: lowercase, unify Arabic/Persian letter variants,
/// drop diacritics and zero-width joiners.
pub fn normalize_text(s: &str) -> String {
    s.chars()
        .filter_map(|c| match c {
            'ي' | 'ى' => Some('ی'),
            'ك' => Some('ک'),
            'ة' => Some('ه'),
            'أ' | 'إ' | 'آ' => Some('ا'),
            'ۀ' => Some('ه'),
            '\u{064B}'..='\u{065F}' | '\u{0670}' | '\u{200C}' | '\u{200D}' => None,
            c => Some(c),
        })
        .flat_map(char::to_lowercase)
        .collect()
}

#[derive(Serialize)]
pub struct SearchHit {
    pub path: String,
    /// 1-based; 0 means the file name matched.
    pub line: usize,
    pub snippet: String,
}

fn walk_notes(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name();
        if is_hidden(&name.to_string_lossy()) {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            walk_notes(root, &p, out);
        } else if is_note(&p) {
            out.push(p);
        }
    }
}

/// Every non-hidden file that is not a note (images, PDFs…), vault-relative.
pub fn all_files(root: &Path) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for item in rd.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            if is_hidden(&name) {
                continue;
            }
            let p = item.path();
            if p.is_dir() {
                walk(root, &p, out);
            } else if !is_note(&p) {
                if let Ok(rel) = p.strip_prefix(root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    let mut v = Vec::new();
    walk(root, root, &mut v);
    v.sort();
    v
}

pub fn all_notes(root: &Path) -> Vec<String> {
    let mut v = Vec::new();
    walk_notes(root, root, &mut v);
    let mut rel: Vec<String> = v
        .iter()
        .filter_map(|p| p.strip_prefix(root).ok())
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .collect();
    rel.sort();
    rel
}

/// In-memory copy of every note's text (plus a normalised form for search),
/// kept current by writes from the UI and by file-system events. Search,
/// backlinks and the graph read from it instead of the disk.
#[derive(Default)]
pub struct Index {
    docs: std::collections::BTreeMap<String, Doc>,
}

struct Doc {
    text: String,
    norm: Vec<String>,
}

impl Doc {
    fn new(text: String) -> Self {
        let norm = text.lines().map(normalize_text).collect();
        Doc { text, norm }
    }
}

impl Index {
    pub fn build(root: &Path) -> Self {
        let mut idx = Index::default();
        for rel in all_notes(root) {
            if let Ok(text) = fs::read_to_string(root.join(&rel)) {
                idx.docs.insert(rel, Doc::new(text));
            }
        }
        idx
    }

    pub fn put(&mut self, rel: &str, text: &str) {
        if is_note(Path::new(rel)) && !rel.split('/').any(is_hidden) {
            self.docs.insert(rel.to_string(), Doc::new(text.to_string()));
        }
    }

    /// Re-read `rel` (a note or a folder) from disk; drops what no longer exists.
    pub fn refresh(&mut self, root: &Path, rel: &str) {
        let rel = rel.trim_matches('/');
        if rel.split('/').any(is_hidden) {
            return;
        }
        let prefix = format!("{rel}/");
        self.docs.retain(|k, _| k != rel && !(rel.is_empty() || k.starts_with(&prefix)));
        let Ok(path) = resolve(root, rel) else { return };
        if path.is_dir() {
            let mut found = Vec::new();
            walk_notes(root, &path, &mut found);
            for p in found {
                let Ok(r) = p.strip_prefix(root) else { continue };
                let r = r.to_string_lossy().replace('\\', "/");
                if let Ok(text) = fs::read_to_string(&p) {
                    self.docs.insert(r, Doc::new(text));
                }
            }
        } else if path.is_file() && is_note(&path) {
            if let Ok(text) = fs::read_to_string(&path) {
                self.docs.insert(rel.to_string(), Doc::new(text));
            }
        }
    }

    pub fn paths(&self) -> impl Iterator<Item = &String> {
        self.docs.keys()
    }

    pub fn text(&self, rel: &str) -> Option<&str> {
        self.docs.get(rel).map(|d| d.text.as_str())
    }

    fn iter(&self, exclude: &[String]) -> impl Iterator<Item = (&String, &Doc)> {
        self.docs.iter().filter(move |(k, _)| !excluded(k, exclude))
    }
}

/// `rel` lies inside one of the `exclude` folders.
pub fn excluded(rel: &str, exclude: &[String]) -> bool {
    exclude.iter().map(|e| e.trim_matches('/')).filter(|e| !e.is_empty()).any(|e| rel == e || rel.starts_with(&format!("{e}/")))
}

pub fn search(idx: &Index, query: &str, limit: usize, exclude: &[String]) -> Vec<SearchHit> {
    let q = normalize_text(query.trim());
    if q.is_empty() {
        return vec![];
    }
    let mut hits = Vec::new();
    for (rel, doc) in idx.iter(exclude) {
        if normalize_text(rel).contains(&q) {
            hits.push(SearchHit { path: rel.clone(), line: 0, snippet: rel.clone() });
        }
        for (i, (line, norm)) in doc.text.lines().zip(&doc.norm).enumerate() {
            if norm.contains(&q) {
                let snippet: String = line.trim().chars().take(160).collect();
                hits.push(SearchHit { path: rel.clone(), line: i + 1, snippet });
                if hits.len() >= limit {
                    return hits;
                }
            }
        }
    }
    hits
}

/// Notes that link to `target` via [[wikilink]] or a Markdown link.
pub fn backlinks(idx: &Index, target: &str) -> Vec<SearchHit> {
    let stem = Path::new(target).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let file = Path::new(target).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let needles = [
        format!("[[{stem}]]"),
        format!("[[{stem}|"),
        format!("[[{stem}#"),
        format!("[[{file}]]"),
        format!("({target})"),
        format!("({file})"),
        format!("({})", target.replace(' ', "%20")),
    ];
    let mut hits = Vec::new();
    for (rel, doc) in idx.iter(&[]) {
        if rel == target {
            continue;
        }
        for (i, line) in doc.text.lines().enumerate() {
            if needles.iter().any(|n| line.contains(n.as_str())) {
                hits.push(SearchHit { path: rel.clone(), line: i + 1, snippet: line.trim().chars().take(160).collect() });
            }
        }
    }
    hits
}

/// A free file name for `name` inside vault folder `dir` (created if missing).
fn unique_target(root: &Path, dir: &str, name: &str) -> Result<PathBuf, String> {
    let dir = resolve(root, dir.trim_matches('/'))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name: String = name.chars().map(|c| if matches!(c, '/' | '\\' | '\0') { '_' } else { c }).collect();
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.clone(), String::new()),
    };
    let mut target = dir.join(&name);
    let mut n = 1;
    while target.exists() {
        target = dir.join(format!("{stem}-{n}{ext}"));
        n += 1;
    }
    Ok(target)
}

fn vault_rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

/// Copy an external file into vault folder `dir`, returning its vault path.
pub fn import_attachment(root: &Path, src: &Path, dir: &str) -> Result<String, String> {
    let name = src.file_name().ok_or("no file name")?.to_string_lossy().to_string();
    // Already inside the vault: link it where it is.
    if let Ok(rel) = src.strip_prefix(root) {
        if src.is_file() {
            return Ok(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    let target = unique_target(root, dir, &name)?;
    fs::copy(src, &target).map_err(|e| e.to_string())?;
    Ok(vault_rel(root, &target))
}

/// Write `bytes` as a new file `name` in vault folder `dir`.
pub fn save_attachment(root: &Path, dir: &str, name: &str, bytes: &[u8]) -> Result<String, String> {
    let target = unique_target(root, dir, name)?;
    fs::write(&target, bytes).map_err(|e| e.to_string())?;
    Ok(vault_rel(root, &target))
}

/// Standard base64 (with or without padding/whitespace).
pub fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        } as u32)
    };
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes().filter(|c| !c.is_ascii_whitespace() && *c != b'=') {
        acc = (acc << 6) | val(c).ok_or("invalid base64")?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod search_tests {
    use super::*;

    #[test]
    fn index_follows_changes() {
        let dir = std::env::temp_dir().join(format!("notez-idx-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.md"), "سلام دنیا\nlink [[b]]").unwrap();
        fs::write(dir.join("sub/b.md"), "hello").unwrap();
        let mut idx = Index::build(&dir);
        assert_eq!(search(&idx, "دنيا", 10, &[]).len(), 1, "Persian variants match");
        assert_eq!(backlinks(&idx, "sub/b.md").len(), 1);
        assert!(search(&idx, "hello", 10, &["sub".into()]).is_empty(), "excluded folder");

        idx.put("a.md", "changed");
        assert!(search(&idx, "سلام", 10, &[]).is_empty());
        fs::write(dir.join("sub/c.md"), "fresh text").unwrap();
        fs::rename(dir.join("sub"), dir.join("moved")).unwrap();
        idx.refresh(&dir, "sub");
        idx.refresh(&dir, "moved");
        let paths: Vec<_> = idx.paths().cloned().collect();
        assert_eq!(paths, ["a.md", "moved/b.md", "moved/c.md"]);
        fs::remove_file(dir.join("a.md")).unwrap();
        idx.refresh(&dir, "a.md");
        assert_eq!(idx.paths().count(), 2);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn base64_roundtrip() {
        assert_eq!(base64_decode("aGVsbG8gd29ybGQ=").unwrap(), b"hello world");
        assert_eq!(base64_decode("AP8=").unwrap(), [0u8, 255]);
    }

    #[test]
    fn persian_normalisation() {
        assert_eq!(normalize_text("كتاب‌هاي"), normalize_text("کتابهای"));
        assert_eq!(normalize_text("Hello"), "hello");
    }
}
