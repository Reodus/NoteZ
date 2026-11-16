//! PDF annotations: stored by the UI in `.notez/annotations/<pdf path>.json`
//! (src/ui/PdfView.tsx). The core finds the notes that link into a PDF
//! (`[[file.pdf#page=3&annotation=id]]`) and moves annotation files when a
//! PDF or a folder is renamed. Note comments (`.notez/comments/`) move the
//! same way.

use crate::links::{scan_full, Resolver};
use crate::vault::Index;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug, PartialEq)]
pub struct PdfLink {
    /// The note with the link.
    pub note: String,
    /// 1-based line of the link.
    pub line: usize,
    /// The line's text (trimmed).
    pub text: String,
    pub page: Option<u32>,
    pub annotation: Option<String>,
}

/// `page=3&annotation=abc` (also `page=3`, a bare `3`).
pub fn parse_fragment(sub: &str) -> (Option<u32>, Option<String>) {
    let mut page = None;
    let mut ann = None;
    for part in sub.split('&') {
        match part.split_once('=') {
            Some(("page", v)) => page = v.trim().parse().ok(),
            Some(("annotation", v)) => ann = Some(v.trim().to_string()).filter(|s| !s.is_empty()),
            None if part.trim().parse::<u32>().is_ok() => page = part.trim().parse().ok(),
            _ => {}
        }
    }
    (page, ann)
}

/// Every link from a note to the PDF `pdf`.
pub fn links_to(idx: &Index, root: &Path, pdf: &str, exclude: &[String]) -> Vec<PdfLink> {
    let res = Resolver::new(idx, root);
    let name = pdf.rsplit('/').next().unwrap_or(pdf).to_lowercase();
    let mut out = vec![];
    for (note, doc) in idx.iter(exclude) {
        // cheap filter: the file name has to appear
        if !doc.text.to_lowercase().contains(&name.replace(".pdf", "")) {
            continue;
        }
        for l in scan_full(&doc.text) {
            let target = &doc.text[l.target.clone()];
            if !target.to_lowercase().ends_with(".pdf") {
                continue;
            }
            if res.resolve(note, target).map(|(p, _)| p).as_deref() != Some(pdf) {
                continue;
            }
            let (page, annotation) = l.sub.as_deref().map(parse_fragment).unwrap_or((None, None));
            let line_no = doc.text[..l.target.start].matches('\n').count() + 1;
            let text = doc.text.lines().nth(line_no - 1).unwrap_or("").trim().to_string();
            out.push(PdfLink { note: note.clone(), line: line_no, text, page, annotation });
        }
    }
    out
}

fn dir(root: &Path) -> PathBuf {
    root.join(".notez").join("annotations")
}

/// Note comments (src/core/comments.ts): `.notez/comments/<note path>.json`.
fn comments_dir(root: &Path) -> PathBuf {
    root.join(".notez").join("comments")
}

/// After renaming `from` → `to` (a file or a folder): move the side files
/// kept for it — PDF annotations and note comments — along.
pub fn rename(root: &Path, from: &str, to: &str) {
    for d in [dir(root), comments_dir(root)] {
        move_side_files(&d, from, to);
    }
}

fn move_side_files(d: &Path, from: &str, to: &str) {
    let mv = |a: PathBuf, b: PathBuf| {
        if let Some(p) = b.parent() {
            let _ = fs::create_dir_all(p);
        }
        let _ = fs::rename(&a, &b);
    };
    // a file: its `<path>.json`
    let (a, b) = (d.join(format!("{from}.json")), d.join(format!("{to}.json")));
    if a.is_file() {
        mv(a, b);
        return;
    }
    // a folder: its subtree
    let (a, b) = (d.join(from), d.join(to));
    if a.is_dir() {
        mv(a, b);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragments() {
        assert_eq!(parse_fragment("page=3&annotation=a1"), (Some(3), Some("a1".into())));
        assert_eq!(parse_fragment("page=12"), (Some(12), None));
        assert_eq!(parse_fragment("4"), (Some(4), None));
        assert_eq!(parse_fragment("annotation=x"), (None, Some("x".into())));
    }

    #[test]
    fn finds_links_and_moves_files() {
        let root = std::env::temp_dir().join(format!("nz-ann-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("papers")).unwrap();
        fs::write(root.join("papers/Paper One.pdf"), b"%PDF-1.4").unwrap();
        fs::write(root.join("note.md"), "See [[Paper One.pdf#page=3&annotation=k9|p. 3]].\n\nAlso ![[papers/Paper One.pdf#page=2]] and [[other.pdf]].\n").unwrap();
        let idx = Index::build(&root);
        let l = links_to(&idx, &root, "papers/Paper One.pdf", &[]);
        assert_eq!(l.len(), 2, "{l:?}");
        assert_eq!((l[0].page, l[0].annotation.as_deref(), l[0].line), (Some(3), Some("k9"), 1));
        assert_eq!((l[1].page, l[1].annotation.as_deref(), l[1].line), (Some(2), None, 3));

        fs::create_dir_all(dir(&root).join("papers")).unwrap();
        fs::write(dir(&root).join("papers/Paper One.pdf.json"), "[]").unwrap();
        rename(&root, "papers/Paper One.pdf", "papers/Renamed.pdf");
        assert!(dir(&root).join("papers/Renamed.pdf.json").is_file());
        rename(&root, "papers", "library");
        assert!(dir(&root).join("library/Renamed.pdf.json").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn comments_follow_renames() {
        let root = std::env::temp_dir().join(format!("nz-cmt-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let c = comments_dir(&root);
        fs::create_dir_all(c.join("notes")).unwrap();
        fs::write(c.join("notes/A.md.json"), "{}").unwrap();
        rename(&root, "notes/A.md", "notes/B.md");
        assert!(c.join("notes/B.md.json").is_file());
        assert!(!c.join("notes/A.md.json").exists());
        rename(&root, "notes", "archive/notes");
        assert!(c.join("archive/notes/B.md.json").is_file());
        // nothing to move: no error, nothing created
        rename(&root, "x.md", "y.md");
        assert!(!c.join("y.md.json").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
