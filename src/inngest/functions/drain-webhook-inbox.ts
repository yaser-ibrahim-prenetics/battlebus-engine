import { inngest } from "../client";
import {
  claimDueOutboxEvents,
  markOutboxFailed,
  markOutboxPublished,
  requeueDeadLetter,
} from "@/lib/services/webhook-inbox";
import { config } from "@/lib/config";
import { RETRY_CONFIGS } from "@/lib/utils/constants";
import { logFlowEvent } from "@/lib/services/flow-logs";
import { assertWebhookSchemaVersion } from "@/lib/webhooks/schema-registry";

const MAX_DELIVERY_ATTEMPTS = 10;

export const drainWebhookInbox = inngest.createFunction(
  {
    id: "drain-webhook-inbox",
    name: "Drain Durable Webhook Outbox",
    retries: RETRY_CONFIGS.LOW_PRIORITY,
    concurrency: { limit: 1 },
    triggers: [
      { cron: `*/${config.webhookInbox.drainIntervalMinutes} * * * *` },
      { event: "admin/webhook-inbox.drain" },
      { event: "admin/webhook-outbox.replay" },
    ],
  },
  async ({ step, event }: { step: any; event: any }) => {
    const flowStart = Date.now();
    const runId = event.id;
    const requestedOutboxId =
      event.name === "admin/webhook-outbox.replay" && typeof event.data?.outboxId === "string"
        ? event.data.outboxId
        : undefined;

    logFlowEvent({
      flow: "webhook_outbox_drain",
      step: "start",
      status: "started",
      runId,
      payload: { requestedOutboxId },
    });

    const drainResult = await step.run("drain", async () => {
      if (requestedOutboxId) {
        const requeued = await requeueDeadLetter(requestedOutboxId);
        if (!requeued) {
          return { count: 0, published: 0, retried: 0, deadLettered: 0, replayed: false };
        }
      }

      const entries = await claimDueOutboxEvents(requestedOutboxId ? 1 : 50, requestedOutboxId);
      let published = 0;
      let retried = 0;
      let deadLettered = 0;

      for (const entry of entries) {
        try {
          assertWebhookSchemaVersion(entry.source, entry.schemaVersion);
          await inngest.send([
            { name: entry.eventName, data: entry.eventData, id: entry.eventId ?? undefined },
          ] as Parameters<typeof inngest.send>[0]);
          await markOutboxPublished(entry);
          published++;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const terminal = entry.attempts >= MAX_DELIVERY_ATTEMPTS;
          const state = await markOutboxFailed(entry, {
            message,
            errorClass: "unknown",
            recoveryAction: terminal ? "manual_review" : "retry",
            terminal,
            retryDelaySeconds: Math.min(3600, 30 * 2 ** Math.max(0, entry.attempts - 1)),
          });
          if (state === "dead_letter") deadLettered++;
          else retried++;
        }
      }

      return {
        count: entries.length,
        published,
        retried,
        deadLettered,
        replayed: Boolean(requestedOutboxId),
      };
    });

    logFlowEvent({
      flow: "webhook_outbox_drain",
      step: "done",
      status: "completed",
      runId,
      durationMs: Date.now() - flowStart,
      payload: drainResult,
    });

    return {
      status: drainResult.count === 0 ? "idle" : "drained",
      ...drainResult,
    };
  }
);
