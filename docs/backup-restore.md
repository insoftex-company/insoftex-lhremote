# LinkedHelper backup and standby restore (Windows)

Scripts in `scripts/backups/`, installed to `~\backups` by `scripts/install-host.ps1` (see [Windows host layout](windows-host-layout.md)): producer commands on lhserver, restore commands on minis01.
lhremote has no backup command (only `campaign-export`), so the backup is a consistent copy of LinkedHelper's own data plus campaign exports through the lhremote CLI when it works.

| File | Where | What |
|---|---|---|
| `lib_capture_linkedhelper.ps1` | lhserver (elevated) | One archive `lh-backup-<host>-<time>.tar` + `.sha256` + `.manifest.json` |
| `cmd_backup.ps1` | lhserver | Runs the backup, copies it to minis01 (`~\backups\linkedhelper`), verifies SHA-256 there, keeps 7 there / 2 locally |
| `cmd_install_backup_task.ps1` | lhserver (elevated) | Registers the scheduled task (checks every 30 min, works once during 23:00-23:59 Austin, TX, DST-safe) |
| `cmd_backup_now.cmd` | lhserver | Same as nightly, immediately |
| `cmd_check_backup.ps1`, `cmd_install_backup_check_task.ps1` | minis01 | Daily 10:00 check that a backup arrived in the last 24 h; see below |
| `cmd_restore_linkedhelper.ps1`, `cmd_restore_stage.cmd`, `cmd_restore_activate.cmd` | minis01 | Verify and stage the newest archive; switch over on demand |

## How the backup stays consistent while LinkedHelper runs
`lh.db` (SQLite, rollback-journal mode, up to ~1 GB per account) and the Chromium session files are open all the time. The script takes a **VSS snapshot of C:**, copies from the snapshot (no locks, LinkedHelper is not touched), skips caches, logs, installers and LinkedHelper's own old `lh.db.backup.*` (about 3.4 GB of the 8.7 GB data folder is kept), opens every copied `lh.db` and runs `PRAGMA quick_check` on the copy, then writes the manifest (versions, accounts, per-database check) and the archive. A problem is logged as `PROBLEM:` and gives exit code 2, but the archive is still produced.

## What is inside
`data\` = `%APPDATA%\linked-helper` without caches: `config.json`, `Local State`, `Preferences`, `Partitions\linked-helper-account-<id>-main\lh.db` for every account (archived ones included), browser sessions/cookies (`Network`), Local Storage, IndexedDB, the launcher partition; `campaigns\` = `accounts.json`, `campaigns-<id>.json`, `campaign-<account>-<campaign>.yaml` from lhremote (best effort, see below); `manifest.json`.

## Verified (2026-11-22)
The 08:08 archive was extracted into a scratch folder and checked independently of the restore script: SHA-256 matches, 2064 tar entries, 7 databases pass the full `PRAGMA integrity_check` (123 to 238 thousand pages each, 128 tables, hundreds of thousands of rows in the largest tables), the database list equals the manifest, no leftover journal files, 15 cookie databases present, and 307 campaign configurations exported through lhremote. `data\config.json` is LinkedHelper's own **binary** format (it is not JSON and not plain zlib) and is byte-identical to the live file on lhserver at that moment, so do not expect it to parse as JSON; `Local State` is JSON.

## Scheduled run
The task runs as `xuser` in the logged-on session with highest privileges (needed for the snapshot). It is registered as an interactive-logon task. The campaign export needs the lhremote deployment to be readable from that session; if it is not, the backup still runs and records `campaignExport: skipped`. Target host: `~\.secrets\lhremote\backup.json` `{"remoteHost":"..."}` (kept out of git) or `LH_BACKUP_REMOTE_HOST`. SSH key: `~\.ssh\id_dev_insoftex_com`. Logs: `~\tmp\logs\linkedhelper-backup-*.log`; `~\backups\linkedhelper\last-success.txt` holds the last successful Austin date. `cmd_backup.ps1 -Check` tests the settings and the transfer target without making a backup. When scripting on these hosts, do not pipe the output of `ssh.exe` in a run that was itself started over SSH: it never exits. Redirect it to a file.

## Missing-backup warning (minis01)
The task `LinkedHelper backup freshness check` runs `cmd_check_backup.ps1` daily at 10:00. When the newest archive that arrived is older than 24 h (or there is none), it shows a message in the logged-on session, appends `STALE` to `~\tmp\logs\linkedhelper-backup-check.log` and ends with result 1. The warning is only on minis01: nothing is e-mailed or posted, and nothing warns if minis01 itself is off.

## Restore / standby (minis01)
1. `cmd_restore_stage.cmd` (or `cmd_restore_linkedhelper.ps1`): checks SHA-256, extracts to `~\backups\linkedhelper\staged`, checks every `lh.db`, compares the LinkedHelper version in the manifest with what is installed. Touches nothing live; run it after each nightly copy to keep the standby proven.
2. Only when LinkedHelper is **completely stopped on lhserver**: `cmd_restore_activate.cmd` (asks for YES) = `cmd_restore_linkedhelper.ps1 -Activate -IConfirmLhserverIsStopped -QuitLinkedHelper`. LinkedHelper must not run; replaced data is moved (not deleted) to `~\backups\linkedhelper\pre-restore-<time>`. No instance is started.
3. Start LinkedHelper (`launch-linkedhelper.cmd`), check `lhremote list-accounts` / `check-status`, start instances manually. Both machines share one public IP, but never run the same account on both at once.
Install the same LinkedHelper version on minis01 as the backup was written with (a database from a newer LinkedHelper may not open in an older one).
