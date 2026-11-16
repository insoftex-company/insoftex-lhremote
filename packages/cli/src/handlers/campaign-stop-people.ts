// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import {
  CampaignExecutionError,
  CampaignNotFoundError,
  errorMessage,
  InstanceNotRunningError,
  campaignStopPeople,
  type CampaignStopPeopleOutput,
} from "@insoftex/lhremote-core";

import { resolvePersonIds } from "./person-ids.js";

/** Handle the {@link https://github.com/insoftex-company/insoftex-lhremote#campaign-targeting | campaign-stop-people} CLI command. */
export async function handleCampaignStopPeople(
  campaignId: number,
  options: {
    personIds?: string;
    personIdsFile?: string;
    cdpPort?: number;
    cdpHost?: string;
    allowRemote?: boolean;
    accountId?: number;
    json?: boolean;
  },
): Promise<void> {
  let personIds: number[];
  try {
    personIds = resolvePersonIds(options);
  } catch (error) {
    const message = errorMessage(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  let result: CampaignStopPeopleOutput;
  try {
    result = await campaignStopPeople({
      campaignId,
      personIds,
      cdpPort: options.cdpPort,
      cdpHost: options.cdpHost,
      allowRemote: options.allowRemote,
      accountId: options.accountId,
    });
  } catch (error) {
    if (error instanceof CampaignNotFoundError) {
      process.stderr.write(`Campaign ${String(campaignId)} not found.\n`);
    } else if (error instanceof CampaignExecutionError) {
      process.stderr.write(
        `Failed to stop people: ${error.message}\n`,
      );
    } else if (error instanceof InstanceNotRunningError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      const message = errorMessage(error);
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  process.stdout.write(
    `Stopped ${String(result.stopped)} of ${String(result.people.length)} person(s) in campaign ${String(campaignId)}.\n`,
  );
  for (const person of result.people) {
    if (person.outcome === "stopped") {
      const ok =
        person.verified?.removedFromCurrentAction === true &&
        person.verified.excludedOnLaterActions;
      process.stdout.write(
        `  ${String(person.personId)}: stopped at action ${String(person.currentActionId)}, ` +
          `excluded on [${(person.excludedActionIds ?? []).join(", ")}]` +
          `${ok ? "" : " (NOT VERIFIED: check the campaign)"}\n`,
      );
      if (!ok) process.exitCode = 1;
    } else {
      process.stdout.write(`  ${String(person.personId)}: ${person.outcome}\n`);
    }
  }
}
