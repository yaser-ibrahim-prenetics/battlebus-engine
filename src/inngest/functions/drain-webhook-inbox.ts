// ============================================================================
// DRAIN WEBHOOK INBOX — LEASED, BACKED-OFF PUBLICATION
// ============================================================================

import { inngest } from "../client";
import {
  claimWebhookInboxEntries,
  classifyWebhookInboxDeliveryFailure,
  deleteRetainedPublishedInboxEntries,
  markInboxFailed,
  markInboxPublished,
  validateWebhookInboxEvents,
  webhookInboxDeliveryMaxAttempts,
  webhookInboxDeliveryPolicy,
} from "@/lib/services/webhook-inbox";
import { config } from "@/lib/config";
import { RETRY_CONFIGS } from "@/lib/utils/constants";
import { logFlowEvent } from "@/lib/services/flow-logs";

type DrainOutcome = "published" | "retryable" | "dead_letter" | "stale";
type WebhookInboxDrainStep = {
  run<T>(id: string, handler: () => Promise<T>): Promise<T>;
  sendEvent(
    id: string,
    event: { id: string; name: "webhook/inbox.drain"; data: Record<string, never> }
  ): Promise<unknown>;
};
type WebhookInboxDrainEvent = {
  id: string;
  name: string;
  data?: { inboxId?: string };
};
export const drainWebhookInbox = inngest.createFunction(
  {
    id: "drain-webhook-inbox",
    name: "Drain Webhook Inbox",
    retries: RETRY_CONFIGS.LOW_PRIORITY,
    // The database lease protects cross-process claims. The function-level
    // limit additionally prevents cron, successor and manual drain runs from
    // competing for provider publication capacity.
    concurrency: { limit: 1 },
    triggers: [
      { cron: `*/${config.webhookInbox.drainIntervalMinutes} * * * *` },
      { event: "webhook/inbox.drain" },
    ],
  },
  async ({ step, event }: { step: WebhookInboxDrainStep; event: WebhookInboxDrainEvent }) => {
    const flowStart = Date.now();
    const runId = event.id;
    const requestedInboxId =
      event.name === "webhook/inbox.drain" && typeof event.data?.inboxId === "string"
        ? event.data.inboxId
        : undefined;

    logFlowEvent({
      flow: "webhook_inbox_drain",
      step: "start",
      status: "started",
      runId,
      payload: { requestedInboxId },
    });

    const maxAttempts = webhookInboxDeliveryMaxAttempts(
      config.webhookInbox.durableDeliveryEnabled,
      config.webhookInbox.maxAttempts
    );
    const entries = await step.run("claim-ready-receipts", () =>
      claimWebhookInboxEntries(requestedInboxId ? 1 : config.webhookInbox.claimBatchSize, {
        inboxId: requestedInboxId,
        leaseSeconds: config.webhookInbox.leaseSeconds,
        maxAttempts,
      })
    );

    const outcomes: DrainOutcome[] = [];
    for (const entry of entries) {
      const outcome = await step.run(
        `publish-${entry.id}-attempt-${entry.attempts}-replay-${entry.replayCount}`,
        async (): Promise<DrainOutcome> => {
          const validationError = validateWebhookInboxEvents(entry.events);
          if (validationError) {
            return markInboxFailed(entry, {
              errorCode: validationError,
              maxAttempts,
              retryDelaySeconds: 1,
              terminal: true,
            });
          }

          try {
            const sent = await inngest.send(entry.events as Parameters<typeof inngest.send>[0]);
            return (await markInboxPublished(entry, sent?.ids ?? [])) ? "published" : "stale";
          } catch (error) {
            const failure = classifyWebhookInboxDeliveryFailure(error);
            const policy = webhookInboxDeliveryPolicy({
              durableDeliveryEnabled: config.webhookInbox.durableDeliveryEnabled,
              configuredMaxAttempts: config.webhookInbox.maxAttempts,
              attempt: entry.attempts,
              retryBaseSeconds: config.webhookInbox.retryBaseSeconds,
              retryMaxSeconds: config.webhookInbox.retryMaxSeconds,
              terminalFailure: failure.terminal,
            });
            return markInboxFailed(entry, {
              errorCode: failure.errorCode,
              ...policy,
            });
          }
        }
      );
      outcomes.push(outcome);
    }

    const retainedDeleted = config.webhookInbox.durableDeliveryEnabled
      ? await step.run("delete-expired-published-receipts", () =>
          deleteRetainedPublishedInboxEntries(
            config.webhookInbox.publishedRetentionDays,
            config.webhookInbox.retentionBatchSize
          )
        )
      : 0;

    if (
      config.webhookInbox.durableDeliveryEnabled &&
      !requestedInboxId &&
      entries.length === config.webhookInbox.claimBatchSize
    ) {
      const lastEntry = entries.at(-1);
      await step.sendEvent("continue-webhook-inbox-drain", {
        id: `webhook-inbox-drain-${runId}-${lastEntry?.id ?? "batch"}`,
        name: "webhook/inbox.drain" as const,
        data: {},
      });
    }

    const drainResult = {
      count: entries.length,
      published: outcomes.filter((outcome) => outcome === "published").length,
      retried: outcomes.filter((outcome) => outcome === "retryable").length,
      deadLettered: outcomes.filter((outcome) => outcome === "dead_letter").length,
      stale: outcomes.filter((outcome) => outcome === "stale").length,
      retainedDeleted,
      durableDeliveryEnabled: config.webhookInbox.durableDeliveryEnabled,
    };

    logFlowEvent({
      flow: "webhook_inbox_drain",
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
