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

## MCP clients

Every MCP client starts the deployment with an absolute Node executable, never `npx`, a pnpm shim or another copy:

```json
{ "command": "C:/Program Files/nodejs/node.exe", "args": ["C:/Users/xuser/scripts/lhremote/dist/cli.js", "mcp"] }
```

On lhserver Node is `C:/nvm4w/nodejs/node.exe`. Reconnect clients after a deployment.

## Auto-start

| Machine | Entry | Starts |
|---|---|---|
| lhserver, minis01 | Startup folder shortcut | `~\scripts\launch-linkedhelper-silent.vbs` |
| lhserver | Task `LinkedHelper nightly backup - Austin 11PM` | `~\backups\cmd_backup.ps1` |
| minis01 | Task `LinkedHelper backup freshness check` | `~\backups\cmd_check_backup.ps1` |
| minis01 | Task `Weekly maintenance reboot` (`insoftex-admin-tools`) | `~\scripts\Invoke-WeeklyReboot.ps1` |

## Owners

| Files | Repository |
|---|---|
| lhremote wrappers, LinkedHelper launchers, `~\backups` commands | this one |
| Firewall, RDP and weekly-reboot scripts | `insoftex-admin-tools` (`scripts/windows/`) |
| EspoCRM synchronisation and LinkedHelper daily scripts | `insoftex-espocrm-extension` (`scripts/nodejs/`) |

## Access to private data

LinkedHelper archives hold browser sessions and databases. `~\backups` is not readable by the `CodexSandboxUsers` group (`install-host.ps1` removes that access). `~\.secrets` is still readable by it, on purpose until decided otherwise: agent skills of `insoftex-admin-tools` read `~\.secrets\.n8n_header_auth`.

## Not yet compliant (2026-11-27)

- The daily script (`insoftex-espocrm-extension`) logs under `%LOCALAPPDATA%`.
- `insoftex-admin-tools` and `insoftex-espocrm-extension` have no installer; their files are copied by hand.
- lhserver keeps a pnpm global shim for `lhremote` until the next logon has picked up the new `PATH`; then remove it with `pnpm remove -g @insoftex/lhremote`.
- minis01 keeps `%LOCALAPPDATA%\lhremote` until the sessions started before the MCP settings change have ended.
- lhserver: `~\p6-lhdb-copies` stays until the tests described in the `insoftex-espocrm-extension` runbook end.
