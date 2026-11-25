// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import {
  CampaignExecutionError,
  CampaignNotFoundError,
  errorMessage,
  InstanceNotRunningError,
  campaignIgnoreReply,
  campaignMoveOn,
  campaignPause,
  campaignPutBack,
  campaignResume,
  campaignStandBy,
  parseCustomFields,
  personCustomFields,
  type CampaignPersonMoveOutput,
} from "@insoftex/lhremote-core";

import { resolvePersonIds } from "./person-ids.js";

/**
 * CLI handlers for the campaign flow commands the Insoftex daily script uses: move-on, ignore-reply, put-back, pause,
 * resume, stand-by and person custom fields. Each prints JSON with `--json` (what the script reads) and sets a non-zero
 * exit code when LinkedHelper did not do what was asked.
 */

interface ConnectionFlags {
  cdpPort?: number;
  cdpHost?: string;
  allowRemote?: boolean;
  accountId?: number;
  json?: boolean;
}

function connection(o: ConnectionFlags) {
  return { cdpPort: o.cdpPort, cdpHost: o.cdpHost, allowRemote: o.allowRemote, accountId: o.accountId };
}

function fail(what: string, campaignId: number | undefined, error: unknown): void {
  if (error instanceof CampaignNotFoundError && campaignId !== undefined) {
    process.stderr.write(`Campaign ${String(campaignId)} not found.\n`);
  } else if (error instanceof CampaignExecutionError) {
    process.stderr.write(`Failed to ${what}: ${error.message}\n`);
  } else if (error instanceof InstanceNotRunningError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${errorMessage(error)}\n`);
  }
  process.exitCode = 1;
}

type MoveFn = typeof campaignMoveOn;

async function handleMove(
  fn: MoveFn,
  what: string,
  campaignId: number,
  options: ConnectionFlags & { actionId: number; personIds?: string; personIdsFile?: string },
): Promise<void> {
  let personIds: number[];
  try {
    personIds = resolvePersonIds(options);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
    return;
  }
  let result: CampaignPersonMoveOutput;
  try {
    result = await fn({ campaignId, actionId: options.actionId, personIds, ...connection(options) });
  } catch (error) {
    fail(what, campaignId, error);
    return;
  }
  if (result.people.some((p) => p.outcome === "notDone")) process.exitCode = 1;
  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    `${what}: ${String(result.done)} of ${String(result.people.length)} person(s) at action ${String(result.actionId)} in campaign ${String(campaignId)}.\n`,
  );
  for (const p of result.people) {
    process.stdout.write(`  ${String(p.personId)}: ${p.outcome}${p.reason ? ` (${p.reason})` : ""}\n`);
  }
}

/** `campaign-move-on`: people whose step failed at an action go on to the next action. */
export function handleCampaignMoveOn(campaignId: number, options: Parameters<typeof handleMove>[3]): Promise<void> {
  return handleMove(campaignMoveOn, "move on", campaignId, options);
}

/** `campaign-ignore-reply`: people LinkedHelper holds because they replied go on to the next action. */
export function handleCampaignIgnoreReply(campaignId: number, options: Parameters<typeof handleMove>[3]): Promise<void> {
  return handleMove(campaignIgnoreReply, "ignore replies", campaignId, options);
}

/** `campaign-put-back`: people dropped at an excluded action are queued there again (experimental). */
export function handleCampaignPutBack(campaignId: number, options: Parameters<typeof handleMove>[3]): Promise<void> {
  return handleMove(campaignPutBack, "put back", campaignId, options);
}

function print(options: ConnectionFlags, result: object, line: string): void {
  process.stdout.write(options.json ? JSON.stringify(result, null, 2) + "\n" : `${line}\n`);
}

/** `campaign-pause`: pause one campaign alone, without stopping the account's runner. */
export async function handleCampaignPause(campaignId: number, options: ConnectionFlags): Promise<void> {
  try {
    const result = await campaignPause({ campaignId, ...connection(options) });
    print(options, result, `Campaign ${String(campaignId)} paused (the account's runner keeps running).`);
  } catch (error) {
    fail("pause the campaign", campaignId, error);
  }
}

/** `campaign-resume`: un-pause one campaign and start the account's runner (wakes every active campaign of the account). */
export async function handleCampaignResume(campaignId: number, options: ConnectionFlags & { wake?: boolean }): Promise<void> {
  try {
    const result = await campaignResume({ campaignId, wake: options.wake === true, ...connection(options) });
    print(options, result, `Campaign ${String(campaignId)} resumed; the account's runner was started.`);
  } catch (error) {
    fail("resume the campaign", campaignId, error);
  }
}

/** `campaign-stand-by`: switch a campaign's Stand by mode on or off. */
export async function handleCampaignStandBy(
  campaignId: number,
  options: ConnectionFlags & { on?: boolean; off?: boolean },
): Promise<void> {
  if (options.on === options.off) {
    process.stderr.write("Pass exactly one of --on or --off.\n");
    process.exitCode = 1;
    return;
  }
  try {
    const result = await campaignStandBy({ campaignId, on: options.on === true, ...connection(options) });
    print(options, result, `Campaign ${String(campaignId)}: Stand by ${result.standBy ? "on" : "off"}${result.isPaused ? " (paused)" : ""}.`);
  } catch (error) {
    fail("switch Stand by", campaignId, error);
  }
}

/** `person-custom-fields`: save a person's custom fields (CRM level). */
export async function handlePersonCustomFields(personId: number, options: ConnectionFlags & { set?: string[] }): Promise<void> {
  let fields: { name: string; content: string }[];
  try {
    fields = parseCustomFields(options.set ?? []);
    if (fields.length === 0) throw new Error("Pass at least one --set name=value");
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const result = await personCustomFields({ personId, fields, ...connection(options) });
    print(options, result, `Person ${String(personId)}: ${String(fields.length)} custom field(s) saved; ${String(result.stored.length)} read back.`);
  } catch (error) {
    fail("save custom fields", undefined, error);
  }
}
