import { z } from "zod";
import { queryDatabase } from "@/lib/db/database";
import { createCommandSQL, readCommandSQL } from "@/lib/sql/operations/commands";
import { fingerprint } from "../fulfillment-actions/identity";
import { reconciliationWindow } from "../d365-reconciliation/window";
const parameters = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("cancel_stuck_run"),
      runId: z.string().regex(/^[A-Za-z0-9-]{10,80}$/),
    })
    .strict(),
  z.object({ operation: z.literal("close_stale_reconciliation"), attemptId: z.uuid() }).strict(),
  z.object({ operation: z.literal("reconcile_action"), attemptId: z.uuid() }).strict(),
  z.object({ operation: z.literal("replay_inbox"), inboxId: z.uuid() }).strict(),
  z
    .object({ operation: z.literal("resume_order"), orderId: z.string().regex(/^\d{1,20}$/) })
    .strict(),
  z
    .object({
      operation: z.literal("reconcile"),
      kind: z.enum([
        "salesorder",
        "gps_us",
        "gps_uk",
        "fulfillment",
        "direct_salesorder",
        "direct_fulfillment",
      ]),
      dateFrom: z.string(),
      dateTo: z.string(),
    })
    .strict(),
]);
export const recoveryCommandSchema = z
  .object({
    requestId: z.uuid(),
    reason: z.string().trim().min(10).max(1000),
    actorId: z.string().trim().min(1).max(100),
    actorEmail: z.email().max(254),
    parameters,
  })
  .strict();
export type RecoveryRequest = z.infer<typeof recoveryCommandSchema>;
export interface RecoveryCommand {
  id: string;
  request_hash: string;
  actor_id: string;
  actor_email: string;
  reason: string;
  operation: string;
  parameters: RecoveryRequest["parameters"];
  status: "queued" | "dispatched" | "succeeded" | "blocked" | "failed";
}
export async function reserveRecoveryRequest(input: unknown) {
  const request = recoveryCommandSchema.parse(input);
  if (request.parameters.operation === "reconcile")
    reconciliationWindow(request.parameters.dateFrom, request.parameters.dateTo);
  const hash = fingerprint(request);
  await queryDatabase(createCommandSQL, [
    request.requestId,
    hash,
    request.actorId,
    request.actorEmail,
    request.reason,
    request.parameters.operation,
    JSON.stringify(request.parameters),
  ]);
  const row = (await queryDatabase<RecoveryCommand>(readCommandSQL, [request.requestId])).rows[0];
  if (!row || row.request_hash !== hash)
    throw new Error("Recovery request ID conflicts with an existing command");
  return { requestId: row.id, status: row.status };
}
