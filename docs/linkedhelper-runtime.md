# LinkedHelper runtime behaviour, and what it means for lhremote

Facts about how LinkedHelper (LH) behaves at runtime that affect `lhremote` commands and anything built on
them. They were established by the Insoftex WP0 T0.5 tests, 2026-11-15 to 2026-11-16, on:
- LinkedHelper **v2.140.4**;
- `lhremote` 0.28.0 / 0.28.1;
- Windows, with a disposable campaign of `Waiter` and `SendPersonToWebhook` steps.

**Labels:**
- **Observed:** seen at runtime.
- **Source:** read from LH's `app.asar` or this repo.
- **Open:** not established yet.

The full log and the CRM-side design rules are in `insoftex-espocrm-extension`:
- `docs/workflows/LINKEDHELPER_RUNTIME_BEHAVIOUR.md`;
- branch `wp0/t05-results`, `tests/wp0/t05/STATUS.md`.

## Known lhremote gaps

| Gap | Consequence | Status |
| --- | --- | --- |
| `campaign-remove-people` (`CampaignService.removePeople`) always removes from the campaign's **first action** (`actions[0]`). | A person who has moved past the first action keeps running: their remaining webhooks still fire. **Don't use this command to stop a person mid-sequence.** | Observed. **Use `campaign-stop-people` (0.28.2)** instead: action-level exclude on every action after the person's current one, plus removal from the current action (tests C2, D2, C3a, C3b, C4). Verified at runtime on 2026-11-16: the stopped person fired nothing more. |
| `listPeople` / `listOrganizations` aggregated with `MAX(state)`. | Removed people still showed as `queued`. | Fixed in **0.28.1**. Each (person, action) now uses its latest row, and tombstones are excluded. The organization side is assumed to work the same way, not observed. |
| `campaign-start` with `personIds` runs `resetForRerun`: it sets the person to `state = 1` at **every** action, deletes their `action_results` and resets their campaign history. It also starts LH's **global** runner, which runs every active campaign of the account. | Undoes stops. Makes a person who partly ran replay all their remaining steps at once, and erases their results. Starting one test campaign also wakes any other active campaign. | Open: document prominently in the tool description; consider refusing `personIds` that have removal rows unless forced. |
| `campaign-create` document format reads action settings only from `config`, and always names an action after its type. Unknown keys such as `actionSettings` or `name` are ignored without an error (`packages/core/src/formats/campaign-format.ts:201`). | A campaign created with `actionSettings` gets empty settings on every action, and custom names are lost. Fixed afterwards with `campaign-update-action` (T0.5 campaign 9). | Open: reject unknown action keys; accept `name`. |
| The `campaign-start` MCP tool **requires** `personIds` (`minItems: 1`), so every start runs `resetForRerun` on the listed people. | A paused campaign can't be resumed without resetting the people passed in. Harmless only for people new to the campaign. | Open: make `personIds` optional (start without a reset). |
| `campaign-list-people` labels `state = 2` as `processed`. | For a finished person: first action `queued`, later actions `processed`. `state = 2` really means "entered this action" (see below). | Open: relabel or add a derived per-person status. |
| `campaign-create` / `campaign-add-action` accept `SendPersonToWebhook` with `exportSettings: {}`. | LH flags 15 validation errors on the action (it still runs), and the payload is about 5× larger. | Open: not validated yet. Copy `exportSettings` from a UI-created action. |
| The campaign linter reports `SendPersonToWebhook` as "unknown action type". | False warning. The action works (802 production webhooks in one campaign). | Open |
| `list-accounts` mapped no archived flag from LH's account list. | LH can't delete an account, only archive it, and archived accounts stay in the list. Scripts that walk every account (Insoftex FEED loader, campaign status sync) kept processing archived account 384717. | Fixed in **0.28.4**: `archived` comes from LH's `hidden` flag (the only field that marked the archived account, 2026-11-16), and archived accounts are left out unless `includeArchived`. Account auto-resolution no longer counts them. Verified on the Insoftex machine after deploy (2026-11-16). |

## How LH runs campaigns

- **Instance scope.**
  - A running account instance executes **every active campaign** of that account whenever the account's
    working hours are open. A campaign can't be started in isolation. Starting an instance also loads the
    LinkedIn feed.
  - With no open working-hours window, an active campaign does nothing.
  - Working hours are global per account and stored per weekday. `00:00–00:00` means the day is closed.
  - *Observed.*
- **Archive, not delete.** LH's UI can't delete an account or a campaign, only archive it, and archiving can
  be undone. `campaign-list` leaves archived campaigns out unless `includeArchived` is set. *Reported by the
  operator, 2026-11-16.*
- **Webhook-only campaigns don't visit LinkedIn.**
  - A campaign of only `Waiter` + `SendPersonToWebhook` didn't load a profile or call LinkedIn's identity API,
    even for people known only by URL. Page-URL and CDP network watchdogs were running.
  - Profile fields (`member_id`, names, headline) stay `null` for such people.
  - *Observed.*
- **Timing.**
  - The first step runs about 1–4 s after `campaign-start`, or about 23 s after an import into a running
    campaign.
  - `Waiter` delay is in hours, and accurate to about 1 s.
  - *Observed.*

## Imports (`import-people-from-urls`)

- **Synchronous.** The person is listed as soon as the call returns, whether the campaign is running or not.
  No settle time is needed. *Observed.*
- **Re-import outcomes:**
  - a queued person → `alreadyInQueue`;
  - a person who finished cleanly → `alreadyProcessed`, and they don't run again;
  - a removed person → `imported`, with a new queued row.

  *Observed.*
- **Replay hazard (caused by lhremote).** A person removed mid-sequence was re-imported and started with
  `campaign-start --person-ids`. That command's `resetForRerun` set them back to queued at **every** action,
  and LH ran all those steps at once, in reverse order: last webhook first, all within about 1 s. Never re-import
  a person into a campaign they have partly run, and never pass their id to `campaign-start`. Whether a plain
  re-import without the reset replays isn't established. *Observed; cause from source.*

## Removal and exclusion

- **Mechanism.** `createActionVersion({actionId, removeFromTarget: {request: {}, type: "people", filter:
  [personIds]}})` inserts a new `action_target_people` row with `state = -1` (a tombstone). Nothing is
  deleted. The highest `id` per `(person_id, action_id)` is current. *Observed.*
- **Which action matters.** Removing a person from the action they are **currently** on (e.g. the Waiter they
  are waiting in) stopped them: no later webhooks and no later `action_results`. Removing them from the first
  action after they moved past it didn't. *Observed.*
- **Undo (caused by lhremote).** Every observed tombstone flip back to `state = 1` followed
  `campaign-start --person-ids` for that person (`resetForRerun`: `UPDATE action_target_people SET state = 1`
  at every action). LH itself kept removals through later versions for **other** people: an import on the
  first action, and a removal of someone else at the same action (C3a). *Observed; cause from source.*
- **Exclusion.** A campaign-level `campaign-exclude-add` for a person already in the sequence didn't stop
  them. An **action-level** exclude on the person's **next** action did: LH entered that action and wrote
  `action_results.result = -2` with no webhook, and ran nothing after it (D2). `campaign-exclude-add` writes
  the exclude list straight into `lh.db` while LH runs; an integrity check is pending. Whether excludes
  survive later imports and removals: **yes**. Excludes on 40–42 stayed after new versions on 38 and 39,
  and the person was dropped at 40 (C3b). *Observed.*
- **Stop confirmation.** Immediately after a stop: the latest row at the current action is `-1`, and the person is on
  each later action's exclude list (what `campaign-stop-people` verifies). `result = -2` appears only when the
  person reaches an excluded action. The LH UI lists removed people as **Processed** and excluded ones as
  **Excluded**. *Observed (T0.5 I).*
- **Removal on an unreached action** writes no tombstone row (C4), so it doesn't pre-empt arrival. Use an
  action-level exclude for future actions. *Observed.*

## Database semantics (`lh.db`, per account)

- **`action_target_people.state`:**
  - `1` = queued: import rows, first action;
  - `2` = **entered** this action: inserted together with the previous action's `action_results` row;
  - `-1` = removed.

  *Observed.*
- **`action_results`:** one row per completed action (`result = 1`), at completion time. Waiters write
  nothing while waiting. `campaign-start --person-ids` **deletes** the person's results
  (`resetForRerun`), so they are current state, not history. *Observed; cause from source.*
- **Per-person status:**
  - finished = `action_results` has the last action;
  - at action X = latest row is X with `state = 2` and X has no result;
  - removed = latest row at the current action is `-1`.

  *Observed.*
- **`campaign-update-action`** updates the `action_configs` row in place. `action_id` and the version don't
  change, a rename shows in the next webhook's `action_name`, and Waiter changes apply to the next person.
  *Observed.*
- **Auditing LinkedIn activity:**
  - `action_results` → `action_versions` → `actions` → `campaigns`, with `action_configs.actionType`;
  - `limit_type_credits_used` ⨝ `limit_types.type` (`Message`, `Invite`, …) shows the LinkedIn actions
    actually used.

  *Observed.*

## `SendPersonToWebhook` payload

The payload is a flat object: `lh_id`, `public_id`, `profile_url`, `member_id`, `first_name`, `last_name`,
`headline`, `add_to_target_date_iso`, `action_id`, `action_name`, `action_type`, `campaign_id`,
`campaign_name`, `my_id` (the LH account id) and `my_email`. *Observed.*

- **URL check.** The URL must match `/^(http|https):\/\//i`. *Source.*
- **Duplicate delivery.** In 16 deliveries, one (a final-step webhook) was logged twice in the same
  millisecond, with a single `action_results` row. All 12 deliveries logged per request arrived once.
  Consumers must be idempotent. *Observed; cause unconfirmed.*
- **Failed delivery is final: at most once.** With the receiver down, the webhook action got `result = -1` and
  exception `870030`, and LH never retried after the receiver came back (T0.5 N). The campaign was found paused
  right afterwards without anyone pausing it, so LH probably pauses a campaign after webhook failures (not
  proven). *Observed.*

## Windows deployment (Insoftex LinkedHelper machine)

- **Layout.** pnpm global `@insoftex/lhremote` → junction `C:\Users\xuser\scripts\lhremote` → versioned
  snapshot `scripts\lhremote-<version>`, with `DEPLOYMENT-INFO.json`.
- **Deploy:**
  1. On `main`, run `pnpm build`.
  2. Run `pnpm --filter=@insoftex/lhremote deploy --prod scripts\lhremote-<new>`.
  3. Repoint the junction, keeping the old snapshot for rollback.
  4. Reconnect the MCP server (`/mcp` in Claude Code).
  5. Confirm with `hello` (0.28.3+): the MCP tool and `lhremote hello` report the version and the real
     path of the running copy, which must sit in `scripts\lhremote-<new>`. The MCP server only picks up
     a new snapshot after a reconnect, so check the MCP tool, not just the CLI.

  LinkedHelper campaigns keep running during the switch.
- **MCP entry.** Claude Code's entry is `cmd /c npx --yes lhremote@0.20.1 mcp`. It reaches this fork only
  through the pnpm shim `%LOCALAPPDATA%\pnpm\lhremote.cmd`. That's fragile: the entry should point at the
  shim directly.

## Safety rules for live tests

- Before starting a campaign, check that no other campaign on the account is active.
- Watch LinkedIn network requests over CDP, not only page URLs.
- Back up `lh.db` with LH closed before tests that write.
- Afterwards, restore working hours and the instance state.

On 2026-11-15 a test start let a paused-by-schedule production campaign run, and it sent one real LinkedIn
message.
