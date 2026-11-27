# Windows host layout (lhserver, minis01)

The Windows machines follow the same layout as the Insoftex VPSs (`insoftex-docker`): files come from a Git checkout, backups live in `~/backups`, secrets in `~/.secrets`, logs in `~/tmp/logs`.

| Folder | Holds | Rule |
|---|---|---|
| `~\scripts` | Operator scripts, and the lhremote deployment (`lhremote` junction) | Installed from a repository; no hand-made files |
| `~\backups` | Backup and restore commands (`cmd_*`, `lib_*`) and, in subfolders, the archives | Installed from this repository |
| `~\.secrets\<project>\` | Secrets and machine-specific settings | Never in git |
| `~\tmp\logs` | Logs | Scripts create the folder if missing |
| `~\Documents\PROJECTS\Insoftex\<repo>` | Git checkouts | Nothing runs from a checkout; install or deploy first |

Each file has one installed copy. Anything that starts a program (scheduled task, Startup shortcut, desktop shortcut, MCP client setting) points into `~\scripts` or `~\backups`.

## Install and update

From an elevated shell, after updating the checkout:

```powershell
pnpm install; pnpm build        # lhremote itself, see linkedhelper-runtime.md
powershell -ExecutionPolicy Bypass -File scripts\install-host.ps1 -Role Source    # lhserver
powershell -ExecutionPolicy Bypass -File scripts\install-host.ps1 -Role Standby   # minis01
```

`-Check` reports drift without changing anything. On lhserver the installer also registers the nightly backup task, which needs `~\.secrets\lhremote\backup.json` (see [backup and restore](backup-restore.md)).

## Owners

| Files | Repository |
|---|---|
| lhremote wrappers, LinkedHelper launchers, `~\backups` commands | this one |
| Firewall, RDP and weekly-reboot scripts | `insoftex-admin-tools` (`scripts/windows/`) |
| EspoCRM synchronisation and LinkedHelper daily scripts | `insoftex-espocrm-extension` (`scripts/nodejs/`) |

## Not yet compliant (2026-11-27)

- The launcher logs to `%TEMP%`; the weekly-reboot and bloat scripts log to `~\scripts\logs`; the daily script logs under `%LOCALAPPDATA%`.
- The other two repositories have no installer; their files are copied by hand.
- lhserver still has a pnpm global shim and a PowerShell profile function for `lhremote`, and both machines have a second install in `%LOCALAPPDATA%\lhremote`.
