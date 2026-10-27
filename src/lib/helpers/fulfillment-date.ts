/** A posting date must be derived from immutable source data, never the retry clock. */
export function fulfillmentPostingDate(
  sourceTimestamp: string | null | undefined,
  calendar: "utc" | "source" = "utc"
): string {
  const sourceDay = sourceTimestamp?.slice(0, 10);
  if (!sourceDay || !/^\d{4}-\d{2}-\d{2}$/.test(sourceDay))
    throw new Error("Fulfillment requires a valid source timestamp");
  const day = new Date(`${sourceDay}T00:00:00Z`);
  const instant = Date.parse(sourceTimestamp!);
  if (
    !Number.isFinite(day.getTime()) ||
    day.toISOString().slice(0, 10) !== sourceDay ||
    !Number.isFinite(instant)
  )
    throw new Error("Fulfillment requires a valid source timestamp");
  // GPS supplies warehouse-local timestamps without an offset. Preserve its
  // calendar date; Shopify timestamps carry an offset and are normalized to UTC.
  return calendar === "source" ? sourceDay : new Date(instant).toISOString().slice(0, 10);
}
