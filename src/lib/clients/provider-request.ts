import { config } from "@/lib/config";

/** Preserve legacy request behavior until shared provider capacity is activated. */
export function boundedProviderRequestInit(
  init?: Parameters<typeof fetch>[1],
  timeoutMs = 60_000
): Parameters<typeof fetch>[1] {
  if (!config.providerCapacity?.enabled) return init;
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  };
}
