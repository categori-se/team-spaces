// @ts-check

import {createDynamoRepositoryFromEnv} from "../repositories/dynamo.js";
import {processScheduledNotificationDigests} from "../repositories/notifications.js";
import {log} from "../observability/log.js";

/**
 * Hourly EventBridge Scheduler target. Preferences are indexed by UTC delivery
 * hour, and per-period claims make Scheduler retries safe.
 * @param {{time?: string}} event
 */
export async function handler(event = {}) {
  if (!process.env.TABLE_NAME) throw new Error("TABLE_NAME is required");
  const supplied = event.time ? new Date(event.time) : new Date();
  if (Number.isNaN(supplied.getTime())) throw new Error("Scheduler time is invalid");
  const repository = createDynamoRepositoryFromEnv();
  try {
    const result = await processScheduledNotificationDigests(repository, supplied);
    log("info", "scheduled notification digest run completed", {checked: result.checked, results: result.results.length});
    return result;
  } catch (error) {
    log("error", "scheduled notification digest run failed", {errorName: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : "Unknown failure"});
    throw error;
  }
}
