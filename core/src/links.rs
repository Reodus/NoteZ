//! Link resolution shared by the graph, renames and [[ completion, and the
//! rewriting of links when a note or folder is renamed or moved.
//! Resolution follows Obsidian: exact vault path, then path relative to the
//! linking note, then by file name anywhere in the vault.

use crate::vault::{self, Index};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    /// Written as a vault path (`a/b`, `a/b.md`).
    Root,
    /// Written relative to the linking note's folder.
    Dir,
    /// A bare file name resolved anywhere in the vault.
    Stem,
}

pub struct Resolver<'a> {
    root: &'a Path,
    notes: Vec<&'a String>,
    by_stem: HashMap<String, Vec<&'a String>>,
    /// Non-note files (images, PDFs…) by lower-cased file name; read from
    /// disk the first time an attachment link needs it.
    files: std::cell::OnceCell<HashMap<String, Vec<String>>>,
}

pub fn stem_of(p: &str) -> String {
    let name = p.rsplit('/').next().unwrap_or(p);
    name.strip_suffix(".md").or_else(|| name.strip_suffix(".typ")).unwrap_or(name).to_string()
}

fn dir_of(p: &str) -> &str {
    p.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

fn join(dir: &str, rel: &str) -> String {
    if dir.is_empty() { rel.to_string() } else { format!("{dir}/{rel}") }
}

fn has_ext(t: &str) -> bool {
    t.ends_with(".md") || t.ends_with(".typ")
}

impl<'a> Resolver<'a> {
    pub fn new(idx: &'a Index, root: &'a Path) -> Self {
        let notes: Vec<&String> = idx.paths().collect();
        let mut by_stem: HashMap<String, Vec<&String>> = HashMap::new();
        for n in &notes {
            by_stem.entry(stem_of(n).to_lowercase()).or_default().push(n);
        }
        Resolver { root, notes, by_stem, files: std::cell::OnceCell::new() }
    }

    fn files(&self) -> &HashMap<String, Vec<String>> {
        self.files.get_or_init(|| {
            let mut m: HashMap<String, Vec<String>> = HashMap::new();
            for p in vault::all_files(self.root) {
                let name = p.rsplit('/').next().unwrap_or(&p).to_lowercase();
                m.entry(name).or_default().push(p);
            }
            m
        })
    }

    /// Other files in the vault with the same file name as `p`.
    pub fn same_name_count(&self, p: &str, except: &str) -> usize {
        let name = p.rsplit('/').next().unwrap_or(p).to_lowercase();
        self.files().get(&name).map(|v| v.iter().filter(|x| x.as_str() != except).count()).unwrap_or(0)
    }

    fn exists(&self, p: &str) -> bool {
        self.notes.binary_search_by(|n| n.as_str().cmp(p)).is_ok()
            || (!p.is_empty() && vault::resolve(self.root, p).map(|f| f.is_file()).unwrap_or(false))
    }

    /// The vault path a link target (without #heading / |alias) points to.
    pub fn resolve(&self, from: &str, raw: &str) -> Option<(String, Kind)> {
        let t = raw.trim().trim_start_matches('/').replace("%20", " ");
        if t.is_empty() || t.contains("://") || t.starts_with("mailto:") {
            return None;
        }
        let dir = dir_of(from);
        for (cand, kind) in [
            (t.clone(), Kind::Root),
            (format!("{t}.md"), Kind::Root),
            (join(dir, &t), Kind::Dir),
            (join(dir, &format!("{t}.md")), Kind::Dir),
        ] {
            if self.exists(&cand) {
                return Some((cand, if dir.is_empty() { Kind::Root } else { kind }));
            }
        }
        let name = t.rsplit('/').next()?;
        let key = name.strip_suffix(".md").or_else(|| name.strip_suffix(".typ")).unwrap_or(name).to_lowercase();
        if let Some(n) = self.by_stem.get(&key).and_then(|v| v.first()) {
            return Some(((*n).clone(), Kind::Stem));
        }
        // `![[pic.png]]`: an attachment found by its file name anywhere.
        if name.contains('.') && !has_ext(name) {
            let mut hits = self.files().get(&name.to_lowercase())?.clone();
            hits.sort();
            return hits.into_iter().next().map(|p| (p, Kind::Stem));
        }
        None
    }

    pub fn is_note(&self, p: &str) -> bool {
        self.notes.binary_search_by(|n| n.as_str().cmp(p)).is_ok()
    }
}

/// Every link in `text`: (byte range of the target, the target text, is_wikilink).
fn scan(text: &str) -> Vec<(usize, usize, bool)> {
    let mut out = Vec::new();
    // [[target#heading|alias]] and ![[...]]
    let mut at = 0;
    while let Some(i) = text[at..].find("[[") {
        let s = at + i + 2;
        let Some(j) = text[s..].find("]]") else { break };
        let inner = &text[s..s + j];
        if !inner.contains('\n') {
            let end = inner.find(['#', '|', '^']).unwrap_or(inner.len());
            out.push((s, s + end, true));
        }
        at = s + j + 2;
    }
    // [text](target "title") and ![alt](target)
    let mut at = 0;
    while let Some(i) = text[at..].find("](") {
        let s = at + i + 2;
        let Some(j) = text[s..].find(')') else { break };
        let inner = &text[s..s + j];
        if !inner.contains('\n') && !inner.starts_with('<') {
            let t = inner.split_whitespace().next().unwrap_or("");
            let t = t.split('#').next().unwrap_or("");
            let lead = inner.len() - inner.trim_start().len();
            if !t.is_empty() {
                out.push((s + lead, s + lead + t.len(), false));
            }
        }
        at = s + j;
    }
    out
}

/// Where `p` ends up when `from` (a note or folder) moves to `to`.
fn moved(p: &str, from: &str, to: &str) -> Option<String> {
    if p == from {
        Some(to.to_string())
    } else {
        p.strip_prefix(from).filter(|r| r.starts_with('/')).map(|r| format!("{to}{r}"))
    }
}

/// New texts of the notes whose links point at `from` (or into it), keyed by
/// their path *before* the move.
pub fn plan_rename(idx: &Index, root: &Path, from: &str, to: &str) -> Vec<(String, String)> {
    let r = Resolver::new(idx, root);
    let folder = !r.is_note(from) && vault::resolve(root, from).map(|p| p.is_dir()).unwrap_or(false);
    let new_stem = stem_of(to).to_lowercase();
    let attachment = !folder && !r.is_note(from);
    let stem_unique = if attachment {
        r.same_name_count(to, from) == 0
    } else {
        !idx.paths().any(|p| p != from && stem_of(p).to_lowercase() == new_stem)
    };
    let mut plan = Vec::new();
    for note in idx.paths() {
        let Some(text) = idx.text(note) else { continue };
        let note_dir_after = dir_of(&moved(note, from, to).unwrap_or_else(|| note.clone())).to_string();
        let mut edits: Vec<(usize, usize, String)> = Vec::new();
        for (s, e, wiki) in scan(text) {
            let raw = &text[s..e];
            let Some((target, kind)) = r.resolve(note, raw) else { continue };
            let Some(new_path) = moved(&target, from, to) else { continue };
            let keep_ext = has_ext(raw.trim()) || !r.is_note(&target);
            let as_path = |p: &str| if keep_ext { p.to_string() } else { p.trim_end_matches(".md").to_string() };
            let mut new = match kind {
                // `![[pic.png]]` stays a bare file name while it is unique.
                _ if wiki && attachment && stem_unique && !raw.contains('/') => new_path.rsplit('/').next().unwrap_or(&new_path).to_string(),
                Kind::Stem if folder => continue, // bare names still resolve
                Kind::Stem if wiki && stem_unique => {
                    let name = new_path.rsplit('/').next().unwrap_or(&new_path);
                    as_path(name)
                }
                Kind::Dir => match new_path.strip_prefix(&format!("{note_dir_after}/")) {
                    Some(rel) if !note_dir_after.is_empty() => as_path(rel),
                    _ => as_path(&new_path),
                },
                _ => as_path(&new_path),
            };
            if !wiki && (raw.contains("%20") || (!raw.contains(' ') && new.contains(' '))) {
                new = new.replace(' ', "%20");
            }
            if raw.trim().starts_with('/') {
                new.insert(0, '/');
            }
            if new != raw.trim() {
                edits.push((s, e, new));
            }
        }
        if edits.is_empty() {
            continue;
        }
        edits.sort_by_key(|e| e.0);
        let mut out = String::with_capacity(text.len());
        let mut last = 0;
        for (s, e, new) in edits {
            if s < last {
                continue; // overlapping (malformed) links
            }
            out.push_str(&text[last..s]);
            out.push_str(&new);
            last = e;
        }
        out.push_str(&text[last..]);
        plan.push((note.clone(), out));
    }
    plan
}

/// Every note-to-note link, for the graph.
pub fn graph(idx: &Index, root: &Path, exclude: &[String]) -> Vec<(String, String)> {
    let r = Resolver::new(idx, root);
    let mut out = Vec::new();
    for from in idx.paths().filter(|p| !vault::excluded(p, exclude)) {
        let Some(text) = idx.text(from) else { continue };
        for (s, e, wiki) in scan(text) {
            let raw = &text[s..e];
            if !wiki && !has_ext(raw.trim()) {
                continue;
            }
            if let Some((to, _)) = r.resolve(from, raw) {
                if to != *from && r.is_note(&to) && !vault::excluded(&to, exclude) {
                    out.push((from.clone(), to));
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

#[derive(Serialize)]
pub struct LinkInfo {
    pub path: String,
    pub aliases: Vec<String>,
    pub headings: Vec<String>,
}

/// Names, `aliases:` and headings of every note (for [[ completion).
pub fn info(idx: &Index) -> Vec<LinkInfo> {
    idx.paths()
        .map(|p| {
            let text = idx.text(p).unwrap_or("");
            let mut aliases = Vec::new();
            if let Some(fm) = text.strip_prefix("---\n").and_then(|t| t.split_once("\n---").map(|(y, _)| y)) {
                if let Ok(v) = serde_yaml_ng::from_str::<serde_yaml_ng::Value>(fm) {
                    match v.get("aliases").or_else(|| v.get("alias")) {
                        Some(serde_yaml_ng::Value::Sequence(s)) => aliases.extend(s.iter().filter_map(|x| x.as_str().map(String::from))),
                        Some(serde_yaml_ng::Value::String(s)) => aliases.extend(s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty())),
                        _ => {}
                    }
                }
            }
            let mut fence = false;
            let headings = text
                .lines()
                .filter(|l| {
                    if l.trim_start().starts_with("```") {
                        fence = !fence;
                    }
                    !fence
                })
                .filter_map(|l| {
                    let h = l.trim_start_matches('#');
                    (l.starts_with('#') && l.len() - h.len() <= 6 && h.starts_with(' ')).then(|| h.trim().to_string())
                })
                .filter(|h| !h.is_empty())
                .collect();
            LinkInfo { path: p.clone(), aliases, headings }
        })
        .collect()
}

/// How many notes would be rewritten by moving `path`.
pub fn refs(idx: &Index, root: &Path, path: &str) -> usize {
    let probe = format!("{path}\u{1}moved");
    plan_rename(idx, root, path, &probe).len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn vault(name: &str, files: &[(&str, &str)]) -> (std::path::PathBuf, Index) {
        let dir = std::env::temp_dir().join(format!("notez-links-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for (p, t) in files {
            let f = dir.join(p);
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(f, t).unwrap();
        }
        let idx = Index::build(&dir);
        (dir, idx)
    }

    #[test]
    fn rename_attachment_rewrites_links() {
        let (dir, idx) = vault("att", &[("a.md", "![[pic.png]] ![[pic.png|300]] ![x](img/pic.png)"), ("img/n.md", "![](pic.png)"), ("r.md", "![[top.png]]")]);
        std::fs::write(dir.join("img/pic.png"), "x").unwrap();
        std::fs::write(dir.join("top.png"), "x").unwrap();
        let plan: HashMap<_, _> = plan_rename(&idx, &dir, "img/pic.png", "img/photo 1.png").into_iter().collect();
        assert_eq!(plan["a.md"], "![[photo 1.png]] ![[photo 1.png|300]] ![x](img/photo%201.png)");
        assert_eq!(plan["img/n.md"], "![](photo%201.png)");
        // Moved into a folder: still a bare name.
        let plan: HashMap<_, _> = plan_rename(&idx, &dir, "top.png", "img/top.png").into_iter().collect();
        assert_eq!(plan.get("r.md").map(String::as_str), None, "{plan:?}");
    }

    #[test]
    fn rename_note_rewrites_links() {
        let (dir, idx) = vault("rename", &[
            ("a.md", "see [[Old]] and [[Old|alias]] and [[Old#Sec]] and ![[Old]] and [[Other]]"),
            ("sub/Old.md", "# Sec"),
            ("sub/c.md", "[x](Old.md) [y](sub/Old.md) [[sub/Old]]"),
            ("Other.md", ""),
        ]);
        let plan: HashMap<_, _> = plan_rename(&idx, &dir, "sub/Old.md", "sub/New Name.md").into_iter().collect();
        assert_eq!(plan["a.md"], "see [[New Name]] and [[New Name|alias]] and [[New Name#Sec]] and ![[New Name]] and [[Other]]");
        assert_eq!(plan["sub/c.md"], "[x](New%20Name.md) [y](sub/New%20Name.md) [[sub/New Name]]");
        assert_eq!(plan.len(), 2);
        assert_eq!(refs(&idx, &dir, "sub/Old.md"), 2);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn duplicate_name_links_by_path() {
        let (dir, idx) = vault("dup", &[("a.md", "[[x]]"), ("p/x.md", ""), ("q/y.md", "")]);
        let plan = plan_rename(&idx, &dir, "p/x.md", "p/y.md");
        assert_eq!(plan, vec![("a.md".to_string(), "[[p/y]]".to_string())]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn folder_move_rewrites_paths_only() {
        let (dir, idx) = vault("folder", &[
            ("a.md", "[[f/n]] [[n]] ![img](f/pic.png) [z](f/n.md)"),
            ("f/n.md", "[[m]] [l](m.md)"),
            ("f/m.md", ""),
            ("f/pic.png", ""),
        ]);
        let plan: HashMap<_, _> = plan_rename(&idx, &dir, "f", "g/f2").into_iter().collect();
        assert_eq!(plan["a.md"], "[[g/f2/n]] [[n]] ![img](g/f2/pic.png) [z](g/f2/n.md)");
        assert!(!plan.contains_key("f/n.md"), "relative links inside the folder stay valid");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn info_lists_aliases_and_headings() {
        let (dir, idx) = vault("info", &[("n.md", "---\naliases: [Foo, بار]\n---\n# One\n```\n# not\n```\n## Two\n#tag")]);
        let i = info(&idx);
        assert_eq!(i[0].aliases, ["Foo", "بار"]);
        assert_eq!(i[0].headings, ["One", "Two"]);
        fs::remove_dir_all(&dir).unwrap();
    }
}
