//! End-to-end encrypted sync of a vault through a folder, a WebDAV server or
//! S3-compatible storage.
//!
//! The remote holds, under its prefix:
//! - `notez-sync.json`: the key-derivation salt and a check value (no secrets);
//! - `objects/<id>`: file contents, compressed and encrypted
//!   (XChaCha20-Poly1305); `<id>` is a keyed hash, so equal files are stored
//!   once and names reveal nothing;
//! - `head`: the encrypted list of files (path → content hash) after the last sync.
//!
//! The key comes from the passphrase (Argon2id) and never leaves the device.
//! Sync is a three-way merge of this vault, the remote head and the state
//! both had at this device's last sync: changes on either side are applied;
//! when both sides changed a file, the local one stays and the other is
//! saved next to it as `name (conflict <date>).ext`.
use crate::history::{self, deflate, inflate, now_ms, write_atomic, FileEntry};
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Remote {
    /// folder, webdav, s3
    pub kind: String,
    /// folder: a path; webdav: the URL of a folder; s3: the endpoint URL.
    pub url: String,
    pub user: String,
    pub password: String,
    pub bucket: String,
    pub region: String,
    /// Folder inside the storage (s3, webdav) for this vault.
    pub prefix: String,
}

// ------------------------------------------------------------- storage

pub trait Store {
    /// File names directly inside `dir` (e.g. "objects").
    fn list(&self, dir: &str) -> Result<Vec<String>, String>;
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String>;
    fn put(&self, key: &str, bytes: &[u8]) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

pub struct FolderStore(pub PathBuf);

impl Store for FolderStore {
    fn list(&self, dir: &str) -> Result<Vec<String>, String> {
        match fs::read_dir(self.0.join(dir)) {
            Ok(rd) => Ok(rd.flatten().filter(|e| e.path().is_file()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| !n.contains(".tmp")).collect()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(e.to_string()),
        }
    }
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        match fs::read(self.0.join(key)) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn put(&self, key: &str, bytes: &[u8]) -> Result<(), String> {
        write_atomic(&self.0.join(key), bytes)
    }
    fn delete(&self, key: &str) -> Result<(), String> {
        match fs::remove_file(self.0.join(key)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(std::time::Duration::from_secs(20)).timeout(std::time::Duration::from_secs(300)).build()
}

fn http_err(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, r) => {
            let body = r.into_string().unwrap_or_default();
            let msg = regex::Regex::new(r"<Message>([^<]*)</Message>").ok().and_then(|re| re.captures(&body).map(|c| c[1].to_string()));
            match code {
                401 | 403 => format!("access denied ({code}){}: check the user name and password or keys", msg.map(|m| format!(": {m}")).unwrap_or_default()),
                _ => format!("server error {code}{}", msg.map(|m| format!(": {m}")).unwrap_or_default()),
            }
        }
        ureq::Error::Transport(t) => format!("cannot reach the server: {t}"),
    }
}

/// Percent-encode everything but unreserved characters (and `/` when `slash`).
fn uri_encode(s: &str, slash: bool) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) || (slash && b == b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub struct WebDav {
    base: String,
    auth: Option<String>,
    agent: ureq::Agent,
    made: Mutex<HashSet<String>>,
}

impl WebDav {
    pub fn new(url: &str, user: &str, password: &str, prefix: &str) -> Self {
        let mut base = url.trim().trim_end_matches('/').to_string();
        for part in prefix.split('/').filter(|p| !p.is_empty()) {
            base.push('/');
            base.push_str(&uri_encode(part, false));
        }
        base.push('/');
        let auth = (!user.is_empty()).then(|| format!("Basic {}", B64.encode(format!("{user}:{password}"))));
        WebDav { base, auth, agent: agent(), made: Mutex::new(HashSet::new()) }
    }
    fn req(&self, method: &str, key: &str) -> ureq::Request {
        let r = self.agent.request(method, &format!("{}{}", self.base, uri_encode(key, true)));
        match &self.auth {
            Some(a) => r.set("Authorization", a),
            None => r,
        }
    }
    /// Create the folders on the way to `key` (MKCOL; existing ones are fine).
    fn mkdirs(&self, key: &str) -> Result<(), String> {
        let mut dirs = vec![String::new()];
        let parts: Vec<&str> = key.split('/').collect();
        for i in 1..parts.len() {
            dirs.push(format!("{}/", parts[..i].join("/")));
        }
        for d in dirs {
            if self.made.lock().unwrap().contains(&d) {
                continue;
            }
            match self.req("MKCOL", &d).call() {
                Ok(_) | Err(ureq::Error::Status(405 | 301 | 302, _)) => {}
                Err(e) => return Err(http_err(e)),
            }
            self.made.lock().unwrap().insert(d);
        }
        Ok(())
    }
}

impl Store for WebDav {
    fn list(&self, dir: &str) -> Result<Vec<String>, String> {
        let key = format!("{}/", dir.trim_end_matches('/'));
        let r = self.req("PROPFIND", &key).set("Depth", "1").set("Content-Type", "application/xml").send_string(
            r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"#,
        );
        let body = match r {
            Ok(r) => r.into_string().map_err(|e| e.to_string())?,
            Err(ureq::Error::Status(404, _)) => return Ok(vec![]),
            Err(e) => return Err(http_err(e)),
        };
        // Each <response>: its href, and whether it is a collection.
        let resp = regex::Regex::new(r"(?s)<(?:[A-Za-z0-9]+:)?response\b.*?</(?:[A-Za-z0-9]+:)?response>").unwrap();
        let href = regex::Regex::new(r"(?s)<(?:[A-Za-z0-9]+:)?href>\s*([^<]*?)\s*</").unwrap();
        let mut out = Vec::new();
        for m in resp.find_iter(&body) {
            let block = m.as_str();
            if block.contains("collection") {
                continue;
            }
            if let Some(c) = href.captures(block) {
                let h = crate::render::percent_decode(&c[1].replace("&amp;", "&"));
                if let Some(name) = h.trim_end_matches('/').rsplit('/').next() {
                    if !name.is_empty() {
                        out.push(name.to_string());
                    }
                }
            }
        }
        Ok(out)
    }
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        match self.req("GET", key).call() {
            Ok(r) => {
                let mut b = Vec::new();
                std::io::Read::read_to_end(&mut r.into_reader(), &mut b).map_err(|e| e.to_string())?;
                Ok(Some(b))
            }
            Err(ureq::Error::Status(404, _)) => Ok(None),
            Err(e) => Err(http_err(e)),
        }
    }
    fn put(&self, key: &str, bytes: &[u8]) -> Result<(), String> {
        match self.req("PUT", key).send_bytes(bytes) {
            Ok(_) => Ok(()),
            Err(ureq::Error::Status(409 | 404, _)) => {
                self.mkdirs(key)?;
                self.req("PUT", key).send_bytes(bytes).map(|_| ()).map_err(http_err)
            }
            Err(e) => Err(http_err(e)),
        }
    }
    fn delete(&self, key: &str) -> Result<(), String> {
        match self.req("DELETE", key).call() {
            Ok(_) | Err(ureq::Error::Status(404, _)) => Ok(()),
            Err(e) => Err(http_err(e)),
        }
    }
}

type HmacSha256 = Hmac<Sha256>;

fn hmac(key: &[u8], msg: &str) -> Vec<u8> {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("any key length");
    m.update(msg.as_bytes());
    m.finalize().into_bytes().to_vec()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// AWS Signature Version 4: the `Authorization` header for a request.
/// `headers` are (lower-case name, value) and must include `host` and `x-amz-date`.
#[allow(clippy::too_many_arguments)]
pub fn sigv4(
    method: &str,
    uri: &str,
    query: &[(String, String)],
    headers: &[(String, String)],
    payload_hash: &str,
    region: &str,
    service: &str,
    access: &str,
    secret: &str,
    amz_date: &str,
) -> String {
    let mut q: Vec<(String, String)> = query.iter().map(|(k, v)| (uri_encode(k, false), uri_encode(v, false))).collect();
    q.sort();
    let canonical_query = q.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
    let mut h: Vec<(String, String)> = headers.iter().map(|(k, v)| (k.to_lowercase(), v.trim().to_string())).collect();
    h.sort();
    let canonical_headers: String = h.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed = h.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");
    let request = format!("{method}\n{uri}\n{canonical_query}\n{canonical_headers}\n{signed}\n{payload_hash}");
    let date = &amz_date[..8];
    let scope = format!("{date}/{region}/{service}/aws4_request");
    let to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", hex(&Sha256::digest(request.as_bytes())));
    let k = hmac(format!("AWS4{secret}").as_bytes(), date);
    let k = hmac(&k, region);
    let k = hmac(&k, service);
    let k = hmac(&k, "aws4_request");
    let sig = hex(&hmac(&k, &to_sign));
    format!("AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders={signed}, Signature={sig}")
}

/// `20150830T123600Z` for now (UTC).
fn amz_now() -> String {
    let id = history::format_id(now_ms()); // 20150830-123600
    format!("{}T{}Z", &id[..8], &id[9..15])
}

pub struct S3 {
    endpoint: String,
    host: String,
    bucket: String,
    region: String,
    access: String,
    secret: String,
    prefix: String,
    agent: ureq::Agent,
}

impl S3 {
    pub fn new(r: &Remote) -> Result<Self, String> {
        let endpoint = r.url.trim().trim_end_matches('/').to_string();
        let host = endpoint.split("://").nth(1).ok_or("the endpoint must start with https://")?.split('/').next().unwrap_or("").to_string();
        if host.is_empty() || r.bucket.trim().is_empty() {
            return Err("S3 needs an endpoint and a bucket".into());
        }
        let prefix = r.prefix.trim().trim_matches('/').to_string();
        Ok(S3 {
            endpoint,
            host,
            bucket: r.bucket.trim().to_string(),
            region: if r.region.trim().is_empty() { "us-east-1".into() } else { r.region.trim().to_string() },
            access: r.user.trim().to_string(),
            secret: r.password.trim().to_string(),
            prefix: if prefix.is_empty() { prefix } else { format!("{prefix}/") },
            agent: agent(),
        })
    }
    fn send(&self, method: &str, key: Option<&str>, query: &[(String, String)], body: &[u8]) -> Result<ureq::Response, ureq::Error> {
        let uri = match key {
            Some(k) => format!("/{}/{}", uri_encode(&self.bucket, false), uri_encode(&format!("{}{k}", self.prefix), true)),
            None => format!("/{}", uri_encode(&self.bucket, false)),
        };
        let date = amz_now();
        let payload = hex(&Sha256::digest(body));
        let headers = vec![("host".to_string(), self.host.clone()), ("x-amz-content-sha256".to_string(), payload.clone()), ("x-amz-date".to_string(), date.clone())];
        let auth = sigv4(method, &uri, query, &headers, &payload, &self.region, "s3", &self.access, &self.secret, &date);
        let mut url = format!("{}{uri}", self.endpoint);
        if !query.is_empty() {
            let q: Vec<String> = query.iter().map(|(k, v)| format!("{}={}", uri_encode(k, false), uri_encode(v, false))).collect();
            url = format!("{url}?{}", q.join("&"));
        }
        self.agent
            .request(method, &url)
            .set("x-amz-content-sha256", &payload)
            .set("x-amz-date", &date)
            .set("Authorization", &auth)
            .send_bytes(body)
    }
}

impl Store for S3 {
    fn list(&self, dir: &str) -> Result<Vec<String>, String> {
        let prefix = format!("{}{}/", self.prefix, dir.trim_end_matches('/'));
        let key_re = regex::Regex::new(r"<Key>([^<]*)</Key>").unwrap();
        let token_re = regex::Regex::new(r"<NextContinuationToken>([^<]*)</NextContinuationToken>").unwrap();
        let mut out = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut q = vec![("list-type".to_string(), "2".to_string()), ("prefix".to_string(), prefix.clone())];
            if let Some(t) = &token {
                q.push(("continuation-token".to_string(), t.clone()));
            }
            let body = self.send("GET", None, &q, b"").map_err(http_err)?.into_string().map_err(|e| e.to_string())?;
            for c in key_re.captures_iter(&body) {
                let k = c[1].replace("&amp;", "&");
                if let Some(name) = k.strip_prefix(&prefix) {
                    if !name.contains('/') && !name.is_empty() {
                        out.push(name.to_string());
                    }
                }
            }
            match token_re.captures(&body) {
                Some(c) if body.contains("<IsTruncated>true</IsTruncated>") => token = Some(c[1].replace("&amp;", "&")),
                _ => break,
            }
        }
        Ok(out)
    }
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        match self.send("GET", Some(key), &[], b"") {
            Ok(r) => {
                let mut b = Vec::new();
                std::io::Read::read_to_end(&mut r.into_reader(), &mut b).map_err(|e| e.to_string())?;
                Ok(Some(b))
            }
            Err(ureq::Error::Status(404, _)) => Ok(None),
            Err(e) => Err(http_err(e)),
        }
    }
    fn put(&self, key: &str, bytes: &[u8]) -> Result<(), String> {
        self.send("PUT", Some(key), &[], bytes).map(|_| ()).map_err(http_err)
    }
    fn delete(&self, key: &str) -> Result<(), String> {
        match self.send("DELETE", Some(key), &[], b"") {
            Ok(_) | Err(ureq::Error::Status(404, _)) => Ok(()),
            Err(e) => Err(http_err(e)),
        }
    }
}

pub fn open_store(r: &Remote) -> Result<Box<dyn Store>, String> {
    match r.kind.as_str() {
        "folder" => {
            let p = PathBuf::from(r.url.trim());
            if r.url.trim().is_empty() || !p.is_absolute() {
                return Err("choose a folder to sync with".into());
            }
            let p = if r.prefix.trim().is_empty() { p } else { p.join(r.prefix.trim().trim_matches('/')) };
            Ok(Box::new(FolderStore(p)))
        }
        "webdav" => {
            if !r.url.starts_with("http://") && !r.url.starts_with("https://") {
                return Err("the WebDAV address must start with https://".into());
            }
            Ok(Box::new(WebDav::new(&r.url, &r.user, &r.password, &r.prefix)))
        }
        "s3" => Ok(Box::new(S3::new(r)?)),
        _ => Err("sync is not set up".into()),
    }
}

// ---------------------------------------------------------------- keys

#[derive(Deserialize, Serialize)]
struct RemoteConfig {
    format: u32,
    salt: String,
    m: u32,
    t: u32,
    p: u32,
    /// `seal("notez")`: tells a wrong passphrase apart from damaged data.
    check: String,
}

#[derive(Clone)]
pub struct Keys {
    enc: [u8; 32],
    ids: [u8; 32],
}

fn derive(pass: &str, salt: &[u8], m: u32, t: u32, p: u32) -> Result<Keys, String> {
    let params = argon2::Params::new(m, t, p, Some(32)).map_err(|e| e.to_string())?;
    let a = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut master = [0u8; 32];
    a.hash_password_into(pass.as_bytes(), salt, &mut master).map_err(|e| e.to_string())?;
    Ok(Keys { enc: blake3::derive_key("notez sync v1 encryption", &master), ids: blake3::derive_key("notez sync v1 object ids", &master) })
}

pub fn seal(k: &Keys, plain: &[u8]) -> Vec<u8> {
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut nonce).expect("system random numbers");
    let c = XChaCha20Poly1305::new((&k.enc).into());
    let mut out = nonce.to_vec();
    out.extend(c.encrypt(XNonce::from_slice(&nonce), plain).expect("encryption"));
    out
}

pub fn unseal(k: &Keys, data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 24 + 16 {
        return Err("damaged sync data".into());
    }
    let c = XChaCha20Poly1305::new((&k.enc).into());
    c.decrypt(XNonce::from_slice(&data[..24]), &data[24..]).map_err(|_| "cannot decrypt sync data (wrong passphrase, or damaged)".to_string())
}

fn object_id(k: &Keys, h: &str) -> String {
    blake3::keyed_hash(&k.ids, h.as_bytes()).to_hex()[..40].to_string()
}

/// Derived keys of recent passphrases (deriving takes a moment).
static KEYS: Mutex<Vec<(String, Keys)>> = Mutex::new(Vec::new());

/// The keys for this remote: from its config, or a new config when the
/// remote is empty. A wrong passphrase is an error.
fn keys_for(store: &dyn Store, pass: &str) -> Result<(Keys, String), String> {
    if pass.is_empty() {
        return Err("enter the sync passphrase".into());
    }
    let cfg: RemoteConfig = match store.get("notez-sync.json")? {
        Some(b) => serde_json::from_slice(&b).map_err(|_| "the remote has a damaged notez-sync.json".to_string())?,
        None => {
            if !store.list("objects")?.is_empty() {
                return Err("the remote has sync data but no notez-sync.json".into());
            }
            let mut salt = [0u8; 16];
            getrandom::fill(&mut salt).map_err(|e| e.to_string())?;
            let (m, t, p) = (64 * 1024, 3, 1);
            let k = derive(pass, &salt, m, t, p)?;
            let cfg = RemoteConfig { format: 1, salt: B64.encode(salt), m, t, p, check: B64.encode(seal(&k, b"notez")) };
            store.put("notez-sync.json", &serde_json::to_vec_pretty(&cfg).map_err(|e| e.to_string())?)?;
            return Ok((k, cfg.salt));
        }
    };
    if cfg.format != 1 {
        return Err("the remote was made by a newer NoteZ".into());
    }
    let cache_key = format!("{}\u{0}{}", cfg.salt, blake3::hash(pass.as_bytes()).to_hex());
    if let Some((_, k)) = KEYS.lock().unwrap().iter().find(|(c, _)| *c == cache_key) {
        return Ok((k.clone(), cfg.salt));
    }
    let salt = B64.decode(&cfg.salt).map_err(|_| "damaged notez-sync.json")?;
    let k = derive(pass, &salt, cfg.m, cfg.t, cfg.p)?;
    let check = B64.decode(&cfg.check).map_err(|_| "damaged notez-sync.json")?;
    match unseal(&k, &check) {
        Ok(v) if v == b"notez" => {}
        _ => return Err("wrong passphrase for this sync location".into()),
    }
    let mut cache = KEYS.lock().unwrap();
    cache.retain(|(c, _)| !c.starts_with(&cfg.salt));
    cache.push((cache_key, k.clone()));
    Ok((k, cfg.salt))
}

// ---------------------------------------------------------------- sync

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
struct RemoteFile {
    h: String,
    id: String,
    size: u64,
}

#[derive(Default, Deserialize, Serialize)]
struct Head {
    generation: u64,
    t: u64,
    device: String,
    files: BTreeMap<String, RemoteFile>,
}

#[derive(Default, Deserialize, Serialize)]
struct LocalState {
    /// Which remote (its salt) `base` belongs to.
    remote: String,
    device: String,
    /// path → hash as of the last sync.
    base: BTreeMap<String, String>,
    last: u64,
}

fn state_path(root: &Path) -> PathBuf {
    root.join(".notez/sync/state.json")
}

#[derive(Serialize, Debug, Default)]
pub struct Report {
    pub uploaded: Vec<String>,
    pub downloaded: Vec<String>,
    pub deleted_here: Vec<String>,
    pub deleted_there: Vec<String>,
    /// Conflict copies written here (path of the copy).
    pub conflicts: Vec<String>,
    /// Local paths whose content changed (for the UI to reload).
    pub changed: Vec<String>,
    pub t: u64,
    pub millis: u64,
}

fn conflict_name(path: &str, t: u64, taken: &dyn Fn(&str) -> bool) -> String {
    let id = history::format_id(t);
    let date = format!("{}-{}-{} {}{}", &id[..4], &id[4..6], &id[6..8], &id[9..11], &id[11..13]);
    let (dir, name) = path.rsplit_once('/').map(|(d, n)| (format!("{d}/"), n)).unwrap_or((String::new(), path));
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    let mut n = 1;
    loop {
        let c = if n == 1 { format!("{dir}{stem} (conflict {date}){ext}") } else { format!("{dir}{stem} (conflict {date} {n}){ext}") };
        if !taken(&c) {
            return c;
        }
        n += 1;
    }
}

/// A remote path that is safe to write here.
fn safe(root: &Path, rel: &str) -> bool {
    !rel.is_empty()
        && !rel.starts_with('/')
        && !rel.contains('\\')
        && !rel.split('/').any(|p| p.is_empty() || p == "." || p == "..")
        && !(rel.starts_with(".notez/history/") || rel.starts_with(".notez/sync/") || rel.starts_with(".git/"))
        && crate::vault::resolve(root, rel).is_ok()
}

/// Sync the vault at `root` with `store`. Local files that sync overwrites
/// or removes are kept in history first.
pub fn sync(root: &Path, store: &dyn Store, pass: &str, cfg: &history::Config) -> Result<Report, String> {
    let started = now_ms();
    let (keys, salt) = keys_for(store, pass)?;
    let mut st: LocalState = fs::read(state_path(root)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    if st.device.is_empty() {
        let mut d = [0u8; 8];
        getrandom::fill(&mut d).map_err(|e| e.to_string())?;
        st.device = hex(&d);
    }
    if st.remote != salt {
        // Another sync location: nothing is known to be in common.
        st.remote = salt.clone();
        st.base.clear();
    }
    let head: Head = match store.get("head")? {
        Some(b) => serde_json::from_slice(&inflate(&unseal(&keys, &b)?)?).map_err(|_| "damaged remote file list".to_string())?,
        None => Head::default(),
    };
    let local = history::manifest(root, false)?;
    let mut remote_objects: HashSet<String> = store.list("objects")?.into_iter().collect();
    let mut report = Report::default();
    let mut result: BTreeMap<String, RemoteFile> = BTreeMap::new();

    let upload = |path: &str, objs: &mut HashSet<String>| -> Result<Option<RemoteFile>, String> {
        let bytes = match fs::read(root.join(path)) {
            Ok(b) => b,
            Err(_) => return Ok(None), // gone meanwhile
        };
        let h = history::hash(&bytes);
        let id = object_id(&keys, &h);
        if !objs.contains(&id) {
            store.put(&format!("objects/{id}"), &seal(&keys, &deflate(&bytes)))?;
            objs.insert(id.clone());
        }
        Ok(Some(RemoteFile { h, id, size: bytes.len() as u64 }))
    };
    let download = |f: &RemoteFile| -> Result<Vec<u8>, String> {
        let data = store.get(&format!("objects/{}", f.id))?.ok_or("a file is missing on the remote; sync from the device that has it")?;
        let bytes = inflate(&unseal(&keys, &data)?)?;
        if history::hash(&bytes) != f.h {
            return Err("a remote file is damaged".into());
        }
        Ok(bytes)
    };
    let write_here = |rel: &str, bytes: &[u8]| -> Result<(), String> {
        let p = crate::vault::resolve(root, rel)?;
        if p.exists() {
            history::keep(root, cfg, rel, "before-sync")?;
        }
        write_atomic(&p, bytes)
    };

    let paths: BTreeSet<String> = local.keys().chain(head.files.keys()).chain(st.base.keys()).cloned().collect();
    let mut taken: HashSet<String> = paths.clone().into_iter().collect();
    for path in paths {
        let l: Option<&FileEntry> = local.get(&path);
        let r: Option<&RemoteFile> = head.files.get(&path).filter(|_| safe(root, &path));
        let b: Option<&String> = st.base.get(&path);
        let (lh, rh) = (l.map(|f| &f.h), r.map(|f| &f.h));
        if lh == rh {
            if let Some(r) = r {
                result.insert(path.clone(), r.clone());
            }
            continue;
        }
        if lh == b {
            // Changed (or removed) only on the remote.
            match r {
                Some(r) => {
                    write_here(&path, &download(r)?)?;
                    report.downloaded.push(path.clone());
                    report.changed.push(path.clone());
                    result.insert(path.clone(), r.clone());
                }
                None => {
                    history::keep(root, cfg, &path, "before-sync")?;
                    let _ = fs::remove_file(root.join(&path));
                    report.deleted_here.push(path.clone());
                    report.changed.push(path.clone());
                }
            }
        } else if rh == b {
            // Changed (or removed) only here.
            match l {
                Some(_) => {
                    if let Some(f) = upload(&path, &mut remote_objects)? {
                        report.uploaded.push(path.clone());
                        result.insert(path.clone(), f);
                    }
                }
                None => report.deleted_there.push(path.clone()),
            }
        } else {
            // Changed on both sides.
            match (l, r) {
                (Some(_), Some(r)) => {
                    let copy = conflict_name(&path, started, &|c| taken.contains(c) || root.join(c).exists());
                    taken.insert(copy.clone());
                    write_here(&copy, &download(r)?)?;
                    result.insert(copy.clone(), r.clone());
                    report.conflicts.push(copy.clone());
                    report.changed.push(copy);
                    if let Some(f) = upload(&path, &mut remote_objects)? {
                        report.uploaded.push(path.clone());
                        result.insert(path.clone(), f);
                    }
                }
                (Some(_), None) => {
                    // Removed there, edited here: keep the edit.
                    if let Some(f) = upload(&path, &mut remote_objects)? {
                        report.uploaded.push(path.clone());
                        result.insert(path.clone(), f);
                    }
                }
                (None, Some(r)) => {
                    // Removed here, edited there: keep the edit.
                    write_here(&path, &download(r)?)?;
                    report.downloaded.push(path.clone());
                    report.changed.push(path.clone());
                    result.insert(path.clone(), r.clone());
                }
                (None, None) => {}
            }
        }
    }

    // Publish the new file list unless nothing changed there.
    if result != head.files || head.generation == 0 {
        let generation = head.generation + 1;
        let new_head = Head { generation, t: now_ms(), device: st.device.clone(), files: result.clone() };
        let sealed = seal(&keys, &deflate(&serde_json::to_vec(&new_head).map_err(|e| e.to_string())?));
        // Someone else synced since we read the head: start over (their
        // changes would be lost otherwise).
        if let Some(b) = store.get("head")? {
            let now: Head = serde_json::from_slice(&inflate(&unseal(&keys, &b)?)?).map_err(|_| "damaged remote file list".to_string())?;
            if now.generation != head.generation {
                return Err("RETRY".into());
            }
        }
        store.put("head", &sealed)?;
    }
    st.base = result.into_iter().map(|(p, f)| (p, f.h)).collect();
    st.last = now_ms();
    write_atomic(&state_path(root), &serde_json::to_vec(&st).map_err(|e| e.to_string())?)?;
    report.t = st.last;
    report.millis = st.last.saturating_sub(started);
    Ok(report)
}

/// Sync, starting over once if another device synced at the same moment.
pub fn run(root: &Path, remote: &Remote, pass: &str, cfg: &history::Config) -> Result<Report, String> {
    let store = open_store(remote)?;
    for _ in 0..3 {
        match sync(root, store.as_ref(), pass, cfg) {
            Err(e) if e == "RETRY" => continue,
            r => return r,
        }
    }
    Err("another device keeps syncing at the same time; try again in a moment".into())
}

#[derive(Serialize)]
pub struct Status {
    pub last: u64,
    pub files: usize,
}

/// When this vault last synced (0: never).
pub fn status(root: &Path) -> Status {
    let st: LocalState = fs::read(state_path(root)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    Status { last: st.last, files: st.base.len() }
}

/// Remove remote objects no file list refers to. Run it when no other
/// device is syncing. Returns how many were removed.
pub fn cleanup(remote: &Remote, pass: &str) -> Result<usize, String> {
    let store = open_store(remote)?;
    let (keys, _) = keys_for(store.as_ref(), pass)?;
    let head: Head = match store.get("head")? {
        Some(b) => serde_json::from_slice(&inflate(&unseal(&keys, &b)?)?).map_err(|_| "damaged remote file list".to_string())?,
        None => return Ok(0),
    };
    let live: HashSet<&str> = head.files.values().map(|f| f.id.as_str()).collect();
    let mut n = 0;
    for o in store.list("objects")? {
        if !live.contains(o.as_str()) {
            store.delete(&format!("objects/{o}"))?;
            n += 1;
        }
    }
    Ok(n)
}

/// Check the settings and passphrase without syncing.
pub fn test(remote: &Remote, pass: &str) -> Result<(), String> {
    let store = open_store(remote)?;
    keys_for(store.as_ref(), pass).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nz-sync-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn put(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    fn read(root: &Path, rel: &str) -> Option<String> {
        fs::read_to_string(root.join(rel)).ok()
    }

    fn run_folder(a: &Path, remote: &Path, pass: &str) -> Result<Report, String> {
        let r = Remote { kind: "folder".into(), url: remote.to_string_lossy().into(), ..Default::default() };
        run(a, &r, pass, &history::Config::default())
    }

    #[test]
    fn sigv4_matches_aws_test_suite() {
        // aws-sig-v4-test-suite "get-vanilla".
        let auth = sigv4(
            "GET",
            "/",
            &[],
            &[("host".into(), "example.amazonaws.com".into()), ("x-amz-date".into(), "20150830T123600Z".into())],
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "us-east-1",
            "service",
            "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "20150830T123600Z",
        );
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
    }

    #[test]
    fn encrypts_and_rejects_wrong_passphrase() {
        let remote = tmp("enc-remote");
        let a = tmp("enc-a");
        put(&a, "secret.md", "the launch code is 1234");
        run_folder(&a, &remote, "correct horse").unwrap();
        // Nothing readable on the remote.
        for f in crate::vault::every_file(&remote, &remote) {
            let b = fs::read(remote.join(&f)).unwrap();
            assert!(!String::from_utf8_lossy(&b).contains("launch code"), "{f} leaks");
            assert!(!f.contains("secret"), "{f} leaks a name");
        }
        let b = tmp("enc-b");
        let e = run_folder(&b, &remote, "wrong").unwrap_err();
        assert!(e.contains("wrong passphrase"), "{e}");
        run_folder(&b, &remote, "correct horse").unwrap();
        assert_eq!(read(&b, "secret.md").as_deref(), Some("the launch code is 1234"));
        for d in [remote, a, b] {
            let _ = fs::remove_dir_all(d);
        }
    }

    #[test]
    fn two_devices_merge_and_conflict() {
        let remote = tmp("m-remote");
        let a = tmp("m-a");
        let b = tmp("m-b");
        put(&a, "one.md", "1");
        put(&a, "sub/two.md", "2");
        put(&a, "pic.png", "PNG");
        put(&a, ".notez/history/x", "not synced");
        let r = run_folder(&a, &remote, "pw").unwrap();
        assert_eq!(r.uploaded.len(), 3);
        let r = run_folder(&b, &remote, "pw").unwrap();
        assert_eq!(r.downloaded.len(), 3);
        assert_eq!(read(&b, "sub/two.md").as_deref(), Some("2"));
        assert_eq!(read(&b, ".notez/history/x"), None);

        // Edits on both sides, in different files; a delete; a new file.
        put(&a, "one.md", "1a");
        fs::remove_file(a.join("pic.png")).unwrap();
        put(&b, "sub/two.md", "2b");
        put(&b, "three.md", "3");
        run_folder(&a, &remote, "pw").unwrap();
        let r = run_folder(&b, &remote, "pw").unwrap();
        assert_eq!(read(&b, "one.md").as_deref(), Some("1a"));
        assert!(!b.join("pic.png").exists());
        assert!(r.deleted_here.contains(&"pic.png".to_string()));
        // b's history kept what sync replaced.
        assert_eq!(history::list(&b, "one.md")[0].reason, "before-sync");
        run_folder(&a, &remote, "pw").unwrap();
        assert_eq!(read(&a, "sub/two.md").as_deref(), Some("2b"));
        assert_eq!(read(&a, "three.md").as_deref(), Some("3"));

        // The same file changed on both: local stays, the other is a copy.
        put(&a, "one.md", "from a");
        put(&b, "one.md", "from b");
        run_folder(&a, &remote, "pw").unwrap();
        let r = run_folder(&b, &remote, "pw").unwrap();
        assert_eq!(r.conflicts.len(), 1, "{r:?}");
        assert_eq!(read(&b, "one.md").as_deref(), Some("from b"));
        assert_eq!(read(&b, &r.conflicts[0]).as_deref(), Some("from a"));
        assert!(r.conflicts[0].starts_with("one (conflict "), "{}", r.conflicts[0]);
        run_folder(&a, &remote, "pw").unwrap();
        assert_eq!(read(&a, "one.md").as_deref(), Some("from b"));
        assert_eq!(read(&a, &r.conflicts[0]).as_deref(), Some("from a"));

        // Removed on one side, edited on the other: the edit wins.
        fs::remove_file(a.join("three.md")).unwrap();
        put(&b, "three.md", "3 edited");
        run_folder(&a, &remote, "pw").unwrap();
        run_folder(&b, &remote, "pw").unwrap();
        run_folder(&a, &remote, "pw").unwrap();
        assert_eq!(read(&a, "three.md").as_deref(), Some("3 edited"));

        // Nothing to do: nothing changes.
        let r = run_folder(&a, &remote, "pw").unwrap();
        assert!(r.uploaded.is_empty() && r.downloaded.is_empty() && r.changed.is_empty());
        // Unreferenced objects can be cleaned up.
        let removed = cleanup(&Remote { kind: "folder".into(), url: remote.to_string_lossy().into(), ..Default::default() }, "pw").unwrap();
        assert!(removed >= 1);
        let b2 = tmp("m-b2");
        run_folder(&b2, &remote, "pw").unwrap();
        assert_eq!(read(&b2, "one.md").as_deref(), Some("from b"));
        for d in [remote, a, b, b2] {
            let _ = fs::remove_dir_all(d);
        }
    }

    #[test]
    fn rejects_unsafe_remote_paths() {
        let root = Path::new("/vault");
        assert!(safe(root, "a/b.md"));
        for p in ["../x", "/etc/passwd", "a/../../x", "a//b", ".notez/history/x", ""] {
            assert!(!safe(root, p), "{p}");
        }
    }

    /// A tiny WebDAV server (PUT/GET/DELETE/MKCOL/PROPFIND) for the tests.
    fn dav_server() -> (String, std::sync::Arc<Mutex<BTreeMap<String, Vec<u8>>>>) {
        use std::io::{BufRead, BufReader, Read as _, Write as _};
        let files = std::sync::Arc::new(Mutex::new(BTreeMap::<String, Vec<u8>>::new()));
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://{}", l.local_addr().unwrap());
        let fs2 = files.clone();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let files = fs2.clone();
                std::thread::spawn(move || {
                    let mut r = BufReader::new(s.try_clone().unwrap());
                    let mut s = s;
                    loop {
                        let mut line = String::new();
                        if r.read_line(&mut line).unwrap_or(0) == 0 {
                            return;
                        }
                        let mut parts = line.split_whitespace();
                        let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
                        let mut len = 0usize;
                        let mut auth = false;
                        loop {
                            let mut h = String::new();
                            r.read_line(&mut h).unwrap();
                            if h.trim().is_empty() {
                                break;
                            }
                            let lower = h.to_lowercase();
                            if let Some(v) = lower.strip_prefix("content-length:") {
                                len = v.trim().parse().unwrap_or(0);
                            }
                            if lower.starts_with("authorization: basic") {
                                auth = true;
                            }
                        }
                        let mut body = vec![0; len];
                        r.read_exact(&mut body).unwrap();
                        let path = crate::render::percent_decode(&path);
                        let mut f = files.lock().unwrap();
                        let (code, out): (u16, Vec<u8>) = if !auth {
                            (401, vec![])
                        } else {
                            match method.as_str() {
                                "PUT" => {
                                    let parent = path.rsplit_once('/').map(|(d, _)| format!("{d}/")).unwrap_or_default();
                                    if parent != "/dav/" && !f.contains_key(&parent) {
                                        (409, vec![])
                                    } else {
                                        f.insert(path, body);
                                        (201, vec![])
                                    }
                                }
                                "MKCOL" => {
                                    if f.contains_key(&path) {
                                        (405, vec![])
                                    } else {
                                        f.insert(path, vec![]);
                                        (201, vec![])
                                    }
                                }
                                "GET" => match f.get(&path) {
                                    Some(b) => (200, b.clone()),
                                    None => (404, vec![]),
                                },
                                "DELETE" => (if f.remove(&path).is_some() { 204 } else { 404 }, vec![]),
                                "PROPFIND" => {
                                    if !f.contains_key(&path) {
                                        (404, vec![])
                                    } else {
                                        let mut x = String::from("<?xml version=\"1.0\"?><D:multistatus xmlns:D=\"DAV:\">");
                                        x.push_str(&format!("<D:response><D:href>{path}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>"));
                                        for k in f.keys().filter(|k| k.starts_with(&path) && *k != &path && !k[path.len()..].trim_end_matches('/').contains('/')) {
                                            let col = if k.ends_with('/') { "<D:collection/>" } else { "" };
                                            x.push_str(&format!("<D:response><D:href>{}</D:href><D:propstat><D:prop><D:resourcetype>{col}</D:resourcetype></D:prop></D:propstat></D:response>", uri_encode(k, true)));
                                        }
                                        x.push_str("</D:multistatus>");
                                        (207, x.into_bytes())
                                    }
                                }
                                _ => (405, vec![]),
                            }
                        };
                        drop(f);
                        let _ = write!(s, "HTTP/1.1 {code} X\r\nContent-Length: {}\r\n\r\n", out.len());
                        let _ = s.write_all(&out);
                    }
                });
            }
        });
        files.lock().unwrap().insert("/dav/".into(), vec![]);
        (format!("{addr}/dav"), files)
    }

    #[test]
    fn webdav_round_trip() {
        let (url, files) = dav_server();
        let remote = Remote { kind: "webdav".into(), url, user: "me".into(), password: "pw".into(), prefix: "vault one".into(), ..Default::default() };
        let a = tmp("dav-a");
        put(&a, "n.md", "hello dav");
        put(&a, "d/m.md", "nested");
        let r = run(&a, &remote, "pass", &history::Config::default()).unwrap();
        assert_eq!(r.uploaded.len(), 2);
        assert!(files.lock().unwrap().keys().any(|k| k.starts_with("/dav/vault one/objects/")));
        let b = tmp("dav-b");
        run(&b, &remote, "pass", &history::Config::default()).unwrap();
        assert_eq!(read(&b, "d/m.md").as_deref(), Some("nested"));
        let bad = Remote { password: "nope".into(), user: String::new(), ..remote.clone() };
        assert!(run(&b, &bad, "pass", &history::Config::default()).unwrap_err().contains("access denied"));
        for d in [a, b] {
            let _ = fs::remove_dir_all(d);
        }
    }

    /// Against a real S3 service: NOTEZ_S3_URL=http://127.0.0.1:19001 (e.g.
    /// moto_server or MinIO) with bucket "nzbucket" created;
    /// `cargo test --release s3_round_trip -- --ignored`.
    #[test]
    #[ignore]
    fn s3_round_trip() {
        let url = std::env::var("NOTEZ_S3_URL").expect("NOTEZ_S3_URL");
        let remote = Remote {
            kind: "s3".into(),
            url,
            user: std::env::var("NOTEZ_S3_KEY").unwrap_or_else(|_| "testing".into()),
            password: std::env::var("NOTEZ_S3_SECRET").unwrap_or_else(|_| "testing".into()),
            bucket: "nzbucket".into(),
            region: "us-east-1".into(),
            prefix: "vault one".into(),
            ..Default::default()
        };
        let a = tmp("s3-a");
        put(&a, "n.md", "hello s3");
        put(&a, "d/m.md", "nested ü");
        let r = run(&a, &remote, "pass", &history::Config::default()).unwrap();
        assert_eq!(r.uploaded.len(), 2);
        let b = tmp("s3-b");
        run(&b, &remote, "pass", &history::Config::default()).unwrap();
        assert_eq!(read(&b, "d/m.md").as_deref(), Some("nested ü"));
        // A change on b reaches a.
        put(&b, "n.md", "changed on b");
        run(&b, &remote, "pass", &history::Config::default()).unwrap();
        run(&a, &remote, "pass", &history::Config::default()).unwrap();
        assert_eq!(read(&a, "n.md").as_deref(), Some("changed on b"));
        assert!(run(&a, &remote, "wrong", &history::Config::default()).unwrap_err().contains("passphrase"));
        for d in [a, b] {
            let _ = fs::remove_dir_all(d);
        }
    }
}
