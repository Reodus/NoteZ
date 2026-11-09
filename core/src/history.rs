//! File history and vault snapshots.
//!
//! Everything lives in `<vault>/.notez/history/`:
//! - `objects/ab/cdef…`: file contents (zlib), named by their BLAKE3 hash, shared
//!   by versions and snapshots;
//! - `files/<hash of path>.json`: the versions of one note, oldest first;
//! - `snapshots/<id>.json`: a manifest of the whole vault (path → hash).
//!
//! A note's version is recorded when it is saved, at most one per
//! `interval` (later saves in the window replace it), and always before it is
//! deleted, replaced, renamed in links, restored or changed by sync. Old
//! versions are dropped after `keep_days` (the newest one of each note stays)
//! or beyond `max_versions`.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct Config {
    pub enabled: bool,
    /// Minutes: saves within this window of a version replace it.
    pub interval: u64,
    pub keep_days: u64,
    pub max_versions: usize,
    /// Automatic vault snapshots kept (manual ones are kept until deleted).
    pub keep_snapshots: usize,
}

impl Default for Config {
    fn default() -> Self {
        Config { enabled: true, interval: 10, keep_days: 60, max_versions: 300, keep_snapshots: 14 }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

fn dir(root: &Path) -> PathBuf {
    root.join(".notez/history")
}

/// Write `bytes` to `path` through a temporary file (never half-written).
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(p) = path.parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// ------------------------------------------------------------ objects

pub fn deflate(bytes: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    let _ = e.write_all(bytes);
    e.finish().unwrap_or_default()
}

pub fn inflate(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    flate2::read::ZlibDecoder::new(bytes).read_to_end(&mut out).map_err(|e| format!("damaged history object: {e}"))?;
    Ok(out)
}

fn object_path(root: &Path, h: &str) -> PathBuf {
    dir(root).join("objects").join(&h[..2.min(h.len())]).join(&h[2.min(h.len())..])
}

/// Store `bytes`; returns their hash.
pub fn put_object(root: &Path, bytes: &[u8]) -> Result<String, String> {
    let h = hash(bytes);
    let p = object_path(root, &h);
    if !p.exists() {
        write_atomic(&p, &deflate(bytes))?;
    }
    Ok(h)
}

pub fn get_object(root: &Path, h: &str) -> Result<Vec<u8>, String> {
    if h.len() < 8 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("bad version id".into());
    }
    let data = fs::read(object_path(root, h)).map_err(|_| "this version is no longer stored".to_string())?;
    let bytes = inflate(&data)?;
    if hash(&bytes) != h {
        return Err("damaged history object".into());
    }
    Ok(bytes)
}

pub fn has_object(root: &Path, h: &str) -> bool {
    object_path(root, h).exists()
}

// ----------------------------------------------------------- versions

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Version {
    /// Content hash.
    pub h: String,
    /// When this content was recorded (ms).
    pub t: u64,
    /// Start of the save window this version covers (ms).
    #[serde(default)]
    pub t0: u64,
    /// Size in bytes.
    pub size: usize,
    /// edit, outside, deleted, before-replace, before-restore, before-sync…
    pub reason: String,
}

#[derive(Default, Deserialize, Serialize)]
struct FileLog {
    path: String,
    versions: Vec<Version>,
}

fn log_path(root: &Path, rel: &str) -> PathBuf {
    dir(root).join("files").join(format!("{}.json", &hash(rel.as_bytes())[..32]))
}

fn read_log(root: &Path, rel: &str) -> FileLog {
    fs::read(log_path(root, rel))
        .ok()
        .and_then(|b| serde_json::from_slice::<FileLog>(&b).ok())
        .filter(|l| l.path == rel)
        .unwrap_or(FileLog { path: rel.to_string(), versions: vec![] })
}

fn write_log(root: &Path, log: &FileLog) -> Result<(), String> {
    let p = log_path(root, &log.path);
    if log.versions.is_empty() {
        let _ = fs::remove_file(p);
        return Ok(());
    }
    write_atomic(&p, &serde_json::to_vec(log).map_err(|e| e.to_string())?)
}

/// Notes are versioned; other files (attachments) are not.
pub fn tracked(rel: &str) -> bool {
    let l = rel.to_ascii_lowercase();
    (l.ends_with(".md") || l.ends_with(".typ") || l.ends_with(".base") || l.ends_with(".canvas")) && !rel.split('/').any(|s| s.starts_with('.'))
}

/// Record `text` as a version of `rel`. `reason` "edit" versions are merged
/// within `cfg.interval`; anything else is always kept as its own version.
pub fn record(root: &Path, cfg: &Config, rel: &str, text: &[u8], reason: &str) -> Result<(), String> {
    if !cfg.enabled || !tracked(rel) {
        return Ok(());
    }
    let mut log = read_log(root, rel);
    let h = hash(text);
    let now = now_ms();
    if let Some(last) = log.versions.last_mut() {
        if last.h == h {
            // Same content: a forced record upgrades nothing; just keep it.
            return Ok(());
        }
        let window = cfg.interval.max(1) * 60_000;
        if reason == "edit" && last.reason == "edit" && now.saturating_sub(last.t0) < window {
            put_object(root, text)?;
            *last = Version { h, t: now, t0: last.t0, size: text.len(), reason: reason.into() };
            return write_log(root, &log);
        }
    }
    put_object(root, text)?;
    log.versions.push(Version { h, t: now, t0: now, size: text.len(), reason: reason.into() });
    prune_log(&mut log, cfg, now);
    write_log(root, &log)
}

/// Before `rel` is overwritten with `new`: keep what is on disk if history
/// doesn't have it yet (edits made outside the app), then the new text.
pub fn on_save(root: &Path, cfg: &Config, rel: &str, old: Option<&[u8]>, new: &[u8]) -> Result<(), String> {
    if !cfg.enabled || !tracked(rel) {
        return Ok(());
    }
    if let Some(old) = old {
        let log = read_log(root, rel);
        let oh = hash(old);
        if old != new && log.versions.last().is_none_or(|v| v.h != oh) && !old.is_empty() {
            record(root, cfg, rel, old, if log.versions.is_empty() { "first" } else { "outside" })?;
        }
    }
    record(root, cfg, rel, new, "edit")
}

/// Keep the current content of `rel` (a note, or every note in a folder) before
/// something changes or removes it.
pub fn keep(root: &Path, cfg: &Config, rel: &str, reason: &str) -> Result<(), String> {
    let path = crate::vault::resolve(root, rel)?;
    if path.is_dir() {
        for f in crate::vault::every_file(root, &path) {
            if tracked(&f) {
                if let Ok(b) = fs::read(root.join(&f)) {
                    record(root, cfg, &f, &b, reason)?;
                }
            }
        }
    } else if let Ok(b) = fs::read(&path) {
        record(root, cfg, rel, &b, reason)?;
    }
    Ok(())
}

/// The history of a note follows it when it is renamed or moved.
pub fn rename(root: &Path, from: &str, to: &str) {
    let files = dir(root).join("files");
    let Ok(entries) = fs::read_dir(&files) else { return };
    for e in entries.flatten() {
        let Ok(b) = fs::read(e.path()) else { continue };
        let Ok(mut log) = serde_json::from_slice::<FileLog>(&b) else { continue };
        let moved = if log.path == from {
            to.to_string()
        } else if let Some(rest) = log.path.strip_prefix(&format!("{from}/")) {
            format!("{to}/{rest}")
        } else {
            continue;
        };
        // Merge with history already recorded at the new path.
        let mut target = read_log(root, &moved);
        target.versions.extend(std::mem::take(&mut log.versions));
        target.versions.sort_by_key(|v| v.t);
        target.versions.dedup_by(|a, b| a.h == b.h && a.t == b.t);
        target.path = moved;
        let _ = fs::remove_file(e.path());
        let _ = write_log(root, &target);
    }
}

fn prune_log(log: &mut FileLog, cfg: &Config, now: u64) {
    let cutoff = now.saturating_sub(cfg.keep_days.max(1) * 86_400_000);
    let n = log.versions.len();
    let mut i = 0;
    log.versions.retain(|v| {
        i += 1;
        i == n || v.t >= cutoff
    });
    if log.versions.len() > cfg.max_versions.max(1) {
        let extra = log.versions.len() - cfg.max_versions.max(1);
        log.versions.drain(..extra);
    }
}

/// Versions of `rel`, newest first.
pub fn list(root: &Path, rel: &str) -> Vec<Version> {
    let mut v = read_log(root, rel).versions;
    v.reverse();
    v
}

#[derive(Serialize, Debug)]
pub struct Deleted {
    pub path: String,
    /// Newest version.
    pub h: String,
    pub t: u64,
    pub size: usize,
}

/// Notes that have history but no longer exist, most recently changed first.
pub fn deleted(root: &Path) -> Vec<Deleted> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir(root).join("files")) else { return out };
    for e in entries.flatten() {
        let Ok(b) = fs::read(e.path()) else { continue };
        let Ok(log) = serde_json::from_slice::<FileLog>(&b) else { continue };
        if root.join(&log.path).exists() {
            continue;
        }
        if let Some(v) = log.versions.last() {
            out.push(Deleted { path: log.path.clone(), h: v.h.clone(), t: v.t, size: v.size });
        }
    }
    out.sort_by_key(|d| std::cmp::Reverse(d.t));
    out
}

/// Put version `h` back as `rel` (keeping the current text first).
pub fn restore(root: &Path, cfg: &Config, rel: &str, h: &str) -> Result<String, String> {
    let bytes = get_object(root, h)?;
    let path = crate::vault::resolve(root, rel)?;
    if path.exists() {
        keep(root, cfg, rel, "before-restore")?;
    }
    if let Some(p) = path.parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    record(root, cfg, rel, &bytes, "restored")?;
    String::from_utf8(bytes).map_err(|_| "not a text file".into())
}

/// Drop expired versions and snapshots, then objects nothing refers to.
pub fn cleanup(root: &Path, cfg: &Config) -> Result<usize, String> {
    let now = now_ms();
    let mut live: HashSet<String> = HashSet::new();
    if let Ok(entries) = fs::read_dir(dir(root).join("files")) {
        for e in entries.flatten() {
            let Ok(b) = fs::read(e.path()) else { continue };
            let Ok(mut log) = serde_json::from_slice::<FileLog>(&b) else { continue };
            let before = log.versions.len();
            prune_log(&mut log, cfg, now);
            // Deleted notes are forgotten after `keep_days`.
            let gone = !root.join(&log.path).exists() && log.versions.last().is_some_and(|v| v.t < now.saturating_sub(cfg.keep_days.max(1) * 86_400_000));
            if gone {
                log.versions.clear();
            }
            if log.versions.len() != before {
                write_log(root, &log)?;
            }
            live.extend(log.versions.iter().map(|v| v.h.clone()));
        }
    }
    // Automatic snapshots beyond `keep_snapshots`.
    let snaps = list_snapshots(root);
    let mut autos = 0;
    for s in &snaps {
        if s.auto {
            autos += 1;
            if autos > cfg.keep_snapshots {
                let _ = fs::remove_file(snapshot_path(root, &s.id));
                continue;
            }
        }
        if let Some(m) = read_snapshot(root, &s.id) {
            live.extend(m.files.values().map(|f| f.h.clone()));
        }
    }
    let mut removed = 0;
    let objs = dir(root).join("objects");
    for d in fs::read_dir(&objs).into_iter().flatten().flatten() {
        let prefix = d.file_name().to_string_lossy().to_string();
        for f in fs::read_dir(d.path()).into_iter().flatten().flatten() {
            let name = f.file_name().to_string_lossy().to_string();
            if name.contains(".tmp") || !live.contains(&format!("{prefix}{name}")) {
                if fs::remove_file(f.path()).is_ok() {
                    removed += 1;
                }
            }
        }
        let _ = fs::remove_dir(d.path());
    }
    Ok(removed)
}

// ---------------------------------------------------------- snapshots

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct FileEntry {
    pub h: String,
    pub size: u64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Snapshot {
    pub id: String,
    pub t: u64,
    pub label: String,
    pub auto: bool,
    pub files: BTreeMap<String, FileEntry>,
}

#[derive(Serialize, Debug)]
pub struct SnapshotInfo {
    pub id: String,
    pub t: u64,
    pub label: String,
    pub auto: bool,
    pub files: usize,
    pub size: u64,
}

fn snapshot_path(root: &Path, id: &str) -> PathBuf {
    dir(root).join("snapshots").join(format!("{id}.json"))
}

fn read_snapshot(root: &Path, id: &str) -> Option<Snapshot> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    serde_json::from_slice(&fs::read(snapshot_path(root, id)).ok()?).ok()
}

/// Files that belong in a snapshot or a sync: everything but NoteZ's own
/// history and sync state, version control and trash folders.
pub fn vault_files(root: &Path) -> Vec<String> {
    crate::vault::every_file(root, root)
        .into_iter()
        .filter(|p| {
            !(p.starts_with(".notez/history/")
                || p.starts_with(".notez/sync/")
                || p.starts_with(".git/")
                || p.starts_with(".trash/")
                || p.ends_with(".DS_Store")
                || p.contains(".tmp"))
        })
        .collect()
}

/// path → (mtime, size, hash) of files already hashed, so unchanged files
/// aren't read again.
type HashCache = BTreeMap<String, (u64, u64, String)>;

fn mtime(m: &fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The vault as path → hash (storing new contents as objects when `store`).
pub fn manifest(root: &Path, store: bool) -> Result<BTreeMap<String, FileEntry>, String> {
    let cache_path = dir(root).join("hashes.json");
    let mut cache: HashCache = fs::read(&cache_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let mut out = BTreeMap::new();
    let mut fresh = HashCache::new();
    let scan = now_ms();
    for rel in vault_files(root) {
        let p = root.join(&rel);
        let Ok(meta) = fs::metadata(&p) else { continue };
        if meta.len() > 200 * 1024 * 1024 {
            continue; // huge files are left out
        }
        let (mt, size) = (mtime(&meta), meta.len());
        let cached = cache.remove(&rel).filter(|(m, s, h)| *m == mt && *s == size && (!store || has_object(root, h)));
        let h = match cached {
            Some((_, _, h)) => h,
            None => {
                let Ok(bytes) = fs::read(&p) else { continue };
                if store { put_object(root, &bytes)? } else { hash(&bytes) }
            }
        };
        // A file changed just now could change again within the same mtime
        // tick without its size changing: don't trust a cached hash for it.
        if mt + 3000 < scan {
            fresh.insert(rel.clone(), (mt, size, h.clone()));
        }
        out.insert(rel, FileEntry { h, size });
    }
    let _ = write_atomic(&cache_path, &serde_json::to_vec(&fresh).unwrap_or_default());
    Ok(out)
}

pub fn list_snapshots(root: &Path) -> Vec<SnapshotInfo> {
    let mut out = Vec::new();
    for e in fs::read_dir(dir(root).join("snapshots")).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".json") else { continue };
        if let Some(s) = read_snapshot(root, id) {
            out.push(SnapshotInfo { id: s.id, t: s.t, label: s.label, auto: s.auto, files: s.files.len(), size: s.files.values().map(|f| f.size).sum() });
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.t));
    out
}

/// Take a snapshot of the vault. An automatic one is skipped (None) when
/// nothing changed since the last snapshot.
pub fn create_snapshot(root: &Path, label: &str, auto: bool) -> Result<Option<SnapshotInfo>, String> {
    let files = manifest(root, true)?;
    if auto {
        if let Some(last) = list_snapshots(root).first().and_then(|s| read_snapshot(root, &s.id)) {
            if last.files == files {
                return Ok(None);
            }
        }
    }
    let t = now_ms();
    let mut id = format_id(t);
    let mut n = 1;
    while snapshot_path(root, &id).exists() {
        id = format!("{}-{n}", format_id(t));
        n += 1;
    }
    let snap = Snapshot { id: id.clone(), t, label: label.trim().to_string(), auto, files };
    write_atomic(&snapshot_path(root, &id), &serde_json::to_vec(&snap).map_err(|e| e.to_string())?)?;
    Ok(Some(SnapshotInfo { id, t, label: snap.label, auto, files: snap.files.len(), size: snap.files.values().map(|f| f.size).sum() }))
}

/// `20261109-153012` (UTC) from milliseconds.
pub fn format_id(ms: u64) -> String {
    let s = ms / 1000;
    let (days, rem) = (s / 86400, s % 86400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn delete_snapshot(root: &Path, id: &str) -> Result<(), String> {
    if read_snapshot(root, id).is_none() {
        return Err("no such snapshot".into());
    }
    fs::remove_file(snapshot_path(root, id)).map_err(|e| e.to_string())
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Change {
    pub path: String,
    /// added (since the snapshot), removed, modified
    pub status: &'static str,
}

/// How the vault now differs from snapshot `id`.
pub fn diff_snapshot(root: &Path, id: &str) -> Result<Vec<Change>, String> {
    let snap = read_snapshot(root, id).ok_or("no such snapshot")?;
    let now = manifest(root, false)?;
    let mut out = Vec::new();
    for (p, f) in &snap.files {
        match now.get(p) {
            None => out.push(Change { path: p.clone(), status: "removed" }),
            Some(n) if n.h != f.h => out.push(Change { path: p.clone(), status: "modified" }),
            _ => {}
        }
    }
    for p in now.keys().filter(|p| !snap.files.contains_key(*p)) {
        out.push(Change { path: p.clone(), status: "added" });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// A file's text in snapshot `id` (None: not in it, or not text).
pub fn snapshot_text(root: &Path, id: &str, rel: &str) -> Result<Option<String>, String> {
    let snap = read_snapshot(root, id).ok_or("no such snapshot")?;
    let Some(f) = snap.files.get(rel) else { return Ok(None) };
    Ok(String::from_utf8(get_object(root, &f.h)?).ok())
}

/// Put files back as they were in snapshot `id`: `paths` (or every file
/// that differs), removing files added since only when `remove_added`. A
/// snapshot of the current state is taken first. Returns the changed paths.
pub fn restore_snapshot(root: &Path, cfg: &Config, id: &str, paths: Option<&[String]>, remove_added: bool) -> Result<Vec<String>, String> {
    let snap = read_snapshot(root, id).ok_or("no such snapshot")?;
    let changes = diff_snapshot(root, id)?;
    let wanted = |p: &str| paths.is_none_or(|ps| ps.iter().any(|x| x == p));
    let todo: Vec<&Change> = changes.iter().filter(|c| wanted(&c.path) && (c.status != "added" || remove_added)).collect();
    if todo.is_empty() {
        return Ok(vec![]);
    }
    create_snapshot(root, &format!("Before restoring {}", snap.label.clone().if_empty(&snap.id)), true)?;
    let mut done = Vec::new();
    for c in todo {
        let path = crate::vault::resolve(root, &c.path)?;
        if c.status == "added" {
            keep(root, cfg, &c.path, "before-restore")?;
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        } else {
            let bytes = get_object(root, &snap.files[&c.path].h)?;
            if path.exists() {
                keep(root, cfg, &c.path, "before-restore")?;
            }
            if let Some(p) = path.parent() {
                fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        }
        done.push(c.path.clone());
    }
    Ok(done)
}

trait IfEmpty {
    fn if_empty(self, other: &str) -> String;
}
impl IfEmpty for String {
    fn if_empty(self, other: &str) -> String {
        if self.is_empty() { other.to_string() } else { self }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nz-hist-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn versions_merge_within_window_and_keep_forced() {
        let root = tmp("v");
        let cfg = Config::default();
        fs::write(root.join("a.md"), "one").unwrap();
        on_save(&root, &cfg, "a.md", Some(b"one"), b"two").unwrap();
        on_save(&root, &cfg, "a.md", Some(b"two"), b"three").unwrap();
        let v = list(&root, "a.md");
        // "one" (first seen) and "three" (the edit window, merged).
        assert_eq!(v.iter().map(|v| v.reason.as_str()).collect::<Vec<_>>(), ["edit", "first"]);
        assert_eq!(get_object(&root, &v[0].h).unwrap(), b"three");
        assert_eq!(get_object(&root, &v[1].h).unwrap(), b"one");
        // Changed outside the app, then saved: the outside text is kept.
        on_save(&root, &cfg, "a.md", Some(b"outside"), b"four").unwrap();
        let v = list(&root, "a.md");
        assert_eq!(v[1].reason, "outside");
        assert_eq!(v[0].reason, "edit");
        fs::write(root.join("a.md"), "four").unwrap();
        keep(&root, &cfg, "a.md", "deleted").unwrap();
        assert_eq!(list(&root, "a.md").len(), 4, "same content as the last version: not added again");
        fs::remove_file(root.join("a.md")).unwrap();
        let d = deleted(&root);
        assert_eq!(d.len(), 1);
        assert_eq!(get_object(&root, &d[0].h).unwrap(), b"four");
        assert_eq!(restore(&root, &cfg, "a.md", &v[2].h).unwrap(), "three");
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "three");
        assert!(deleted(&root).is_empty());
        rename(&root, "a.md", "b/c.md");
        assert!(list(&root, "a.md").is_empty());
        assert_eq!(list(&root, "b/c.md")[0].reason, "restored");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn pruning_and_cleanup() {
        let root = tmp("p");
        let cfg = Config { max_versions: 2, ..Config::default() };
        for t in ["a", "b", "c", "d"] {
            record(&root, &cfg, "n.md", t.as_bytes(), "deleted").unwrap();
        }
        assert_eq!(list(&root, "n.md").len(), 2);
        let removed = cleanup(&root, &cfg).unwrap();
        assert_eq!(removed, 2, "objects of dropped versions are removed");
        assert!(get_object(&root, &hash(b"d")).is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshots_diff_and_restore() {
        let root = tmp("s");
        let cfg = Config::default();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("a.md"), "alpha").unwrap();
        fs::write(root.join("sub/b.md"), "beta").unwrap();
        fs::write(root.join("pic.png"), [0u8, 159, 146, 150]).unwrap();
        let s = create_snapshot(&root, "first", false).unwrap().unwrap();
        assert_eq!(s.files, 3);
        assert!(create_snapshot(&root, "", true).unwrap().is_none(), "nothing changed");
        fs::write(root.join("a.md"), "ALPHA").unwrap();
        fs::remove_file(root.join("sub/b.md")).unwrap();
        fs::write(root.join("new.md"), "new").unwrap();
        let d = diff_snapshot(&root, &s.id).unwrap();
        assert_eq!(
            d,
            vec![
                Change { path: "a.md".into(), status: "modified" },
                Change { path: "new.md".into(), status: "added" },
                Change { path: "sub/b.md".into(), status: "removed" },
            ]
        );
        assert_eq!(snapshot_text(&root, &s.id, "a.md").unwrap().as_deref(), Some("alpha"));
        assert_eq!(snapshot_text(&root, &s.id, "pic.png").unwrap(), None);
        let done = restore_snapshot(&root, &cfg, &s.id, Some(&["a.md".to_string()]), false).unwrap();
        assert_eq!(done, ["a.md"]);
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "alpha");
        assert_eq!(list(&root, "a.md")[0].reason, "before-restore");
        let done = restore_snapshot(&root, &cfg, &s.id, None, true).unwrap();
        assert_eq!(done, ["new.md", "sub/b.md"]);
        assert!(!root.join("new.md").exists());
        assert_eq!(fs::read_to_string(root.join("sub/b.md")).unwrap(), "beta");
        assert_eq!(list_snapshots(&root).len(), 3, "two automatic 'before restoring' snapshots");
        assert!(format_id(0) == "19700101-000000" && format_id(1_762_700_000_000) == "20251109-145320");
        let _ = fs::remove_dir_all(&root);
    }
}
