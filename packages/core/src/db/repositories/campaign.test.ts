// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DatabaseClient } from "../client.js";
import {
  ActionNotFoundError,
  CampaignNotFoundError,
  NoNextActionError,
} from "../errors.js";
import { openFixture } from "../testing/open-fixture.js";
import { CampaignRepository } from "./campaign.js";

describe("CampaignRepository", () => {
  let db: DatabaseSync;
  let client: DatabaseClient;
  let repo: CampaignRepository;

  beforeEach(() => {
    db = openFixture();
    client = { db } as DatabaseClient;
    repo = new CampaignRepository(client);
  });

  afterEach(() => {
    db.close();
  });

  describe("listCampaigns", () => {
    it("returns non-archived campaigns by default", () => {
      const campaigns = repo.listCampaigns();

      // Should not include archived campaign (id=3)
      expect(campaigns).toHaveLength(4);
      expect(campaigns.map((c) => c.id)).not.toContain(3);
    });

    it("includes archived campaigns when requested", () => {
      const campaigns = repo.listCampaigns({ includeArchived: true });

      expect(campaigns).toHaveLength(5);
      expect(campaigns.map((c) => c.id)).toContain(3);
    });

    it("returns correct campaign summary fields", () => {
      const campaigns = repo.listCampaigns({ includeArchived: true });
      const outreach = campaigns.find((c) => c.id === 1);

      expect(outreach).toBeDefined();
      expect(outreach).toMatchObject({
        name: "Outreach Campaign",
        description: "Test outreach campaign",
        state: "active",
        liAccountId: 1,
        actionCount: 1,
      });
      expect(outreach?.createdAt).toBeDefined();
    });

    it("derives correct state for different campaigns", () => {
      const campaigns = repo.listCampaigns({ includeArchived: true });

      const stateById = new Map(campaigns.map((c) => [c.id, c.state]));
      expect(stateById.get(1)).toBe("active");
      expect(stateById.get(2)).toBe("paused");
      expect(stateById.get(3)).toBe("archived");
      expect(stateById.get(4)).toBe("invalid");
    });

    it("returns campaigns ordered by created_at descending", () => {
      const campaigns = repo.listCampaigns();

      // Most recent first
      const ids = campaigns.map((c) => c.id);
      expect(ids.at(0)).toBe(1); // 2025-01-15
      expect(ids.at(1)).toBe(2); // 2025-01-14
    });
  });

  describe("getCampaign", () => {
    it("returns a fully populated campaign", () => {
      const campaign = repo.getCampaign(1);

      expect(campaign.id).toBe(1);
      expect(campaign.name).toBe("Outreach Campaign");
      expect(campaign.description).toBe("Test outreach campaign");
      expect(campaign.state).toBe("active");
      expect(campaign.liAccountId).toBe(1);
      expect(campaign.isPaused).toBe(false);
      expect(campaign.isArchived).toBe(false);
      expect(campaign.isValid).toBe(true);
      expect(campaign.createdAt).toBeDefined();
    });

    it("throws CampaignNotFoundError for missing campaign", () => {
      expect(() => repo.getCampaign(999)).toThrow(CampaignNotFoundError);
      expect(() => repo.getCampaign(999)).toThrow(
        "Campaign not found for id 999",
      );
    });

    it("handles paused campaign", () => {
      const campaign = repo.getCampaign(2);

      expect(campaign.state).toBe("paused");
      expect(campaign.isPaused).toBe(true);
    });

    it("handles archived campaign", () => {
      const campaign = repo.getCampaign(3);

      expect(campaign.state).toBe("archived");
      expect(campaign.isArchived).toBe(true);
    });

    it("handles invalid campaign", () => {
      const campaign = repo.getCampaign(4);

      expect(campaign.state).toBe("invalid");
      expect(campaign.isValid).toBe(false);
    });
  });

  describe("getCampaignActions", () => {
    it("returns all actions for a campaign", () => {
      const actions = repo.getCampaignActions(1);

      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        id: 1,
        campaignId: 1,
        name: "Send Welcome Message",
        description: "First touch message",
        versionId: 1,
      });
    });

    it("returns action config with parsed settings", () => {
      const actions = repo.getCampaignActions(1);
      expect(actions).toHaveLength(1);
      const action = actions.at(0);
      expect(action).toBeDefined();

      expect(action?.config.id).toBe(1);
      expect(action?.config.actionType).toBe("MessageToPerson");
      expect(action?.config.coolDown).toBe(60000);
      expect(action?.config.maxActionResultsPerIteration).toBe(10);
      expect(action?.config.isDraft).toBe(false);
      expect(action?.config.actionSettings).toHaveProperty("messageTemplate");
    });

    it("throws CampaignNotFoundError for missing campaign", () => {
      expect(() => repo.getCampaignActions(999)).toThrow(CampaignNotFoundError);
    });

    it("returns empty array for campaign with no actions", () => {
      const actions = repo.getCampaignActions(3);
      expect(actions).toHaveLength(0);
    });
  });

  describe("getResults", () => {
    it("returns action results for a campaign", () => {
      const results = repo.getResults(1);

      expect(results).toHaveLength(4);
      const result = results.find((r) => r.id === 1);
      expect(result).toBeDefined();
      expect(result).toMatchObject({
        id: 1,
        actionVersionId: 1,
        personId: 1,
        result: 1,
        platform: "LINKEDIN",
      });
      expect(result?.createdAt).toBeDefined();
    });

    it("includes profile data from person_mini_profile and person_current_position", () => {
      const results = repo.getResults(1);

      // Person 1 (Ada Lovelace): full profile
      const ada = results.find((r) => r.personId === 1);
      expect(ada?.profile).toEqual({
        firstName: "Ada",
        lastName: "Lovelace",
        headline: "Principal Analytical Engine Programmer",
        company: "Babbage Industries",
        title: "Lead Programmer",
      });

      // Person 2 (Charlie): mini_profile only, no current position
      const charlie = results.find((r) => r.personId === 2);
      expect(charlie?.profile).toEqual({
        firstName: "Charlie",
        lastName: null,
        headline: null,
        company: null,
        title: null,
      });

      // Person 3 (Grace Hopper): full profile
      const grace = results.find((r) => r.personId === 3);
      expect(grace?.profile).toEqual({
        firstName: "Grace",
        lastName: "Hopper",
        headline: "Compiler Pioneer at COBOL Systems",
        company: "COBOL Systems Inc",
        title: "Distinguished Engineer",
      });
    });

    it("returns null profile when person has no mini_profile", () => {
      // Insert a person without mini_profile
      db.exec(`
        INSERT INTO people (id, original_id) VALUES (99, 99);
        INSERT INTO action_results (action_version_id, person_id, result, platform, created_at)
        VALUES (1, 99, 1, 'LINKEDIN', '2025-01-16T00:00:00.000Z');
      `);

      const results = repo.getResults(1);
      const orphan = results.find((r) => r.personId === 99);
      expect(orphan?.profile).toBeNull();
    });

    it("respects limit parameter", () => {
      const results = repo.getResults(1, { limit: 1 });
      expect(results).toHaveLength(1);
    });

    it("throws CampaignNotFoundError for missing campaign", () => {
      expect(() => repo.getResults(999)).toThrow(CampaignNotFoundError);
    });

    it("returns empty array for campaign with no results", () => {
      const results = repo.getResults(2);
      expect(results).toHaveLength(0);
    });
  });

  describe("getCampaignState", () => {
    it("returns active state for active campaign", () => {
      const state = repo.getCampaignState(1);
      expect(state).toBe("active");
    });

    it("returns paused state for paused campaign", () => {
      const state = repo.getCampaignState(2);
      expect(state).toBe("paused");
    });

    it("returns archived state for archived campaign", () => {
      const state = repo.getCampaignState(3);
      expect(state).toBe("archived");
    });

    it("returns invalid state for invalid campaign", () => {
      const state = repo.getCampaignState(4);
      expect(state).toBe("invalid");
    });

    it("throws CampaignNotFoundError for missing campaign", () => {
      expect(() => repo.getCampaignState(999)).toThrow(CampaignNotFoundError);
    });
  });

  describe("fixIsValid", () => {
    it("sets is_valid to 1 for a campaign with NULL is_valid", () => {
      // Insert a campaign with is_valid = NULL (as created by the API)
      db.exec(
        `INSERT INTO campaigns (id, name, type, is_valid, li_account_id)
         VALUES (99, 'API-Created Campaign', 1, NULL, 1)`,
      );

      const before = repo.getCampaign(99);
      expect(before.isValid).toBeNull();
      expect(before.state).toBe("active");

      repo.fixIsValid(99);

      const after = repo.getCampaign(99);
      expect(after.isValid).toBe(true);
      expect(after.state).toBe("active");
    });

    it("sets is_valid to 1 for a campaign with is_valid = 0", () => {
      const before = repo.getCampaign(4);
      expect(before.isValid).toBe(false);

      repo.fixIsValid(4);

      const after = repo.getCampaign(4);
      expect(after.isValid).toBe(true);
    });
  });

  describe("createActionExcludeLists", () => {
    it("creates exclude list chain for each action", () => {
      // Campaign 2 has one action (id=2) with action_version (id=2)
      // Verify no exclude_list_id initially
      const before = db
        .prepare(
          "SELECT exclude_list_id FROM action_versions WHERE action_id = 2",
        )
        .all() as Array<{ exclude_list_id: number | null }>;
      expect(before[0]?.exclude_list_id).toBeNull();

      repo.createActionExcludeLists(2, 1);

      // Verify exclude_list_id is now set
      const after = db
        .prepare(
          "SELECT exclude_list_id FROM action_versions WHERE action_id = 2",
        )
        .all() as Array<{ exclude_list_id: number | null }>;
      expect(after[0]?.exclude_list_id).not.toBeNull();

      // Verify the chain: action_versions.exclude_list_id -> CPV -> collection
      const cpvId = after.at(0)?.exclude_list_id;
      expect(cpvId).toBeDefined();

      const cpv = db
        .prepare(
          "SELECT id, collection_id, version_operation_status FROM collection_people_versions WHERE id = ?",
        )
        .get(cpvId as number) as {
        id: number;
        collection_id: number;
        version_operation_status: string;
      };
      expect(cpv).toBeDefined();
      expect(cpv.version_operation_status).toBe("addToTarget");

      const collection = db
        .prepare(
          "SELECT id, li_account_id FROM collections WHERE id = ?",
        )
        .get(cpv.collection_id) as { id: number; li_account_id: number };
      expect(collection).toBeDefined();
      expect(collection.li_account_id).toBe(1);
    });

    it("creates separate exclude lists per action", () => {
      // Add a second action to campaign 1
      db.exec(`
        INSERT INTO action_configs (id, actionType, coolDown, maxActionResultsPerIteration, isDraft)
        VALUES (99, 'VisitAndExtract', 60000, 10, 0);
        INSERT INTO actions (id, campaign_id, name)
        VALUES (99, 1, 'Second Action');
        INSERT INTO action_versions (id, action_id, config_id)
        VALUES (99, 99, 99);
      `);

      repo.createActionExcludeLists(1, 1);

      // Both actions should have distinct exclude_list_ids
      const av1 = db
        .prepare(
          "SELECT exclude_list_id FROM action_versions WHERE action_id = 1",
        )
        .get() as { exclude_list_id: number };
      const av99 = db
        .prepare(
          "SELECT exclude_list_id FROM action_versions WHERE action_id = 99",
        )
        .get() as { exclude_list_id: number };

      expect(av1.exclude_list_id).not.toBeNull();
      expect(av99.exclude_list_id).not.toBeNull();
      expect(av1.exclude_list_id).not.toBe(av99.exclude_list_id);
    });

    it("handles campaign with no actions", () => {
      // Campaign 3 has no actions
      expect(() => repo.createActionExcludeLists(3, 1)).not.toThrow();
    });

    it("throws CampaignNotFoundError for missing campaign", () => {
      expect(() => repo.createActionExcludeLists(999, 1)).toThrow(
        CampaignNotFoundError,
      );
    });

    it("uses the provided liAccountId for collections", () => {
      repo.createActionExcludeLists(1, 2);

      const av = db
        .prepare(
          "SELECT exclude_list_id FROM action_versions WHERE action_id = 1",
        )
        .get() as { exclude_list_id: number };

      const cpv = db
        .prepare(
          "SELECT collection_id FROM collection_people_versions WHERE id = ?",
        )
        .get(av.exclude_list_id) as { collection_id: number };

      const collection = db
        .prepare("SELECT li_account_id FROM collections WHERE id = ?")
        .get(cpv.collection_id) as { li_account_id: number };

      expect(collection.li_account_id).toBe(2);
    });
  });

  describe("updateCampaign", () => {
    it("updates campaign name", () => {
      const updated = repo.updateCampaign(1, { name: "New Name" });

      expect(updated.id).toBe(1);
      expect(updated.name).toBe("New Name");
      expect(updated.description).toBe("Test outreach campaign");
    });

    it("updates campaign description", () => {
      const updated = repo.updateCampaign(1, {
        description: "New description",
      });

      expect(updated.id).toBe(1);
      expect(updated.name).toBe("Outreach Campaign");
      expect(updated.description).toBe("New description");
    });

    it("clears campaign description with null", () => {
      const updated = repo.updateCampaign(1, { description: null });

      expect(updated.id).toBe(1);
      expect(updated.description).toBeNull();
    });

    it("updates both name and description", () => {
      const updated = repo.updateCampaign(1, {
        name: "Updated",
        description: "Updated desc",
      });

      expect(updated.name).toBe("Updated");
      expect(updated.description).toBe("Updated desc");
    });

    it("returns unchanged campaign when no fields provided", () => {
      const updated = repo.updateCampaign(1, {});

      expect(updated.name).toBe("Outreach Campaign");
      expect(updated.description).toBe("Test outreach campaign");
    });

    it("throws CampaignNotFoundError for missing campaign", () => {
      expect(() => repo.updateCampaign(999, { name: "X" })).toThrow(
        CampaignNotFoundError,
      );
    });

    it("preserves other campaign fields", () => {
      const before = repo.getCampaign(1);
      const updated = repo.updateCampaign(1, { name: "Changed" });

      expect(updated.state).toBe(before.state);
      expect(updated.liAccountId).toBe(before.liAccountId);
      expect(updated.isPaused).toBe(before.isPaused);
      expect(updated.isArchived).toBe(before.isArchived);
      expect(updated.isValid).toBe(before.isValid);
      expect(updated.createdAt).toBe(before.createdAt);
    });
  });

  describe("moveToNextAction", () => {
    // Campaign 5 has 3 actions: action 5 (VisitAndExtract) -> action 6 (Waiter) -> action 7 (InvitePerson)
    // Person 1 is queued (state=1) in action 5, person 3 is processed (state=2) in action 5

    it("moves person from current action to next action", () => {
      const result = repo.moveToNextAction(5, 5, [1]);

      expect(result.nextActionId).toBe(6);

      // Person 1 should be marked successful (state=3) in action 5
      const currentTarget = db
        .prepare(
          "SELECT state FROM action_target_people WHERE action_id = 5 AND person_id = 1",
        )
        .get() as { state: number };
      expect(currentTarget.state).toBe(3);

      // Person 1 should be queued (state=1) in action 6
      const nextTarget = db
        .prepare(
          "SELECT state FROM action_target_people WHERE action_id = 6 AND person_id = 1",
        )
        .get() as { state: number };
      expect(nextTarget.state).toBe(1);
    });

    it("moves person from middle action to last action", () => {
      // First insert person 1 into action 6 (middle) so we can move to action 7
      db.exec(
        `INSERT INTO action_target_people (action_id, action_version_id, person_id, state, li_account_id, created_at)
         VALUES (6, 6, 1, 2, 1, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'NOW'))`,
      );

      const result = repo.moveToNextAction(5, 6, [1]);

      expect(result.nextActionId).toBe(7);

      // Person 1 should be marked successful (state=3) in action 6
      const currentTarget = db
        .prepare(
          "SELECT state FROM action_target_people WHERE action_id = 6 AND person_id = 1",
        )
        .get() as { state: number };
      expect(currentTarget.state).toBe(3);

      // Person 1 should be queued (state=1) in action 7
      const nextTarget = db
        .prepare(
          "SELECT state FROM action_target_people WHERE action_id = 7 AND person_id = 1",
        )
        .get() as { state: number };
      expect(nextTarget.state).toBe(1);
    });

    it("handles multiple persons in a single move", () => {
      const result = repo.moveToNextAction(5, 5, [1, 3]);

      expect(result.nextActionId).toBe(6);

      // Both persons should be successful in action 5
      const targets = db
        .prepare(
          "SELECT person_id, state FROM action_target_people WHERE action_id = 5",
        )
        .all() as Array<{ person_id: number; state: number }>;
      const stateByPerson = new Map(targets.map((t) => [t.person_id, t.state]));
      expect(stateByPerson.get(1)).toBe(3);
      expect(stateByPerson.get(3)).toBe(3);

      // Both should be queued in action 6
      const nextTargets = db
        .prepare(
          "SELECT person_id, state FROM action_target_people WHERE action_id = 6",
        )
        .all() as Array<{ person_id: number; state: number }>;
      expect(nextTargets).toHaveLength(2);
      const nextStateByPerson = new Map(
        nextTargets.map((t) => [t.person_id, t.state]),
      );
      expect(nextStateByPerson.get(1)).toBe(1);
      expect(nextStateByPerson.get(3)).toBe(1);
    });

    it("requeues person already in next action target list", () => {
      // Insert person 1 into action 6 with state=2 (already processed)
      db.exec(
        `INSERT INTO action_target_people (action_id, action_version_id, person_id, state, li_account_id, created_at)
         VALUES (6, 6, 1, 2, 1, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'NOW'))`,
      );

      repo.moveToNextAction(5, 5, [1]);

      // Person 1 should be requeued (state=1) in action 6
      const target = db
        .prepare(
          "SELECT state FROM action_target_people WHERE action_id = 6 AND person_id = 1",
        )
        .get() as { state: number };
      expect(target.state).toBe(1);
    });

    it("throws NoNextActionError for last action", () => {
      expect(() => repo.moveToNextAction(5, 7, [1])).toThrow(NoNextActionError);
    });

    it("throws ActionNotFoundError for invalid action", () => {
      expect(() => repo.moveToNextAction(5, 999, [1])).toThrow(
        ActionNotFoundError,
      );
    });

    it("throws CampaignNotFoundError for missing campaign", () => {
      expect(() => repo.moveToNextAction(999, 5, [1])).toThrow(
        CampaignNotFoundError,
      );
    });

    it("handles empty person list gracefully", () => {
      const result = repo.moveToNextAction(5, 5, []);
      expect(result.nextActionId).toBe(0);
    });
  });

  describe("addAction", () => {
    it("creates action with correct fields", () => {
      const action = repo.addAction(1, {
        name: "New Action",
        actionType: "InvitePerson",
        actionSettings: { note: "hi" },
        coolDown: 30_000,
        maxActionResultsPerIteration: 5,
      }, 1);

      expect(action.id).toBeGreaterThan(0);
      expect(action.campaignId).toBe(1);
      expect(action.name).toBe("New Action");
      expect(action.config.actionType).toBe("InvitePerson");
      expect(action.config.coolDown).toBe(30_000);
      expect(action.config.maxActionResultsPerIteration).toBe(5);
      expect(action.config.actionSettings).toEqual({ note: "hi" });
      expect(action.config.isDraft).toBe(false);
    });

    it("appends action to campaign and getCampaignActions returns it once (no duplicate)", () => {
      // Campaign 1 initially has 1 action
      const before = repo.getCampaignActions(1);
      expect(before).toHaveLength(1);

      // addAction creates 2 action_versions internally; getCampaignActions must
      // deduplicate and return exactly 2 total (original + new), not 3.
      repo.addAction(1, { name: "Extra", actionType: "VisitAndExtract" }, 1);

      const after = repo.getCampaignActions(1);
      expect(after).toHaveLength(2);
    });

    it("returns versionId equal to MAX(action_versions.id) — consistent with getCampaignActions", () => {
      const action = repo.addAction(1, { name: "V", actionType: "InvitePerson" }, 1);

      const rows = db
        .prepare("SELECT id FROM action_versions WHERE action_id = ? ORDER BY id")
        .all(action.id) as { id: number }[];

      // addAction creates two action_versions rows; versionId must be the MAX (second) id
      // so it matches what getCampaignActions returns via its MAX(av2.id) subquery.
      expect(rows).toHaveLength(2);
      expect(action.versionId).toBe(rows[1]?.id);
    });

    it("defaults coolDown and maxActionResultsPerIteration", () => {
      const action = repo.addAction(1, { name: "Min", actionType: "InvitePerson" }, 1);

      expect(action.config.coolDown).toBe(60_000);
      expect(action.config.maxActionResultsPerIteration).toBe(10);
    });

    it("sets description to null when not provided", () => {
      const action = repo.addAction(1, { name: "ND", actionType: "InvitePerson" }, 1);
      expect(action.description).toBeNull();
    });

    it("stores provided description", () => {
      const action = repo.addAction(1, {
        name: "WD",
        actionType: "InvitePerson",
        description: "my desc",
      }, 1);
      expect(action.description).toBe("my desc");
    });

    it("throws CampaignNotFoundError for missing campaign", () => {
      expect(() =>
        repo.addAction(999, { name: "X", actionType: "InvitePerson" }, 1),
      ).toThrow(CampaignNotFoundError);
    });

    it("creating multiple actions keeps getCampaignActions count correct", () => {
      repo.addAction(1, { name: "A1", actionType: "InvitePerson" }, 1);
      repo.addAction(1, { name: "A2", actionType: "VisitAndExtract" }, 1);

      const actions = repo.getCampaignActions(1);
      // Original 1 + 2 new = 3, no duplicates
      expect(actions).toHaveLength(3);
    });
  });

  describe("updateAction", () => {
    it("updates action name", () => {
      const updated = repo.updateAction(1, 1, { name: "Renamed" });

      expect(updated.id).toBe(1);
      expect(updated.name).toBe("Renamed");
    });

    it("updates action description", () => {
      const updated = repo.updateAction(1, 1, { description: "new desc" });
      expect(updated.description).toBe("new desc");
    });

    it("clears description with null", () => {
      const updated = repo.updateAction(1, 1, { description: null });
      expect(updated.description).toBeNull();
    });

    it("updates coolDown", () => {
      const updated = repo.updateAction(1, 1, { coolDown: 120_000 });
      expect(updated.config.coolDown).toBe(120_000);
    });

    it("updates maxActionResultsPerIteration", () => {
      const updated = repo.updateAction(1, 1, { maxActionResultsPerIteration: 20 });
      expect(updated.config.maxActionResultsPerIteration).toBe(20);
    });

    it("merges actionSettings (provided keys override, others preserved)", () => {
      // action 1 has a messageTemplate setting
      const existing = repo.getCampaignActions(1);
      const original = existing[0]?.config.actionSettings as Record<string, unknown>;
      expect(original).toHaveProperty("messageTemplate");

      const updated = repo.updateAction(1, 1, {
        actionSettings: { newKey: "value" },
      });
      expect(updated.config.actionSettings).toHaveProperty("messageTemplate");
      expect(updated.config.actionSettings).toHaveProperty("newKey", "value");
    });

    it("does not update versionId (updateAction does not create new action_versions)", () => {
      const before = repo.getCampaignActions(1);
      const versionIdBefore = before[0]?.versionId;

      repo.updateAction(1, 1, { name: "X" });

      const after = repo.getCampaignActions(1);
      expect(after[0]?.versionId).toBe(versionIdBefore);
    });

    it("throws CampaignNotFoundError for missing campaign", () => {
      expect(() => repo.updateAction(999, 1, { name: "X" })).toThrow(
        CampaignNotFoundError,
      );
    });

    it("throws ActionNotFoundError for action not in campaign", () => {
      expect(() => repo.updateAction(1, 999, { name: "X" })).toThrow(
        ActionNotFoundError,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Real-schema tests: in-memory DB with campaign_version_actions
  //
  // The fixture.db lacks campaign_version_actions (and the related VIEWs),
  // so all tests above exercise only the fallback ORDER-BY-a.id path.
  // The describe block below builds a minimal schema that matches the real
  // LH DDL and proves the PRIMARY path (the campaign_version_actions branch):
  //   • getCampaignActions uses the version-ordered query (not the fallback)
  //   • addAction creates a new campaign_versions row and the matching
  //     campaign_version_actions rows (preserving prior order + appending)
  //   • no action is duplicated after addAction
  // -----------------------------------------------------------------------
  describe("real-schema (with campaign_version_actions)", () => {
    let fullDb: DatabaseSync;
    let fullRepo: CampaignRepository;

    beforeEach(() => {
      // Start from the fixture (complete real schema + data) and add
      // campaign_version_actions so the primary query branch is selected.
      fullDb = openFixture();
      fullDb.exec(`
        CREATE TABLE campaign_version_actions (
          id         INTEGER PRIMARY KEY,
          version_id INTEGER NOT NULL REFERENCES campaign_versions(id),
          action_id  INTEGER NOT NULL REFERENCES actions(id),
          UNIQUE(version_id, action_id)
        );
      `);
      // Populate cva for the two pre-existing campaign_versions rows:
      //   id=1 → campaign 1 / action 1
      //   id=2 → campaign 5 / actions 5, 6, 7
      fullDb.exec(`
        INSERT INTO campaign_version_actions (version_id, action_id) VALUES (1, 1);
        INSERT INTO campaign_version_actions (version_id, action_id) VALUES (2, 5), (2, 6), (2, 7);
      `);
      // Constructing AFTER table creation ensures the primary branch runs.
      fullRepo = new CampaignRepository({ db: fullDb } as DatabaseClient);
    });

    afterEach(() => {
      fullDb.close();
    });

    /** Seed two pre-existing actions with a campaign_version tracking them. */
    it("getCampaignActions uses version-ordered path (no fallback) and deduplicates", () => {
      // Campaign 5 has 3 actions; fixture has ONE action_versions per action
      // (unlike real LH which has TWO), so dedup is a no-op here — the key
      // is that the primary branch ran.
      const actions = fullRepo.getCampaignActions(5);
      expect(actions).toHaveLength(3);
      // cva rows for version 2: (action 5, id auto), (action 6, id auto), (action 7, id auto)
      expect(actions.map((a) => a.id)).toEqual([5, 6, 7]);
    });

    it("getCampaignActions respects campaign_version_actions ordering (not a.id)", () => {
      // Insert a new version for campaign 5 with actions in reverse id order.
      fullDb.exec(`
        INSERT INTO campaign_versions (id, campaign_id) VALUES (99, 5);
        INSERT INTO campaign_version_actions (id, version_id, action_id)
          VALUES (1000, 99, 7), (1001, 99, 6), (1002, 99, 5);
      `);
      // Re-create repo so MAX(campaign_versions.id) = 99 is the last version.
      const testRepo = new CampaignRepository({ db: fullDb } as DatabaseClient);

      const actions = testRepo.getCampaignActions(5);
      // cva.id order: 7 (cva=1000), 6 (cva=1001), 5 (cva=1002)
      expect(actions.map((a) => a.id)).toEqual([7, 6, 5]);
    });

    it("addAction creates a new campaign_versions row", () => {
      // Campaign 1 already has campaign_versions id=1.
      const versionsBefore = fullDb
        .prepare("SELECT id FROM campaign_versions WHERE campaign_id = 1 ORDER BY id")
        .all() as { id: number }[];
      expect(versionsBefore).toHaveLength(1);
      const priorId = versionsBefore[0]?.id ?? 0;

      fullRepo.addAction(1, { name: "New", actionType: "InvitePerson" }, 1);

      const versionsAfter = fullDb
        .prepare("SELECT id FROM campaign_versions WHERE campaign_id = 1 ORDER BY id")
        .all() as { id: number }[];
      expect(versionsAfter).toHaveLength(2);
      expect(versionsAfter[1]?.id ?? 0).toBeGreaterThan(priorId);
    });

    it("addAction copies prior campaign_version_actions then appends the new action", () => {
      // Campaign 1 / version 1 has action 1 in cva.
      const newAction = fullRepo.addAction(1, { name: "Second", actionType: "InvitePerson" }, 1);

      const newVersion = fullDb
        .prepare("SELECT id FROM campaign_versions WHERE campaign_id = 1 ORDER BY id DESC LIMIT 1")
        .get() as { id: number };

      const cvaRows = fullDb
        .prepare("SELECT action_id FROM campaign_version_actions WHERE version_id = ? ORDER BY id")
        .all(newVersion.id) as { action_id: number }[];

      // Prior action (1) copied first, new action appended last.
      expect(cvaRows.map((r) => r.action_id)).toEqual([1, newAction.id]);
    });

    it("addAction on a campaign with no prior version creates a version with only the new action", () => {
      // Campaign 2 (paused) has no campaign_versions row in the fixture.
      const newAction = fullRepo.addAction(2, { name: "First", actionType: "MessageToPerson" }, 1);

      const newVersion = fullDb
        .prepare("SELECT id FROM campaign_versions WHERE campaign_id = 2 ORDER BY id DESC LIMIT 1")
        .get() as { id: number } | undefined;
      expect(newVersion).toBeDefined();

      const cvaRows = fullDb
        .prepare("SELECT action_id FROM campaign_version_actions WHERE version_id = ?")
        .all((newVersion as { id: number }).id) as { action_id: number }[];

      expect(cvaRows).toHaveLength(1);
      expect(cvaRows[0]?.action_id).toBe(newAction.id);
    });

    it("getCampaignActions after addAction returns N+1 distinct actions (no duplicate)", () => {
      // Campaign 5 starts with 3 actions; add a 4th.
      fullRepo.addAction(5, { name: "Fourth", actionType: "InvitePerson" }, 1);

      const actions = fullRepo.getCampaignActions(5);
      expect(actions).toHaveLength(4);
      expect(new Set(actions.map((a) => a.id)).size).toBe(4);
    });

    it("versionId returned by addAction equals MAX(action_versions.id) for that action", () => {
      const action = fullRepo.addAction(1, { name: "X", actionType: "MessageToPerson" }, 1);

      const maxRow = fullDb
        .prepare("SELECT MAX(id) AS max_id FROM action_versions WHERE action_id = ?")
        .get(action.id) as { max_id: number };

      expect(action.versionId).toBe(maxRow.max_id);
    });

    it("versionId from addAction matches versionId from getCampaignActions for the same action", () => {
      const added = fullRepo.addAction(1, { name: "Y", actionType: "MessageToPerson" }, 1);
      const fetched = fullRepo.getCampaignActions(1).find((a) => a.id === added.id);

      expect(fetched).toBeDefined();
      expect(added.versionId).toBe(fetched?.versionId);
    });
  });
});
