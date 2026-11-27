// JSON command names, argument defaults, and result serialization.
mod catalog;
mod document;
mod recovery;
mod vault;

use crate::{annotations, bases, blockidx, history, links, query, srs, sync, AppState};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;

fn arg<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, Value> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null)).map_err(|e| json!(format!("bad argument `{key}`: {e}")))
}

/// Optional argument: missing or null → default.
fn opt<T: serde::de::DeserializeOwned + Default>(args: &Value, key: &str) -> T {
    args.get(key).cloned().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

fn out<T: Serialize, E: Serialize>(r: Result<T, E>) -> Result<Value, Value> {
    match r {
        Ok(v) => Ok(serde_json::to_value(v).unwrap_or(Value::Null)),
        Err(e) => Err(serde_json::to_value(e).unwrap_or(Value::Null)),
    }
}

fn ok<T: Serialize>(v: T) -> Result<Value, Value> {
    out::<T, ()>(Ok(v))
}

/// Run one command from the UI.
pub fn dispatch(state: &AppState, cmd: &str, a: &Value) -> Result<Value, Value> {
    if cmd == "open_vault" {
        let _session = state.vault_session.write().unwrap();
        return out(vault::open_vault(state, arg(a, "path")?));
    }
    let _session = state.vault_session.read().unwrap();
    match cmd {
        "list_tree" => out(vault::list_tree(state)),
        "list_notes" => out(vault::list_notes(state)),
        "read_note" => out(vault::read_note(state, arg(a, "path")?)),
        "write_note" => out(vault::write_note(state, arg(a, "path")?, arg(a, "content")?, opt(a, "vault"))),
        "create_note" => out(vault::create_note(state, arg(a, "path")?)),
        "create_folder" => out(vault::create_folder(state, arg(a, "path")?)),
        "rename_entry" => out(vault::rename_entry(state, arg(a, "from")?, arg(a, "to")?, opt(a, "update_links"))),
        "link_refs" => out(state.with_index(|i, r| links::refs(i, r, &arg::<String>(a, "path").unwrap_or_default()))),
        "link_info" => out(state.with_index(|i, _| links::info(i))),
        "delete_entry" => out(vault::delete_entry(state, arg(a, "path")?)),
        "duplicate_entry" => out(vault::duplicate_entry(state, arg(a, "path")?)),
        "search" => out(catalog::search(state, arg(a, "query")?, opt(a, "exclude"))),
        "replace_preview" => out(catalog::replace_preview(state, arg(a, "opts")?, opt(a, "exclude"))),
        "replace_apply" => out(catalog::replace_apply(state, arg(a, "opts")?, arg(a, "paths")?, opt(a, "expected"))),
        "rename_tag" => out(catalog::rename_tag(state, arg(a, "from")?, arg(a, "to")?)),
        "list_tags" => out(state.with_index(|i, _| query::list_tags(i, &opt::<Vec<String>>(a, "exclude")))),
        "note_meta" => out(state.with_index(|i, _| query::note_meta(i))),
        "backlinks" => out(catalog::backlinks(state, arg(a, "path")?, opt(a, "exclude"))),
        "unlinked_mentions" => out(state.with_index(|i, _| blockidx::unlinked(i, &arg::<String>(a, "path").unwrap_or_default(), &opt::<Vec<String>>(a, "exclude"), 300))),
        "link_mentions" => out(catalog::link_mentions(state, arg(a, "link")?, arg(a, "items")?)),
        "block_search" => out(state.with_index(|i, _| blockidx::search(i, &opt::<String>(a, "query"), &opt::<String>(a, "from"), &opt::<Vec<String>>(a, "exclude"), 60))),
        "block_id" => out(catalog::block_id(state, arg(a, "path")?, arg(a, "line")?, opt(a, "text"), opt(a, "id"))),
        "note_section" => out(catalog::note_section(state, opt(a, "from"), arg(a, "link")?)),
        "base_query" => out(state.with_index(|i, r| {
            bases::query(i, r, &opt::<String>(a, "src"), opt::<Option<String>>(a, "view").as_deref(), opt::<Option<String>>(a, "this").as_deref(), &opt::<Vec<String>>(a, "exclude"))
        }).and_then(|r| r)),
        "query_block" => out(state.with_index(|i, r| bases::query_block(i, r, &opt::<String>(a, "src"), opt::<Option<String>>(a, "this").as_deref(), &opt::<Vec<String>>(a, "exclude"))).and_then(|r| r)),
        "base_eval" => out(state.with_index(|i, r| bases::eval_for(i, r, &opt::<String>(a, "expr"), &opt::<String>(a, "path"))).and_then(|r| r)),
        "pdf_links" => out(state.with_index(|i, r| annotations::links_to(i, r, &arg::<String>(a, "path").unwrap_or_default(), &opt::<Vec<String>>(a, "exclude")))),
        "srs_overview" => out(state.with_index(|i, r| srs::overview(i, r, &opt::<Vec<String>>(a, "exclude"), &opt::<srs::Settings>(a, "settings")))),
        "srs_queue" => out(state.with_index(|i, r| srs::queue(i, r, opt::<Option<String>>(a, "deck").as_deref(), &opt::<Vec<String>>(a, "exclude"), &opt::<srs::Settings>(a, "settings")))),
        "srs_grade" => {
            let (id, g): (String, u8) = (arg(a, "id")?, arg(a, "grade")?);
            out(state.root().and_then(|r| srs::grade(&r, &id, g, &opt::<srs::Settings>(a, "settings"))))
        }
        "srs_restore" => {
            let id: String = arg(a, "id")?;
            out(state.root().and_then(|r| srs::restore(&r, &id, opt(a, "prev"))))
        }
        "srs_stats" => out(state.with_index(|i, r| srs::stats(i, r, &opt::<Vec<String>>(a, "exclude")))),
        "srs_load" => out(state.root().map(|r| srs::load(&r).cards)),
        "property_names" => out(state.with_index(|i, _| bases::property_names(i, &opt::<Vec<String>>(a, "exclude")))),
        "property_values" => out(state.with_index(|i, _| bases::property_values(i, &opt::<String>(a, "name"), &opt::<Vec<String>>(a, "exclude")))),
        "graph_links" => out(state.with_index(|i, r| links::graph(i, r, &opt::<Vec<String>>(a, "exclude")))),
        "index_update" => {
            if let Some(vault) = opt::<Option<String>>(a, "vault") {
                if state.root_opt().as_deref() != Some(Path::new(&vault)) {
                    return ok(());
                }
            }
            out(vault::index_update(state, arg(a, "paths")?))
        },
        "history_config" => {
            *state.history.lock().unwrap() = arg(a, "config")?;
            ok(true)
        }
        "history_list" => out(state.root().map(|r| history::list(&r, &opt::<String>(a, "path")))),
        "history_text" => out(recovery::history_text(state, arg(a, "hash")?)),
        "history_restore" => out(recovery::history_restore(state, arg(a, "path")?, arg(a, "hash")?)),
        "history_deleted" => out(state.root().map(|r| history::deleted(&r))),
        "history_keep" => out(state.root().map(|r| state.keep(&r, &opt::<String>(a, "path"), &opt::<String>(a, "reason")))),
        "history_cleanup" => {
            // In the background: it walks every stored object.
            let (r, cfg) = (state.root(), state.hist());
            if let Ok(r) = r {
                std::thread::spawn(move || {
                    if let Err(e) = history::cleanup(&r, &cfg) {
                        eprintln!("history cleanup: {e}");
                    }
                });
            }
            ok(true)
        }
        "snapshot_create" => out(state.root().and_then(|r| history::create_snapshot(&r, &opt::<String>(a, "label"), opt(a, "auto")))),
        "sync_run" => out(recovery::sync_run(state, arg(a, "remote")?, opt(a, "passphrase"))),
        "sync_test" => out(sync::test(&arg::<sync::Remote>(a, "remote")?, &opt::<String>(a, "passphrase"))),
        "sync_status" => out(state.root().map(|r| sync::status(&r))),
        "sync_cleanup" => out(sync::cleanup(&arg::<sync::Remote>(a, "remote")?, &opt::<String>(a, "passphrase"))),
        "snapshot_list" => out(state.root().map(|r| history::list_snapshots(&r))),
        "snapshot_diff" => out(state.root().and_then(|r| history::diff_snapshot(&r, &opt::<String>(a, "id")))),
        "snapshot_text" => out(state.root().and_then(|r| history::snapshot_text(&r, &opt::<String>(a, "id"), &opt::<String>(a, "path")))),
        "snapshot_restore" => out(recovery::snapshot_restore(state, arg(a, "id")?, opt(a, "paths"), opt(a, "remove_added"))),
        "snapshot_delete" => out(state.root().and_then(|r| history::delete_snapshot(&r, &opt::<String>(a, "id")))),
        "import_attachment" => out(vault::import_attachment(state, arg(a, "source")?, opt(a, "dir"))),
        "save_attachment" => out(vault::save_attachment(state, arg(a, "name")?, arg(a, "data")?, opt(a, "dir"))),
        "render_preview" => out(document::render_preview(state, arg(a, "path")?, arg(a, "text")?, arg(a, "blocks")?, opt(a, "known"))),
        "export_pdf" => out(document::export_pdf(state, arg(a, "path")?, arg(a, "text")?, arg(a, "blocks")?, arg(a, "output")?)),
        "export_html" => out(document::export_html(state, arg(a, "path")?, arg(a, "text")?, arg(a, "blocks")?, arg(a, "output")?)),
        "export_docx" => out(document::export_docx(state, arg(a, "path")?, arg(a, "text")?, arg(a, "blocks")?, arg(a, "output")?)),
        "export_markdown" => out(document::export_markdown(state, arg(a, "path")?, arg(a, "text")?, arg(a, "blocks")?, arg(a, "output")?)),
        "generated_typst" => ok(document::generated_typst(state, arg(a, "path")?, arg(a, "text")?, arg(a, "blocks")?)),
        "render_block" => out(document::render_block(state, arg(a, "lang")?, arg(a, "code")?)),
        "block_typst" => out(document::block_typst(arg(a, "lang")?, arg(a, "code")?)),
        "resolve_asset" => out(document::resolve_asset(state, arg(a, "note")?, arg(a, "url")?)),
        "list_fonts" => ok(document::list_fonts()),
        "markdown_html" => ok(document::markdown_html(&arg::<String>(a, "text")?)),
        "list_themes" => ok(document::list_themes(state)),
        "get_theme" => ok(document::get_theme(state, arg(a, "id")?)),
        "theme_thumbnail" => out(document::theme_thumbnail(state, arg(a, "id")?)),
        "note_theme" => ok(document::note_theme(state, arg(a, "path")?, arg(a, "text")?)),
        "save_theme" => out(document::save_theme(state, arg(a, "id")?, arg(a, "theme")?)),
        "reset_theme" => out(document::reset_theme(state, arg(a, "id")?)),
        "list_plugins" => out(vault::list_plugins(state)),
        "read_plugin" => out(vault::read_plugin(state, arg(a, "id")?)),
        _ => Err(json!(format!("unknown command `{cmd}`"))),
    }
}
