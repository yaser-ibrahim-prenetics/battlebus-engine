import type { PoolClient } from "pg";
import { readAliasesSQL, bindAliasSQL } from "@/lib/sql/fulfillment-actions/aliases";
import { randomUUID } from "node:crypto";
import { getDatabasePool } from "@/lib/db/database";
import {
  lockOrderSQL,
  readActionsSQL,
  reserveActionSQL,
} from "@/lib/sql/fulfillment-actions/reserve";
import { finishActionsSQL } from "@/lib/sql/fulfillment-actions/finish";
import { actionKeys, fingerprint, type ActionIdentity } from "./identity";

/** Only raise this when the provider conclusively rejected the entire action. */
export class ConfirmedActionFailure extends Error {}
export class UncertainActionError extends Error {
  constructor(public readonly keys: string[]) {
    super(`Fulfillment action requires reconciliation: ${keys.join(",")}`);
    this.name = "UncertainActionError";
  }
}

type Row<T> = {
  action_key: string;
  action_name: string;
  request_hash: string;
  attempt_id: string;
  status: "pending" | "succeeded" | "failed" | "uncertain";
  result: T | null;
};
type Reservation<T> =
  | { keys: string[]; attemptId: string; replay: false }
  | { replay: true; result: T };

async function bindAliases(client: PoolClient, identity: ActionIdentity, aliases: string[]) {
  for (const alias of aliases) {
    await client.query(bindAliasSQL, [
      identity.provider,
      identity.scope,
      identity.sourceOrderId,
      alias,
      identity.action,
    ]);
  }
}

async function reserve<T>(identity: ActionIdentity, request: unknown): Promise<Reservation<T>> {
  let keys = actionKeys(identity);
  const hash = fingerprint(request);
  const pool = await getDatabasePool();
  if (!pool) throw new Error("A database is required before executing a fulfillment action");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize overlapping batches as well as identical retries across all workers.
    await client.query(lockOrderSQL, [
      JSON.stringify([identity.provider, identity.scope, identity.sourceOrderId]),
    ]);
    // Resolve both stable source IDs and optional cross-source tracking aliases.
    // Alias bindings never change; conflicting histories require investigation.
    const aliases = [...new Set([identity.action, ...(identity.aliases || [])])];
    const known = await client.query<{ action_name: string }>(readAliasesSQL, [
      identity.provider,
      identity.scope,
      identity.sourceOrderId,
      aliases,
    ]);
    const actions = new Set(known.rows.map((row) => row.action_name));
    if (actions.size > 1) throw new UncertainActionError(keys);
    identity = { ...identity, action: known.rows[0]?.action_name || identity.action };
    keys = actionKeys(identity);
    const { rows } = await client.query<Row<T>>(readActionsSQL, [
      identity.provider,
      identity.scope,
      identity.sourceOrderId,
      identity.sourceLineIds,
      identity.action,
    ]);
    // A stable operation cannot silently become a different line batch on replay.
    if (rows.some((row) => row.action_name === identity.action && !keys.includes(row.action_key)))
      throw new UncertainActionError(keys);
    const matching = rows.filter((row) => keys.includes(row.action_key));
    if (matching.some((row) => row.status !== "failed" && row.request_hash !== hash))
      throw new UncertainActionError(keys);
    if (matching.length === keys.length && matching.every((row) => row.status === "succeeded")) {
      if (new Set(matching.map((row) => row.attempt_id)).size !== 1)
        throw new UncertainActionError(keys);
      await bindAliases(client, identity, aliases);
      await client.query("COMMIT");
      return { replay: true, result: matching[0].result as T };
    }
    // Never steal pending work, including abandoned work after a crash. A different
    // event ID must not bypass an unresolved operation on the same source lines.
    if (
      rows.some((row) => row.status === "pending" || row.status === "uncertain") ||
      (matching.length > 0 &&
        (matching.length !== keys.length || matching.some((row) => row.status !== "failed")))
    ) {
      throw new UncertainActionError(keys);
    }
    const attemptId = randomUUID();
    for (const [index, key] of keys.entries()) {
      const result = await client.query(reserveActionSQL, [
        key,
        identity.provider,
        identity.scope,
        identity.sourceOrderId,
        identity.sourceLineIds[index],
        identity.action,
        hash,
        attemptId,
      ]);
      if (result.rowCount !== 1) throw new UncertainActionError(keys);
    }
    await bindAliases(client, identity, aliases);
    await client.query("COMMIT");
    return { keys, attemptId, replay: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function finish(
  keys: string[],
  attemptId: string,
  status: string,
  result: unknown,
  errorCode: string | null
) {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("Fulfillment ledger database unavailable");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(finishActionsSQL, [
      keys,
      attemptId,
      status,
      result === null ? null : JSON.stringify(result),
      errorCode,
    ]);
    if (updated.rowCount !== keys.length) throw new UncertainActionError(keys);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** The transaction commits BEFORE the provider call; results commit BEFORE returning. */
export async function executeFulfillmentAction<T>(
  identity: ActionIdentity,
  request: unknown,
  execute: () => Promise<T>
): Promise<T> {
  const reservation = await reserve<T>(identity, request);
  if (reservation.replay) return reservation.result;
  const { keys, attemptId } = reservation;
  let result: T;
  try {
    result = await execute();
  } catch (error) {
    const rejected = error instanceof ConfirmedActionFailure;
    await finish(
      keys,
      attemptId,
      rejected ? "failed" : "uncertain",
      null,
      rejected ? "provider_rejected" : "provider_outcome_unknown"
    );
    if (rejected) throw error;
    throw new UncertainActionError(keys);
  }
  // If completion cannot be saved, pending remains blocking. Never classify a
  // database failure after provider success as a safe-to-retry provider failure.
  await finish(keys, attemptId, "succeeded", result, null);
  return result;
}
