import { inngest } from "../client";
import { config } from "@/lib/config";
import {
  claimOosOutboxEntries,
  markOosOutboxFailed,
  markOosOutboxPublished,
} from "@/lib/services/oos-recovery/outbox";
import { RETRY_CONFIGS } from "@/lib/utils/constants";
import { redispatchStalledOosDrainRequests } from "@/lib/services/oos-recovery/requests";

function safeErrorCode(error: unknown): string {
  const candidate = error as { name?: unknown; code?: unknown };
  const name =
    typeof candidate?.name === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate.name)
      ? candidate.name
      : "delivery_error";
  const code =
    typeof candidate?.code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate.code)
      ? candidate.code
      : undefined;
  return [name, code].filter(Boolean).join(":");
}

type OosOutboxStep = {
  run<T>(id: string, handler: () => Promise<T>): Promise<T>;
  sendEvent(
    id: string,
    event: { id: string; name: "oos/outbox.drain"; data: Record<string, never> }
  ): Promise<unknown>;
};

export const drainOosOutbox = inngest.createFunction(
  {
    id: "drain-oos-recovery-outbox",
    name: "Drain OOS Recovery Outbox",
    retries: RETRY_CONFIGS.LOW_PRIORITY,
    concurrency: { limit: 1 },
    triggers: [
      { cron: `*/${config.oosRecovery.outboxIntervalMinutes} * * * *` },
      { event: "oos/outbox.drain" },
    ],
  },
  async ({ event, step }: { event: { id: string }; step: OosOutboxStep }) => {
    if (!config.oosRecovery.enabled) {
      return { status: "disabled", published: 0, failed: 0 };
    }
    await step.run("redispatch-stalled-oos-drains", () =>
      redispatchStalledOosDrainRequests(
        config.oosRecovery.claimBatchSize,
        config.oosRecovery.maxAttempts
      )
    );
    const entries = await step.run("claim-oos-outbox", () =>
      claimOosOutboxEntries(
        config.oosRecovery.claimBatchSize,
        config.oosRecovery.leaseSeconds,
        config.oosRecovery.maxAttempts
      )
    );
    let published = 0;
    let failed = 0;
    let exhausted = 0;
    for (const entry of entries) {
      const outcome = await step.run(`publish-oos-${entry.id}-${entry.attemptCount}`, async () => {
        try {
          await inngest.send({
            id: entry.eventId,
            name: entry.eventName,
            data: entry.eventData,
          });
          return (await markOosOutboxPublished(entry)) ? "published" : "stale";
        } catch (error) {
          return markOosOutboxFailed(entry, safeErrorCode(error), config.oosRecovery.maxAttempts);
        }
      });
      if (outcome === "published") published++;
      else if (outcome === "exhausted") exhausted++;
      else if (outcome === "retryable") failed++;
    }
    if (entries.length === config.oosRecovery.claimBatchSize) {
      await step.sendEvent("continue-oos-outbox", {
        id: `oos-outbox-drain-${event.id}-${entries.at(-1)?.id ?? "batch"}`,
        name: "oos/outbox.drain",
        data: {},
      });
    }
    return { status: entries.length ? "drained" : "idle", published, failed, exhausted };
  }
);
