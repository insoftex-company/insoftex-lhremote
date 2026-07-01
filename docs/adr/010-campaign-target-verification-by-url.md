# ADR-010: Campaign Target-People Verification by LinkedIn URL

## Status

Accepted (2026-07-01)

## Context

External callers that bulk-import contacts into a campaign (e.g. the EspoCRM →
LinkedHelper sync script) need to know, per LinkedIn URL, whether the contact
actually ended up on the campaign's target list — so they can report exactly
those contacts back to their own system (e.g. moving them out of a "to
import" list) and never resubmit an already-targeted contact.

A production run of that sync script exposed two problems with the naive
approach (loop over contacts, call `import-people-from-urls` once per
contact, trust the returned stats):

1. **Instability under load.** Each single-URL call spawns a fresh CLI
   process and a fresh CDP connection to the same running instance. After
   12 back-to-back calls in one run, the instance's CDP debug listener
   stopped responding, then recovered a minute later on a different port
   (same PID) — consistent with the Electron process stalling under the
   connection churn.
2. **False negatives in the returned stats.** `import-people-from-urls`
   resolves `source.people.actions.importPeopleFromUrls()` in LinkedHelper's
   own renderer and returns whatever `stats.total.addToTarget` says
   ([campaign.ts](../../packages/core/src/services/campaign.ts) —
   `CampaignService.importPeopleFromUrls`). During the same run, all 12
   calls reported `failed`, yet all 12 contacts were later confirmed present
   in the campaign — LinkedHelper's own async import pipeline had not
   finished by the time its promise resolved, so the immediately-returned
   count was wrong. lhremote's CDP transport was not at fault: request/response
   correlation by message ID ([cdp/client.ts](../../packages/core/src/cdp/client.ts))
   is sound, and a timeout raises `CDPTimeoutError` rather than silently
   returning stale data — the wrong stats came from LinkedHelper itself.

Two alternatives were considered for getting reliable per-contact
confirmation without hammering the instance with one CDP call per contact.

## Decision

1. **Batch the import call.** Callers doing bulk imports should submit all
   URLs for a campaign in one `import-people-from-urls` call (already
   chunked internally at `IMPORT_CHUNK_SIZE = 200` —
   [import-people-from-urls.ts](../../packages/core/src/operations/import-people-from-urls.ts))
   instead of looping one URL per call. This collapses N CDP connections
   into ~1 per campaign, removing the probable trigger for the instability
   observed above. No code change was required for this half — `--urls`
   (comma-separated) and `--urls-file` already exist on the CLI.

2. **Verify actual membership via a read-only DB query, not the CDP call's
   returned stats.** `campaign-list-people` gains an optional
   `linkedInUrls` filter. Each URL is resolved to its LinkedIn public ID via
   the existing `extractPublicId()` helper
   ([navigate-to-profile.ts](../../packages/core/src/operations/navigate-to-profile.ts))
   and matched against `person_external_ids.external_id` (`type_group =
   'public'`) joined through `action_target_people`, mirroring the existing
   `ProfileRepository.findByPublicIds()` pattern
   ([profile.ts:256-277](../../packages/core/src/db/repositories/profile.ts#L256-L277)).
   The operation returns the matched `people` entries plus
   `notFoundLinkedInUrls` — the subset of submitted URLs with no
   corresponding target-list row. This is read-only, consistent with
   ADR-003's "read-only by default," and requires no new write surface.

   Callers should poll this for a short settle window (tens of seconds)
   after the batch import rather than reading once immediately, since
   LinkedHelper's own add can complete asynchronously after the CDP call
   returns (per the false-negative above).

## Alternatives Considered

### Write directly to LinkedHelper's SQLite database

lhremote already does direct writes for some operations (e.g.
`CollectionListRepository.addPeople()` inserts `personIds` into a static
collection — no CDP involved). That precedent doesn't transfer to campaign
targeting:

- **Collections take `personIds` for people LinkedHelper already knows
  about.** A brand-new contact's LinkedIn URL has no corresponding `person`
  row yet — materializing one is exactly what LinkedHelper's own
  `importPeopleFromUrls()` JS does internally (profile resolution,
  dedup/exclude-list checks). A raw `INSERT` can't replicate that without
  reimplementing undocumented, version-coupled application logic.
- **ADR-003 already flags this class of risk**: direct writes "bypass any
  application-level validation LinkedHelper may perform" and couple lhremote
  to an "undocumented" schema that "may change between versions."
- **Live-runner blind spot.** Campaign targeting feeds an active automation
  runner enforcing LinkedIn rate limits and pacing. If that runner's queue
  is cached in memory rather than polled fresh from disk, a person inserted
  directly into `action_target_people` could sit there unprocessed
  indefinitely — a silent failure mode strictly worse than the false
  negative this ADR fixes.

Rejected for target-people insertion. Read-only DB access remains fine and
is exactly what the verification half of this decision uses.

### File-based hand-off to LinkedHelper

Investigated as "write contacts to a temp file, have LinkedHelper import
from it." This already exists — `import-people-from-urls --urls-file
<path>` reads a newline/comma-separated file and feeds it through the same
CDP call. It doesn't need to be built. But by itself it doesn't solve the
per-contact confirmation problem: batching (whether via `--urls` or
`--urls-file`) still only returns aggregate `imported/alreadyInQueue/
alreadyProcessed/failed` counts, which is what led the caller script to loop
one URL at a time in the first place.

Kept as the batching mechanism (decision §1), but insufficient alone —
paired with the DB-verification read (decision §2).

## Consequences

**Positive:**

- Bulk imports drop from O(n) CDP connections to ~O(1) per campaign,
  removing the likely cause of the observed instance instability.
- Per-contact confirmation becomes authoritative (DB state) instead of
  trusting a transient in-renderer promise result that can resolve before
  LinkedHelper's own async pipeline finishes.
- No new write surface — reuses the existing read-only DB access pattern
  and an existing URL→public-ID helper, keeping the change additive to
  `campaign-list-people` rather than a new command.

**Negative:**

- Adds a second round trip (DB read) after the batch import, and that read
  may need to be polled/retried for a settle window rather than done once —
  slightly more complex than a single "call and trust the result" flow.
- Verification is still keyed on LinkedHelper's own public-ID
  representation (`person_external_ids`); if LinkedHelper changes how it
  stores or normalizes public IDs, both the import and verification paths
  need updating together.

**Neutral:**

- The caller-side fix (batching + polling the new filter) lives outside
  this repo, in the EspoCRM sync script — this ADR only covers the lhremote
  capability that makes it possible.
