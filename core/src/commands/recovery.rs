use crate::{history, sync, AppState, Res};

pub(super) fn history_text(state: &AppState, h: String) -> Res<String> {
    let bytes = history::get_object(&state.root()?, &h)?;
    String::from_utf8(bytes).map_err(|_| "not a text file".into())
}

pub(super) fn history_restore(state: &AppState, path: String, h: String) -> Res<String> {
    let root = state.root()?;
    let text = history::restore(&root, &state.hist(), &path, &h)?;
    state.with_index(|i, _| i.put(&path, &text))?;
    Ok(text)
}

pub(super) fn snapshot_restore(state: &AppState, id: String, paths: Option<Vec<String>>, remove_added: bool) -> Res<Vec<String>> {
    let root = state.root()?;
    let done = history::restore_snapshot(&root, &state.hist(), &id, paths.as_deref(), remove_added)?;
    state.with_index(|i, r| done.iter().for_each(|p| i.refresh(r, p)))?;
    Ok(done)
}

pub(super) fn sync_run(state: &AppState, remote: sync::Remote, passphrase: String) -> Res<sync::Report> {
    let root = state.root()?;
    let Ok(_guard) = state.sync_lock.try_lock() else {
        return Err("a sync is already running".into());
    };
    let report = sync::run(&root, &remote, &passphrase, &state.hist())?;
    state.with_index(|i, r| report.changed.iter().for_each(|p| i.refresh(r, p)))?;
    Ok(report)
}
