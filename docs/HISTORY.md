# History, snapshots and sync

NoteZ keeps earlier versions of your notes, can take snapshots of the whole vault, and can sync a vault between devices. All of it is stored as ordinary files: nothing needs a server unless you choose one for sync.

Open everything from **File history…** (the note's ⋯ menu or the file tree's right-click menu), the command palette (*File history*, *Recover deleted notes*, *Vault snapshots*), or **Settings → History & snapshots** and **Settings → Sync**.

## File history

Every time a note is saved, NoteZ keeps its new text as a version. Saves that are close together are merged into one version, so typing for an hour doesn't leave hundreds of entries. The window is set by **Merge edits made within** (10 minutes by default).

NoteZ always keeps a version, whatever the window, before it:

| Reason shown          | When                                                        |
|-----------------------|-------------------------------------------------------------|
| First seen            | The first time NoteZ saves a note it hasn't recorded yet     |
| Changed outside NoteZ | The file on disk changed since the last version (another app, git, sync) |
| Before deleting       | You delete the note or its folder                           |
| Before updating links | A rename rewrote links in this note                         |
| Before renaming a tag | *Rename tag* changed this note                              |
| Before replace in vault | *Find & replace* across the vault changed this note       |
| Before sync changed it | Sync replaced the note with another device's version        |
| Restored              | You restored an earlier version                             |

History covers Markdown (`.md`), Typst (`.typ`), `.base` and `.canvas` files. Images, PDFs and other attachments are not versioned (they are included in snapshots).

### Looking at a version

The **History** dialog lists versions newest first. For the selected version you can see:

- **Compared with now**: what would change if you restored it. Lines marked − are in the note now, lines marked + are in the version.
- **Changes in this version**: what changed since the version before it.

**Copy text** copies the whole version; **Restore** puts it back. Restoring never loses anything: the text it replaces is kept as a version first, so you can undo a restore by restoring again.

### Deleted notes

The **Deleted notes** tab lists notes that have a version in history but no longer exist in the vault, whether they were deleted in NoteZ or outside it. Select one to read it, and **Recover** to put it back at its old path.

### How long versions are kept

| Setting                     | Default |
|-----------------------------|---------|
| Keep versions for           | 60 days |
| At most versions per note   | 300     |

The newest version of a note is always kept, however old it is. Expired versions are removed when a vault opens, or right away with **Clean up now**.

## Vault snapshots

A snapshot records every file in the vault as it is at that moment: notes, attachments, and the vault's own settings in `.notez/` (bookmarks, themes, plugins). It leaves out `.notez/history/`, `.notez/sync/`, `.git/`, `.trash/` and files over 200 MB. Files that didn't change between snapshots are stored once, so a snapshot of an unchanged vault costs almost nothing.

- **Daily snapshots:** with *Take a vault snapshot every day* on, NoteZ takes one a few seconds after the vault opens and once a day while it stays open, but only if something changed. The newest 14 automatic snapshots are kept (*Keep automatic snapshots*).
- **Your own snapshots:** *Take a vault snapshot now* asks for a name, e.g. "Before reorganizing". Named snapshots are kept until you delete them.

In the **Vault snapshots** tab, select a snapshot to see every file that is new, changed or deleted since then. Click a file for its diff (− in the snapshot, + now). Then:

- **Restore this file** brings one file back (for a file that is new since the snapshot, this removes it).
- **Restore all…** brings every changed and deleted file back. You are asked whether to also remove files that were added since.

Before a restore, NoteZ takes an automatic **"Before restoring …"** snapshot, so a restore can itself be undone.

## Sync

Sync keeps a vault the same on several computers. NoteZ doesn't run a server: it uses storage you already have.

| Sync to | What you enter |
|---------|----------------|
| **Folder** | An absolute folder path outside the vault, e.g. a USB drive, a NAS share, or a folder that Dropbox, Google Drive, OneDrive or Syncthing already syncs |
| **WebDAV** | The folder URL, user name and password. Nextcloud: `https://<host>/remote.php/dav/files/<user>/NoteZ`. Use an app password if your account has two-factor login |
| **S3** | The endpoint URL, bucket, region, access key ID and secret key. Works with AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi and other S3-compatible storage. Use a prefix to share one bucket between vaults |

Then choose an **encryption passphrase**. Use the same one on every device.

1. Set the options in **Settings → Sync** and press **Save**.
2. **Test connection** checks that the remote can be reached and that the passphrase matches what is already there.
3. **Sync now**, or click **Sync** in the status bar. With *Sync automatically every … minutes* and *Sync when the vault opens*, it also runs by itself.

To add a second device, open (or create) an empty vault folder there, enter the same remote and passphrase, and sync: every note is downloaded.

### Encryption

Everything is encrypted on your device before it is uploaded. The remote only ever stores:

- `notez-sync.json`: a random salt and a check value, used to tell whether a passphrase is right.
- `head`: the encrypted list of files.
- `objects/…`: one encrypted object per file version, named by a keyed hash that reveals nothing about the content or the name.

The key is derived from your passphrase with Argon2id (64 MiB, 3 passes), and data is encrypted with XChaCha20-Poly1305. Nobody with access to the storage, including its provider, can read your notes or even their names. **If you forget the passphrase, the remote copy can't be decrypted.** Your local notes are not affected; set up a new remote folder with a new passphrase.

The storage password and the passphrase (when *Remember the passphrase* is on) are kept in your system keychain: Keychain on macOS, Credential Manager (DPAPI) on Windows, and the Secret Service (GNOME Keyring or KWallet) on Linux. If no keychain is available, Settings says so. Then a remembered secret is stored unencrypted in the app's settings folder; turn *Remember* off to type the passphrase once per session instead.

### What happens when both devices changed something

Sync compares each file with the version both devices last agreed on:

- **Changed on one device only:** that version wins.
- **Deleted on one device, unchanged on the other:** it is deleted on both.
- **Deleted on one device, edited on the other:** the edited file is kept.
- **Changed differently on both:** your device keeps its version, and the other device's version is saved next to it as `Note (conflict 2026-11-09 1430).md`. Compare the two, merge by hand, and delete the conflict copy.

Every note that sync overwrites or deletes is kept in File history first ("Before sync changed it"), so nothing is lost.

Sync covers the same files as a snapshot: every note and attachment, plus the vault's bookmarks, themes, snippets and plugins in `.notez/`. History, snapshots and the sync settings stay on each device, and `.git/`, `.trash/` and files over 200 MB are left out.

### Cleaning up the remote

Old file versions stay on the remote as objects. **Clean up remote** deletes those that the current file list no longer uses. Run it occasionally, when no other device is in the middle of a sync.

## Where it is stored

```
<vault>/.notez/
  history/
    objects/ab/…        compressed file contents, shared by versions and snapshots
    files/<id>.json     the versions of one note
    snapshots/<id>.json one snapshot: path → content hash
  sync/
    settings.json       the sync settings (no secrets)
    state.json          what this device last synced
```

Deleting `.notez/history` removes all history and snapshots, and nothing else. When you copy a vault, history comes with it unless you leave `.notez` out.
