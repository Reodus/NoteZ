use crate::{blockidx, history, links, query, render, vault, AppState, Res};
use serde::{Deserialize, Serialize};

pub(super) fn search(state: &AppState, query: String, exclude: Vec<String>) -> Res<Vec<query::Hit>> {
    state.with_index(|i, _| query::search(i, &query, 500, &exclude))?
}

pub(super) fn replace_preview(state: &AppState, opts: query::ReplaceOpts, exclude: Vec<String>) -> Res<Vec<query::FileChanges>> {
    state.with_index(|i, _| query::replace_preview(i, &opts, &exclude))?
}

/// Rename a tag in every note; returns the paths changed.
pub(super) fn rename_tag(state: &AppState, from: String, to: String) -> Res<Vec<String>> {
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
pub(super) fn replace_apply(state: &AppState, opts: query::ReplaceOpts, paths: Vec<String>, expected: Option<std::collections::BTreeMap<String, String>>) -> Res<Vec<String>> {
    let root = state.root()?;
    let writes = state.with_index(|i, _| {
        // Validate the full preview selection before changing any file.
        if let Some(expected) = expected {
            for path in &paths {
                let text = vault::read(&root, path)?;
                if expected.get(path) != Some(&history::hash(text.as_bytes())) {
                    return Err(format!("{} changed since the replace preview", path));
                }
                i.put(path, &text);
            }
        }
        query::replace_apply(i, &opts, &paths)
    })??;
    let mut done = vec![];
    for (p, text) in writes {
        state.rewrite(&root, &p, &text, "before-replace")?;
        done.push(p);
    }
    Ok(done)
}

pub(super) fn backlinks(state: &AppState, path: String, exclude: Vec<String>) -> Res<Vec<blockidx::Backlink>> {
    state.with_index(|i, r| blockidx::backlinks(i, r, &path, &exclude))
}

#[derive(Serialize)]
pub(super) struct BlockIdResult {
    id: String,
    /// The note's new text when the id was added and `text` was given
    /// (an open note: the UI applies it to its buffer).
    text: Option<String>,
    changed: bool,
}

/// The `^id` of the block at `line` (1-based) of `path`, added when missing.
/// With `text` (the open note's buffer) nothing is written: the new text is
/// returned instead.
pub(super) fn block_id(state: &AppState, path: String, line: usize, text: Option<String>, want: Option<String>) -> Res<BlockIdResult> {
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
pub(super) struct Section {
    path: String,
    text: String,
    /// 1-based first and last line in the note.
    start: usize,
    end: usize,
}

/// Resolve a link (`Note`, `Note#Heading`, `Note#^id`, `#^id`) written in
/// `from` to the note and the lines it points at.
pub(super) fn note_section(state: &AppState, from: String, link: String) -> Res<Option<Section>> {
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
pub(super) struct MentionItem {
    path: String,
    line: usize,
    at: usize,
    len: usize,
    text: String,
}

pub(super) fn link_mentions(state: &AppState, link: String, items: Vec<MentionItem>) -> Res<Vec<String>> {
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
