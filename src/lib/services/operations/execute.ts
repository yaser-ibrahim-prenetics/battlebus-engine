import { cancelStuckWorkflow, closeStaleReconciliation } from "./stalled";
import { inngest } from "@/inngest/client";
import { config } from "@/lib/config";
import { queryDatabase } from "@/lib/db/database";
import { replayInboxSQL } from "@/lib/sql/operations/commands";
import { reconcileFulfillmentAttempt } from "../fulfillment-actions/recovery";
import { requeueWebhookInboxDeadLetter } from "../webhook-inbox";
import type { RecoveryCommand } from "./commands";

export async function executeRecoveryCommand(command: RecoveryCommand) {
  const operation = command.parameters;
  if (operation.operation === "cancel_stuck_run") return cancelStuckWorkflow(operation.runId);
  if (operation.operation === "close_stale_reconciliation")
    return closeStaleReconciliation(operation.attemptId);
  if (operation.operation === "reconcile_action")
    return reconcileFulfillmentAttempt(operation.attemptId);
  if (operation.operation === "replay_inbox") {
    const row = (
      await queryDatabase<{
        id: string;
        status: string;
        dead_lettered_at: Date | null;
      }>(replayInboxSQL, [operation.inboxId])
    ).rows[0];
    if (!row) throw new Error("Inbox entry missing");
    if (row.status === "published") return { alreadyPublished: true };
    const requeued = await requeueWebhookInboxDeadLetter(row.id, command.id);
    if (!requeued) throw new Error("Inbox dead letter is no longer replayable");
    try {
      const sent = await inngest.send({
        id: `replay-inbox:${command.id}`,
        name: "webhook/inbox.drain",
        data: { inboxId: row.id },
      });
      return { eventIds: sent.ids, requeued: true };
    } catch {
      // The row is already durable and due; the scheduled drain will pick it
      // up even if this wake-up event is temporarily unavailable.
      return { eventIds: [], requeued: true, deliveryDeferred: true };
    }
  }
  if (operation.operation === "resume_order") {
    // Uses the existing fresh-Shopify validation and durable segment/action guards.
    const sent = await inngest.send({
      id: `recovery-command:${command.id}`,
      name: "shopify/order.recover",
      data: {
        shopifyOrderIds: [operation.orderId],
        force: true,
        recoveryRequestId: command.id,
        shopifyStore: config.shopify.im8.shopDomain,
        requestedBy: command.actor_email,
        triggeredByUserId: command.actor_id,
        triggeredByUserEmail: command.actor_email,
        requestedAt: new Date().toISOString(),
      },
    });
    return { eventIds: sent.ids };
  }
  const direct = operation.kind.startsWith("direct_");
  const sent = await inngest.send({
    id: `recovery-command:${command.id}`,
    name: direct ? "reconciliation/d365.run" : "reconciliation/run",
    data: {
      type: direct ? operation.kind.slice(7) : operation.kind,
      dateFrom: operation.dateFrom,
      dateTo: operation.dateTo,
    },
  });
  return { eventIds: sent.ids };
}
