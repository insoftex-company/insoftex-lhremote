# LinkedHelper backup and standby restore (Windows)

Scripts in `scripts/` (deployed to `C:\Users\xuser\scripts` on both machines). They only add files; nothing in `packages/` changed.
lhremote has no backup command (only `campaign-export`), so the backup is a consistent copy of LinkedHelper's own data plus campaign exports through the lhremote CLI when it works.

| File | Where | What |
|---|---|---|
| `lh-backup.ps1` | lhserver (elevated) | One archive `lh-backup-<host>-<time>.tar` + `.sha256` + `.manifest.json` |
| `lh-backup-nightly.ps1` | lhserver | Runs the backup, copies it to minis01 (`~\backups\linkedhelper`), verifies SHA-256 there, keeps 7 there / 2 locally |
| `Install-LhBackupTask.ps1` | lhserver (elevated) | Registers the scheduled task (checks every 30 min, works once during 23:00-23:59 Austin, TX, DST-safe) |
| `lh-backup-now.cmd` | lhserver | Same as nightly, immediately |
| `lh-restore.ps1`, `lh-restore-stage.cmd`, `lh-restore-activate.cmd` | minis01 | Verify and stage the newest archive; switch over on demand |

## How the backup stays consistent while LinkedHelper runs
`lh.db` (SQLite, rollback-journal mode, up to ~1 GB per account) and the Chromium session files are open all the time. The script takes a **VSS snapshot of C:**, copies from the snapshot (no locks, LinkedHelper is not touched), skips caches, logs, installers and LinkedHelper's own old `lh.db.backup.*` (about 3.4 GB of the 8.7 GB data folder is kept), opens every copied `lh.db` and runs `PRAGMA quick_check` on the copy, then writes the manifest (versions, accounts, per-database check) and the archive. A problem is logged as `PROBLEM:` and gives exit code 2, but the archive is still produced.

## What is inside
`data\` = `%APPDATA%\linked-helper` without caches: `config.json`, `Local State`, `Preferences`, `Partitions\linked-helper-account-<id>-main\lh.db` for every account (archived ones included), browser sessions/cookies (`Network`), Local Storage, IndexedDB, the launcher partition; `campaigns\` = `accounts.json`, `campaigns-<id>.json`, `campaign-<account>-<campaign>.yaml` from lhremote (best effort, see below); `manifest.json`.

## Scheduled run
The task runs as `xuser` in the logged-on session with highest privileges (needed for the snapshot). It must be interactive because on lhserver junctions (pnpm `node_modules`, the `lhremote` link) cannot be resolved from ssh/S4U logons, so the lhremote CLI works only in the interactive session; without it the backup still runs and records `campaignExport: skipped`. Target host: `scripts\lh-backup.config.json` `{"remoteHost":"..."}` (kept out of git) or `LH_BACKUP_REMOTE_HOST`. SSH key: `~\.ssh\id_dev_insoftex_com`. Logs: `scripts\logs\lh-backup-nightly-*.log`; marker `lh-backup-last-success.txt` holds the last successful Austin date.

## Restore / standby (minis01)
1. `lh-restore-stage.cmd` (or `lh-restore.ps1`): checks SHA-256, extracts to `~\backups\linkedhelper\staged`, checks every `lh.db`, compares the LinkedHelper version in the manifest with what is installed. Touches nothing live; run it after each nightly copy to keep the standby proven.
2. Only when LinkedHelper is **completely stopped on lhserver**: `lh-restore-activate.cmd` (asks for YES) = `lh-restore.ps1 -Activate -IConfirmLhserverIsStopped -QuitLinkedHelper`. LinkedHelper must not run; replaced data is moved (not deleted) to `~\backups\linkedhelper\pre-restore-<time>`. No instance is started.
3. Start LinkedHelper (`launch-linkedhelper.cmd`), check `lhremote list-accounts` / `check-status`, start instances manually. Both machines share one public IP, but never run the same account on both at once.
Install the same LinkedHelper version on minis01 as the backup was written with (a database from a newer LinkedHelper may not open in an older one).
