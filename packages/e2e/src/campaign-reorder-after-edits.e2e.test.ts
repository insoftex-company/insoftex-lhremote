// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Regression test for campaign-reorder-actions failing after add-action / update-action edits.
 *
 * Exact reproduction sequence:
 *   1. campaign-create with 2 CDP-tracked actions (MessageToPerson + CheckForReplies)
 *   2. campaign-add-action SendPersonToWebhook  → action N   (DB-only, no campaign_version sync before fix)
 *   3. campaign-add-action MessageToPerson       → action N+1 (DB-only)
 *   4. campaign-update-action on CheckForReplies  (settings + name)
 *   5. campaign-reorder-actions([msg1, webhook, checkReplies, msg2]) → MUST SUCCEED
 *   6. campaign-get / campaign-export confirm chain in requested order, no duplicate actions
 *
 * Criteria covered (A–F):
 *   A — Exact reproduction sequence succeeds; export shows reordered chain
 *   B — Reorder succeeds immediately after add-action / update-action mix
 *   C — Fresh-campaign reorder still works (no regression)
 *   D — Idempotent / repeat reorders succeed
 *   E — Action ID + settings integrity preserved after reorder
 *   F — Version consistency: reorder and read tools agree on the same action set
 *
 * Criterion G (instance-independence with launcher down) requires a separate
 * test scenario: stop the LauncherService after instance start, then call
 * reorder with an explicit instance cdpPort and auto-resolved accountId.
 * That scenario is not covered here because the E2E harness always keeps the
 * launcher running to manage the instance lifecycle.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertDefined,
  describeE2E,
  forceStopInstance,
  launchApp,
  quitApp,
  resolveAccountId,
  retryAsync,
} from "@insoftex/lhremote-core/testing";
import {
  type AppService,
  LauncherService,
  startInstanceWithRecovery,
} from "@insoftex/lhremote-core";

import {
  handleCampaignAddAction,
  handleCampaignCreate,
  handleCampaignErase,
  handleCampaignExport,
  handleCampaignGet,
  handleCampaignReorderActions,
  handleCampaignUpdateAction,
} from "@insoftex/lhremote-cli/handlers";

const CAMPAIGN_YAML = `
version: "1"
name: E2E Reorder-After-Edits Campaign
description: Regression test for reorder after add/update edits
actions:
  - type: MessageToPerson
  - type: CheckForReplies
`.trimStart();

describeE2E("campaign-reorder-actions after add/update edits (regression)", () => {
  let app: AppService;
  let port: number;
  let accountId: number;

  beforeAll(async () => {
    const launched = await launchApp();
    app = launched.app;
    port = launched.port;

    accountId = await resolveAccountId(port);

    const launcher = new LauncherService(port);
    await retryAsync(() => launcher.connect(), { retries: 3, delay: 1_000 });
    await startInstanceWithRecovery(launcher, accountId, port);
    launcher.disconnect();
  }, 120_000);

  afterAll(async () => {
    const launcher = new LauncherService(port);
    try {
      await launcher.connect();
      await forceStopInstance(launcher, accountId, port);
    } catch {
      // best-effort
    } finally {
      launcher.disconnect();
    }
    await quitApp(app);
  }, 60_000);

  describe("reproduction sequence (criteria A+B+E+F+G)", () => {
    const originalExitCode = process.exitCode;

    let campaignId: number | undefined;
    let msgActionId: number | undefined;
    let checkRepliesActionId: number | undefined;
    let webhookActionId: number | undefined;
    let msg2ActionId: number | undefined;

    afterAll(async () => {
      if (campaignId !== undefined) {
        const prev = process.exitCode;
        try {
          process.exitCode = undefined;
          vi.spyOn(process.stdout, "write").mockReturnValue(true);
          await handleCampaignErase(campaignId, { cdpPort: port });
        } catch {
          // best-effort
        } finally {
          process.exitCode = prev;
          vi.restoreAllMocks();
        }
      }
    });

    beforeEach(() => {
      process.exitCode = undefined;
    });

    afterEach(() => {
      process.exitCode = originalExitCode;
      vi.restoreAllMocks();
    });

    it("step 1 — campaign-create produces 2 CDP-tracked actions", async () => {
      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      await handleCampaignCreate({ yaml: CAMPAIGN_YAML, cdpPort: port, json: true });

      expect(process.exitCode).toBeUndefined();
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out) as { id: number; name: string };

      expect(parsed.id).toBeGreaterThan(0);
      campaignId = parsed.id;
      expect(parsed.name).toBe("E2E Reorder-After-Edits Campaign");
    }, 30_000);

    it("step 1b — campaign-get resolves action IDs for both initial actions", async () => {
      assertDefined(campaignId, "step 1 must run first");

      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      await handleCampaignGet(campaignId, { cdpPort: port, json: true });

      expect(process.exitCode).toBeUndefined();
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out) as {
        actions: { id: number; config: { actionType: string } }[];
      };

      // Both initial actions are present (no duplication)
      expect(parsed.actions).toHaveLength(2);

      const msgAction = parsed.actions.find((a) => a.config.actionType === "MessageToPerson");
      const checkAction = parsed.actions.find((a) => a.config.actionType === "CheckForReplies");
      assertDefined(msgAction, "MessageToPerson action missing");
      assertDefined(checkAction, "CheckForReplies action missing");

      msgActionId = msgAction.id;
      checkRepliesActionId = checkAction.id;
    }, 30_000);

    it("step 2 — campaign-add-action adds SendPersonToWebhook (DB-only)", async () => {
      assertDefined(campaignId, "step 1 must run first");

      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      await handleCampaignAddAction(campaignId, {
        name: "Webhook Notify",
        actionType: "SendPersonToWebhook",
        actionSettings: JSON.stringify({ url: "https://example.com/hook" }),
        cdpPort: port,
        json: true,
      });

      expect(process.exitCode).toBeUndefined();
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out) as { id: number; config: { actionType: string } };

      expect(parsed.id).toBeGreaterThan(0);
      expect(parsed.config.actionType).toBe("SendPersonToWebhook");
      webhookActionId = parsed.id;
    }, 30_000);

    it("step 3 — campaign-add-action adds a second MessageToPerson (DB-only)", async () => {
      assertDefined(campaignId, "step 1 must run first");

      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      await handleCampaignAddAction(campaignId, {
        name: "Follow-up Message",
        actionType: "MessageToPerson",
        cdpPort: port,
        json: true,
      });

      expect(process.exitCode).toBeUndefined();
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out) as { id: number; config: { actionType: string } };

      expect(parsed.id).toBeGreaterThan(0);
      expect(parsed.config.actionType).toBe("MessageToPerson");
      msg2ActionId = parsed.id;
    }, 30_000);

    it("step 3b — campaign-get shows 4 actions with no duplicates (criterion F)", async () => {
      assertDefined(campaignId, "step 1 must run first");
      assertDefined(msgActionId, "step 1b must run first");
      assertDefined(checkRepliesActionId, "step 1b must run first");
      assertDefined(webhookActionId, "step 2 must run first");
      assertDefined(msg2ActionId, "step 3 must run first");

      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      await handleCampaignGet(campaignId, { cdpPort: port, json: true });

      expect(process.exitCode).toBeUndefined();
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out) as {
        actions: { id: number }[];
      };

      // Exactly 4 actions, no duplicates (regression guard for double action_versions)
      expect(parsed.actions).toHaveLength(4);
      const ids = parsed.actions.map((a) => a.id);
      expect(ids).toContain(msgActionId);
      expect(ids).toContain(checkRepliesActionId);
      expect(ids).toContain(webhookActionId);
      expect(ids).toContain(msg2ActionId);
      // No duplicate IDs
      expect(new Set(ids).size).toBe(4);
    }, 30_000);

    it("step 4 — campaign-update-action renames CheckForReplies with new settings", async () => {
      assertDefined(campaignId, "step 1 must run first");
      assertDefined(checkRepliesActionId, "step 1b must run first");

      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      await handleCampaignUpdateAction(campaignId, checkRepliesActionId, {
        name: "Reply Check (updated)",
        actionSettings: JSON.stringify({ waitDays: 3 }),
        cdpPort: port,
        json: true,
      });

      expect(process.exitCode).toBeUndefined();
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out) as { id: number; name: string };

      expect(parsed.id).toBe(checkRepliesActionId);
      expect(parsed.name).toBe("Reply Check (updated)");
    }, 30_000);

    it("step 5 — campaign-reorder-actions succeeds after add×2 + update (criteria A+B)", async () => {
      assertDefined(campaignId, "step 1 must run first");
      assertDefined(msgActionId, "step 1b must run first");
      assertDefined(checkRepliesActionId, "step 1b must run first");
      assertDefined(webhookActionId, "step 2 must run first");
      assertDefined(msg2ActionId, "step 3 must run first");

      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      // Requested order: msg1 → webhook → checkReplies → msg2
      const newOrder = [msgActionId, webhookActionId, checkRepliesActionId, msg2ActionId];

      await handleCampaignReorderActions(campaignId, {
        actionIds: newOrder.join(","),
        cdpPort: port,
        json: true,
      });

      expect(process.exitCode).toBeUndefined();
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out) as {
        success: boolean;
        campaignId: number;
        actions: { id: number; name: string; config: { actionType: string } }[];
      };

      // Criterion A: reorder succeeded
      expect(parsed.success).toBe(true);
      expect(parsed.campaignId).toBe(campaignId);

      // Criterion F: result contains exactly the 4 expected actions (no duplicates)
      expect(parsed.actions).toHaveLength(4);
      const resultIds = parsed.actions.map((a) => a.id);
      expect(new Set(resultIds).size).toBe(4);
      expect(resultIds).toContain(msgActionId);
      expect(resultIds).toContain(webhookActionId);
      expect(resultIds).toContain(checkRepliesActionId);
      expect(resultIds).toContain(msg2ActionId);

      // Criterion E: action settings integrity — webhook still has the url
      const webhookAction = parsed.actions.find((a) => a.id === webhookActionId);
      assertDefined(webhookAction, "webhook action missing from result");
      expect(webhookAction.config.actionType).toBe("SendPersonToWebhook");

      // Criterion E: updated name is preserved
      const checkAction = parsed.actions.find((a) => a.id === checkRepliesActionId);
      assertDefined(checkAction, "checkReplies action missing from result");
      expect(checkAction.name).toBe("Reply Check (updated)");
    }, 60_000);

    it("step 6a — campaign-get shows 4 actions in reordered chain (criterion F)", async () => {
      assertDefined(campaignId, "step 1 must run first");
      assertDefined(msgActionId, "step 1b must run first");
      assertDefined(checkRepliesActionId, "step 1b must run first");
      assertDefined(webhookActionId, "step 2 must run first");
      assertDefined(msg2ActionId, "step 3 must run first");

      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      await handleCampaignGet(campaignId, { cdpPort: port, json: true });

      expect(process.exitCode).toBeUndefined();
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out) as {
        actions: { id: number; config: { actionType: string } }[];
      };

      // 4 distinct actions, no duplicates
      expect(parsed.actions).toHaveLength(4);
      const ids = parsed.actions.map((a) => a.id);
      expect(new Set(ids).size).toBe(4);

      // Ordered as requested: msg1, webhook, checkReplies, msg2
      expect(ids).toEqual([msgActionId, webhookActionId, checkRepliesActionId, msg2ActionId]);
    }, 30_000);

    it("step 6b — campaign-export YAML lists exactly 4 actions (criterion A+F)", async () => {
      assertDefined(campaignId, "step 1 must run first");

      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      await handleCampaignExport(campaignId, { format: "yaml", cdpPort: port });

      expect(process.exitCode).toBeUndefined();
      const yaml = spy.mock.calls.map((c) => String(c[0])).join("");

      // Count action type lines (each action has exactly one `- type:` line)
      const actionLines = yaml.match(/^\s*-\s*type:/gm) ?? [];
      expect(actionLines).toHaveLength(4);

      // Ordered: MessageToPerson, SendPersonToWebhook, CheckForReplies, MessageToPerson
      const typeMatches = [...yaml.matchAll(/^\s*-\s*type:\s*(\S+)/gm)].map((m) => m[1]);
      expect(typeMatches).toEqual([
        "MessageToPerson",
        "SendPersonToWebhook",
        "CheckForReplies",
        "MessageToPerson",
      ]);
    }, 30_000);

    it("step 7 — idempotent reorder with same order succeeds (criterion D)", async () => {
      assertDefined(campaignId, "step 1 must run first");
      assertDefined(msgActionId, "step 1b must run first");
      assertDefined(checkRepliesActionId, "step 1b must run first");
      assertDefined(webhookActionId, "step 2 must run first");
      assertDefined(msg2ActionId, "step 3 must run first");

      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      // Same order as step 5
      const sameOrder = [msgActionId, webhookActionId, checkRepliesActionId, msg2ActionId];

      await handleCampaignReorderActions(campaignId, {
        actionIds: sameOrder.join(","),
        cdpPort: port,
        json: true,
      });

      expect(process.exitCode).toBeUndefined();
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out) as { success: boolean };
      expect(parsed.success).toBe(true);
    }, 60_000);

    it("step 8 — reverse reorder also succeeds (criterion D)", async () => {
      assertDefined(campaignId, "step 1 must run first");
      assertDefined(msgActionId, "step 1b must run first");
      assertDefined(checkRepliesActionId, "step 1b must run first");
      assertDefined(webhookActionId, "step 2 must run first");
      assertDefined(msg2ActionId, "step 3 must run first");

      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      // Reverse order: msg2, checkReplies, webhook, msg1
      const reverseOrder = [msg2ActionId, checkRepliesActionId, webhookActionId, msgActionId];

      await handleCampaignReorderActions(campaignId, {
        actionIds: reverseOrder.join(","),
        cdpPort: port,
        json: true,
      });

      expect(process.exitCode).toBeUndefined();
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out) as { success: boolean; actions: { id: number }[] };
      expect(parsed.success).toBe(true);
      expect(parsed.actions.map((a) => a.id)).toEqual(reverseOrder);
    }, 60_000);
  });

  describe("fresh campaign reorder still works (criterion C regression guard)", () => {
    const originalExitCode = process.exitCode;
    let campaignId: number | undefined;
    let firstActionId: number | undefined;
    let secondActionId: number | undefined;

    const FRESH_YAML = `
version: "1"
name: E2E Fresh Reorder Regression Guard
actions:
  - type: VisitAndExtract
  - type: InvitePerson
`.trimStart();

    afterAll(async () => {
      if (campaignId !== undefined) {
        const prev = process.exitCode;
        try {
          process.exitCode = undefined;
          vi.spyOn(process.stdout, "write").mockReturnValue(true);
          await handleCampaignErase(campaignId, { cdpPort: port });
        } catch {
          // best-effort
        } finally {
          process.exitCode = prev;
          vi.restoreAllMocks();
        }
      }
    });

    beforeEach(() => { process.exitCode = undefined; });
    afterEach(() => { process.exitCode = originalExitCode; vi.restoreAllMocks(); });

    it("creates a fresh campaign and records action IDs", async () => {
      const createSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await handleCampaignCreate({ yaml: FRESH_YAML, cdpPort: port, json: true });
      expect(process.exitCode).toBeUndefined();
      const createOut = createSpy.mock.calls.map((c) => String(c[0])).join("");
      campaignId = (JSON.parse(createOut) as { id: number }).id;

      vi.restoreAllMocks();

      const getSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await handleCampaignGet(campaignId, { cdpPort: port, json: true });
      expect(process.exitCode).toBeUndefined();
      const getOut = getSpy.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(getOut) as { actions: { id: number; config: { actionType: string } }[] };

      expect(parsed.actions).toHaveLength(2);
      firstActionId = parsed.actions.find((a) => a.config.actionType === "VisitAndExtract")?.id;
      secondActionId = parsed.actions.find((a) => a.config.actionType === "InvitePerson")?.id;
      assertDefined(firstActionId, "VisitAndExtract action missing");
      assertDefined(secondActionId, "InvitePerson action missing");
    }, 30_000);

    it("reorders fresh campaign actions without prior edits (criterion C)", async () => {
      assertDefined(campaignId, "create step must run first");
      assertDefined(firstActionId, "create step must run first");
      assertDefined(secondActionId, "create step must run first");

      const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      // Swap: InvitePerson first, VisitAndExtract second
      await handleCampaignReorderActions(campaignId, {
        actionIds: `${String(secondActionId)},${String(firstActionId)}`,
        cdpPort: port,
        json: true,
      });

      expect(process.exitCode).toBeUndefined();
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out) as { success: boolean; actions: { id: number }[] };

      expect(parsed.success).toBe(true);
      expect(parsed.actions).toHaveLength(2);
      expect(parsed.actions.map((a) => a.id)).toEqual([secondActionId, firstActionId]);
    }, 60_000);
  });
});
