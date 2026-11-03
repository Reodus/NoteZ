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
        } else if is_note(&path) {
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
    fn tree_lists_notes_only() {
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
        assert_eq!(names, ["sub", "a.md", "b.typ"]);
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

pub fn search(root: &Path, query: &str, limit: usize) -> Vec<SearchHit> {
    let q = normalize_text(query.trim());
    if q.is_empty() {
        return vec![];
    }
    let mut hits = Vec::new();
    for rel in all_notes(root) {
        if normalize_text(&rel).contains(&q) {
            hits.push(SearchHit { path: rel.clone(), line: 0, snippet: rel.clone() });
        }
        let Ok(text) = fs::read_to_string(root.join(&rel)) else { continue };
        for (i, line) in text.lines().enumerate() {
            if normalize_text(line).contains(&q) {
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
pub fn backlinks(root: &Path, target: &str) -> Vec<SearchHit> {
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
    for rel in all_notes(root) {
        if rel == target {
            continue;
        }
        let Ok(text) = fs::read_to_string(root.join(&rel)) else { continue };
        for (i, line) in text.lines().enumerate() {
            if needles.iter().any(|n| line.contains(n.as_str())) {
                hits.push(SearchHit { path: rel.clone(), line: i + 1, snippet: line.trim().chars().take(160).collect() });
            }
        }
    }
    hits
}

/// Copy an external file into `<vault>/attachments/`, returning its vault path.
pub fn import_attachment(root: &Path, src: &Path) -> Result<String, String> {
    let name = src.file_name().ok_or("no file name")?.to_string_lossy().to_string();
    let dir = root.join("attachments");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.clone(), String::new()),
    };
    let mut target = dir.join(&name);
    let mut n = 1;
    while target.exists() {
        target = dir.join(format!("{stem}-{n}{ext}"));
        n += 1;
    }
    fs::copy(src, &target).map_err(|e| e.to_string())?;
    Ok(target.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod search_tests {
    use super::*;

    #[test]
    fn persian_normalisation() {
        assert_eq!(normalize_text("كتاب‌هاي"), normalize_text("کتابهای"));
        assert_eq!(normalize_text("Hello"), "hello");
    }
}

/// Every note-to-note link in the vault (`[[wikilinks]]` and `[text](note.md)`),
/// resolved like Obsidian: exact path first, then by file name. For the graph.
pub fn links(root: &Path) -> Vec<(String, String)> {
    let notes = all_notes(root);
    let mut by_stem: std::collections::HashMap<String, &String> = std::collections::HashMap::new();
    for n in &notes {
        let stem = Path::new(n).file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
        by_stem.entry(stem).or_insert(n);
    }
    let resolve = |from: &str, raw: &str| -> Option<String> {
        let t = raw.split(['#', '|', '^']).next()?.trim();
        if t.is_empty() || t.contains("://") {
            return None;
        }
        let t = t.replace("%20", " ");
        let dir = from.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
        for cand in [t.clone(), format!("{t}.md"), if dir.is_empty() { t.clone() } else { format!("{dir}/{t}") }, if dir.is_empty() { format!("{t}.md") } else { format!("{dir}/{t}.md") }] {
            if let Some(n) = notes.iter().find(|n| **n == cand) {
                return Some(n.clone());
            }
        }
        let name = t.rsplit('/').next()?;
        let stem = name.strip_suffix(".md").or_else(|| name.strip_suffix(".typ")).unwrap_or(name).to_lowercase();
        by_stem.get(&stem).map(|n| (*n).clone())
    };
    let mut out = Vec::new();
    for from in &notes {
        let Ok(text) = fs::read_to_string(root.join(from)) else { continue };
        let mut rest = text.as_str();
        // [[target]] / ![[target]] (embeds of notes count too)
        while let Some(i) = rest.find("[[") {
            rest = &rest[i + 2..];
            let Some(j) = rest.find("]]") else { break };
            if let Some(to) = resolve(from, &rest[..j]) {
                if to != *from {
                    out.push((from.clone(), to));
                }
            }
            rest = &rest[j + 2..];
        }
        // [text](path.md)
        let mut rest = text.as_str();
        while let Some(i) = rest.find("](") {
            rest = &rest[i + 2..];
            let Some(j) = rest.find(')') else { break };
            let target = rest[..j].split_whitespace().next().unwrap_or("");
            if target.ends_with(".md") || target.ends_with(".typ") {
                if let Some(to) = resolve(from, target) {
                    if to != *from {
                        out.push((from.clone(), to));
                    }
                }
            }
            rest = &rest[j..];
        }
    }
    out.sort();
    out.dedup();
    out
}
