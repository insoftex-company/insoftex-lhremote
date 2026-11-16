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
| `campaign-remove-people` (`CampaignService.removePeople`) always removes from the campaign's **first action** (`actions[0]`). | A person who has moved past the first action keeps running: their remaining webhooks still fire. **Don't use this command to stop a person mid-sequence.** | Observed. Fix planned: a current-action / all-actions mode (0.28.2), pending tests C3 and C4. |
| `listPeople` / `listOrganizations` aggregated with `MAX(state)`. | Removed people still showed as `queued`. | Fixed in **0.28.1**. Each (person, action) now uses its latest row, and tombstones are excluded. The organization side is assumed to work the same way, not observed. |
| `campaign-list-people` labels `state = 2` as `processed`. | For a finished person: first action `queued`, later actions `processed`. `state = 2` really means "entered this action" (see below). | Open: relabel or add a derived per-person status. |
| `campaign-create` / `campaign-add-action` accept `SendPersonToWebhook` with `exportSettings: {}`. | LH flags 15 validation errors on the action (it still runs), and the payload is about 5× larger. | Open: validate in 0.28.2. Copy `exportSettings` from a UI-created action. |
| The campaign linter reports `SendPersonToWebhook` as "unknown action type". | False warning. The action works (802 production webhooks in one campaign). | Open |

## How LH runs campaigns

- **Instance scope.**
  - A running account instance executes **every active campaign** of that account whenever the account's
    working hours are open. A campaign can't be started in isolation. Starting an instance also loads the
    LinkedIn feed.
  - With no open working-hours window, an active campaign does nothing.
  - Working hours are global per account and stored per weekday. `00:00–00:00` means the day is closed.
  - *Observed.*
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
- **Replay hazard.** A person removed mid-sequence still has rows at later actions. If re-imported, they run
  **all remaining steps at once, in reverse order**: last webhook first, all within about 1 s. Never re-import
  a person into a campaign they have partly run. *Observed.*

## Removal and exclusion

- **Mechanism.** `createActionVersion({actionId, removeFromTarget: {request: {}, type: "people", filter:
  [personIds]}})` inserts a new `action_target_people` row with `state = -1` (a tombstone). Nothing is
  deleted. The highest `id` per `(person_id, action_id)` is current. *Observed.*
- **Which action matters.** Removing a person from the action they are **currently** on (e.g. the Waiter they
  are waiting in) stopped them: no later webhooks and no later `action_results`. Removing them from the first
  action after they moved past it didn't. *Observed.*
- **Undo.** A tombstone has flipped back to `state = 1` after a later import, start or new version of the same
  action for the **same** person. Later versions for **other** people (an import on the first action, a removal
  of someone else at the same action) didn't undo it (C3a). Never re-import or re-version a stopped person.
- **Exclusion.** A campaign-level `campaign-exclude-add` for a person already in the sequence didn't stop
  them. An **action-level** exclude on the person's **next** action did: LH entered that action and wrote
  `action_results.result = -2` with no webhook, and ran nothing after it (D2). `campaign-exclude-add` writes
  the exclude list straight into `lh.db` while LH runs; an integrity check is pending. Whether excludes
  survive later imports and removals is open (C3b). *Observed / open.*

## Database semantics (`lh.db`, per account)

- **`action_target_people.state`:**
  - `1` = queued: import rows, first action;
  - `2` = **entered** this action: inserted together with the previous action's `action_results` row;
  - `-1` = removed.

  *Observed.*
- **`action_results`:** one row per completed action (`result = 1`), at completion time. Waiters write
  nothing while waiting. A **re-run updates the row in place**, `created_at` included, so it is current state,
  not history. *Observed.*
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
- **Failed delivery.** It appears as exception `870030`. Whether LH retries is open.

## Windows deployment (Insoftex LinkedHelper machine)

- **Layout.** pnpm global `@insoftex/lhremote` → junction `C:\Users\xuser\scripts\lhremote` → versioned
  snapshot `scripts\lhremote-<version>`, with `DEPLOYMENT-INFO.json`.
- **Deploy:**
  1. On `main`, run `pnpm build`.
  2. Run `pnpm --filter=@insoftex/lhremote deploy --prod scripts\lhremote-<new>`.
  3. Repoint the junction, keeping the old snapshot for rollback.
  4. Reconnect the MCP server (`/mcp` in Claude Code).

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
