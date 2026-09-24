// ============================================================================
// DRAIN WEBHOOK INBOX — CRON SAFETY NET
// ============================================================================
// Periodic sweep that re-attempts publishing any `webhook_inbox` row not yet
// marked `published`. This is the safety net for the case where a webhook
// route's inngest.send() failed (and the route already returned a 5xx so the
// sender — e.g. Shopify — will retry within its own window) or the process
// crashed between recording the inbox row and sending the event. Even if
// neither of those retries land, this cron eventually republishes the event.

import { inngest } from "../client";
import {
  getUnpublishedInboxEntries,
  markInboxPublished,
  markInboxFailed,
} from "@/lib/services/supabase-webhook-inbox";
import { config } from "@/lib/config";
import { RETRY_CONFIGS } from "@/lib/utils/constants";
import { logFlowEvent } from "@/lib/services/supabase-flow-logs";

export const drainWebhookInbox = inngest.createFunction(
  {
    id: "drain-webhook-inbox",
    name: "Drain Webhook Inbox",
    retries: RETRY_CONFIGS.LOW_PRIORITY,
    // Only one sweep at a time — prevents overlapping cron runs from
    // double-publishing the same inbox row.
    concurrency: { limit: 1 },
    triggers: [{ cron: `*/${config.webhookInbox.drainIntervalMinutes} * * * *` }],
  },
  async ({ step, event }: { step: any; event: any }) => {
    const _flowStart = Date.now();
    const _runId = (event as any).id;

    logFlowEvent({
      flow: "webhook_inbox_drain",
      step: "start",
      status: "started",
      runId: _runId,
      payload: { intervalMinutes: config.webhookInbox.drainIntervalMinutes },
    });

    const drainResult = await step.run("drain", async () => {
      const entries = await getUnpublishedInboxEntries(50);

      if (entries.length === 0) {
        return { count: 0, published: 0, failed: 0 };
      }

      console.log(`[WebhookInboxDrain] ${entries.length} unpublished inbox row(s) to retry`);

      let published = 0;
      let failed = 0;

      for (const entry of entries) {
        if (!entry.events || entry.events.length === 0) {
          // Nothing to send — treat as trivially published.
          await markInboxPublished(entry.id, []);
          published++;
          continue;
        }

        try {
          const sendResult = await inngest.send(entry.events as any);
          await markInboxPublished(entry.id, sendResult?.ids ?? []);
          published++;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(
            `[WebhookInboxDrain] Retry publish failed for inbox row ${entry.id} (source=${entry.source}):`,
            error
          );
          await markInboxFailed(entry.id, message);
          failed++;
        }
      }

      return { count: entries.length, published, failed };
    });

    logFlowEvent({
      flow: "webhook_inbox_drain",
      step: "done",
      status: "completed",
      runId: _runId,
      durationMs: Date.now() - _flowStart,
      payload: drainResult,
    });

    return {
      status: drainResult.count === 0 ? "idle" : "drained",
      ...drainResult,
    };
  }
);
