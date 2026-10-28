/** Log stable categories and correlation IDs only; provider bodies can contain secrets/PII. */
export function recoveryErrorCode(error: unknown): string {
  const value = error as { name?: unknown; code?: unknown; status?: unknown } | null;
  if (value?.name === "TimeoutError" || value?.name === "AbortError") return "dependency_timeout";
  if (value?.status === 401 || value?.status === 403) return "dependency_authentication";
  if (value?.status === 429) return "dependency_rate_limited";
  if (typeof value?.code === "string" && /^[0-9A-Z]{5}$/.test(value.code))
    return `database_${value.code}`;
  return "verification_or_persistence_failure";
}
export function logRecoveryFailure(context: Record<string, string>, error: unknown) {
  const errorCode = recoveryErrorCode(error);
  console.error("[Operations]", { ...context, errorCode });
  return errorCode;
}
