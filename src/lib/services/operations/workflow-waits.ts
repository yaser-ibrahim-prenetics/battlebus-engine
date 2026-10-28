export function waitingDeadline(
  type: string,
  input: readonly unknown[] | undefined,
  now = Date.now()
) {
  if (!["sleep", "sleepUntil", "waitForEvent", "waitForSignal"].includes(type)) return null;
  const value = input?.[0];
  if (type === "sleepUntil") {
    const time =
      value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
    return { until: Number.isFinite(time) ? new Date(time).toISOString() : null };
  }
  const duration =
    type === "sleep"
      ? value
      : value && typeof value === "object" && "timeout" in value
        ? value.timeout
        : undefined;
  const match =
    typeof duration === "string"
      ? /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|seconds?|minutes?|hours?|days?)\s*$/i.exec(duration)
      : null;
  const unit = match?.[2].toLowerCase();
  const factor =
    unit === "ms"
      ? 1
      : unit?.startsWith("s")
        ? 1000
        : unit?.startsWith("m")
          ? 60000
          : unit?.startsWith("h")
            ? 3600000
            : 86400000;
  const milliseconds =
    typeof duration === "number" ? duration : match ? Number(match[1]) * factor : NaN;
  return {
    until:
      Number.isFinite(milliseconds) && milliseconds >= 0
        ? new Date(now + milliseconds).toISOString()
        : null,
  };
}
