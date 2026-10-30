import { ChannelLiftError, type MetaChannelLiftEvent } from "@/lib/channel-lift/model";

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

type MetaDependencies = {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
};

const defaultDependencies: MetaDependencies = {
  fetch: globalThis.fetch,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export async function sendMetaChannelLiftBatch(
  {
    datasetId,
    accessToken,
    events,
  }: { datasetId: string; accessToken: string; events: MetaChannelLiftEvent[] },
  dependencies: MetaDependencies = defaultDependencies
): Promise<{ eventsReceived: number }> {
  if (!/^\d+$/.test(datasetId) || !accessToken) {
    throw new ChannelLiftError("meta_configuration_invalid");
  }
  if (events.length < 1 || events.length > 500) {
    throw new ChannelLiftError("meta_batch_size_invalid");
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await dependencies.fetch(
        `https://graph.facebook.com/v26.0/${datasetId}/events`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ data: events }),
        }
      );
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
          throw new ChannelLiftError(
            response.status === 429
              ? "meta_rate_limited"
              : response.status >= 500
                ? "meta_unavailable"
                : "meta_rejected",
            retryable
          );
        }
        await dependencies.sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      const body = (await response.json()) as { events_received?: unknown };
      if (body.events_received !== events.length) {
        throw new ChannelLiftError("meta_receipt_mismatch");
      }
      return { eventsReceived: events.length };
    } catch (error) {
      if (error instanceof ChannelLiftError) throw error;
      if (attempt >= RETRY_DELAYS_MS.length) {
        throw new ChannelLiftError("meta_network_error", true);
      }
      await dependencies.sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}
