//! NoteZ core: the Rust half of the app (vault, Typst rendering, PDF export).
//! Runs as a helper process of the Electron shell and talks newline-delimited
//! JSON over stdin/stdout:
//!   request  {"id": 1, "cmd": "read_note", "args": {"path": "a.md"}}
//!   response {"id": 1, "ok": ...}  or  {"id": 1, "err": ...}
//! Each request runs on its own thread, so a long PDF export never blocks
//! saving or searching.
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use notez_lib::{dispatch, warm_up, AppState};
use serde_json::{json, Value};

fn main() {
    let packages = std::env::var_os("NOTEZ_PACKAGES").map(std::path::PathBuf::from);
    let state = Arc::new(AppState::new(packages));
    warm_up();
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let (state, stdout) = (state.clone(), stdout.clone());
        std::thread::spawn(move || {
            let req: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(e) => return eprintln!("notez-core: bad request: {e}"),
            };
            let id = req.get("id").cloned().unwrap_or(Value::Null);
            let cmd = req.get("cmd").and_then(Value::as_str).unwrap_or("");
            let args = req.get("args").cloned().unwrap_or(json!({}));
            let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| dispatch(&state, cmd, &args)))
                .map_err(|_| ());
            let crashed = res.is_err();
            let res = res.unwrap_or_else(|_| Err(json!(format!("`{cmd}` crashed"))));
            let msg = match res {
                Ok(v) => json!({ "id": id, "ok": v }),
                Err(e) => json!({ "id": id, "err": e }),
            };
            let mut o = stdout.lock().unwrap();
            let _ = writeln!(o, "{msg}");
            let _ = o.flush();
            // A panic may have poisoned the shared Typst state: exit and let
            // the shell restart a fresh core (it replays the open vault).
            if crashed {
                std::process::exit(101);
            }
        });
    }
}
