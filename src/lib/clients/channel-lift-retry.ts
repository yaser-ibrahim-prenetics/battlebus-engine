import { ChannelLiftError } from "@/lib/channel-lift/model";

export const CHANNEL_LIFT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

export async function withBoundedChannelLiftRetry<T>({
  operation,
  normalizeError,
  sleep,
}: {
  operation: () => Promise<T>;
  normalizeError: (error: unknown) => ChannelLiftError;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const normalized = normalizeError(error);
      if (!normalized.retryable || attempt >= CHANNEL_LIFT_RETRY_DELAYS_MS.length) {
        throw normalized;
      }
      await sleep(CHANNEL_LIFT_RETRY_DELAYS_MS[attempt]);
    }
  }
}
