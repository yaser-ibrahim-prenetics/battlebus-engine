import { inngest } from "@/inngest/client";
import { config } from "@/lib/config";
import { queryDatabase } from "@/lib/db/database";
import { replayInboxSQL, markReplayedInboxSQL } from "@/lib/sql/operations/commands";
import { reconcileFulfillmentAttempt } from "../fulfillment-actions/recovery";
import type { RecoveryCommand } from "./commands";

export async function executeRecoveryCommand(command: RecoveryCommand) {
  const operation = command.parameters;
  if (operation.operation === "reconcile_action")
    return reconcileFulfillmentAttempt(operation.attemptId);
  if (operation.operation === "replay_inbox") {
    const row = (
      await queryDatabase<{
        id: string;
        status: string;
        events: { id?: string; name: string; data: Record<string, unknown> }[];
      }>(replayInboxSQL, [operation.inboxId])
    ).rows[0];
    if (!row) throw new Error("Inbox entry missing");
    if (row.status === "published") return { alreadyPublished: true };
    if (
      !row.events.length ||
      row.events.length > 100 ||
      row.events.some((event) => !event.id?.trim() || !event.name || !event.data)
    )
      throw new Error("Inbox replay requires original stable event identities");
    const sent = await inngest.send(row.events);
    const saved = await queryDatabase(markReplayedInboxSQL, [row.id, sent.ids]);
    if (saved.rowCount !== 1) throw new Error("Inbox acknowledgement could not be saved");
    return { eventIds: sent.ids };
  }
  if (operation.operation === "resume_order") {
    // Uses the existing fresh-Shopify validation and durable segment/action guards.
    const sent = await inngest.send({
      id: `recovery-command:${command.id}`,
      name: "shopify/order.recover",
      data: {
        shopifyOrderIds: [operation.orderId],
        force: true,
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
