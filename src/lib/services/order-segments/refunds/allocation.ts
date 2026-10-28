import type { ShopifyOrderPayload, ShopifyRefundPayload } from "@/inngest/events";
import type { StoredPlan } from "../types";

export type RefundOrder = Pick<
  ShopifyOrderPayload,
  "id" | "line_items" | "shipping_lines" | "total_tax" | "currency"
> & { presentment_currency?: string; transactions?: ShopifyRefundPayload["transactions"] };

export interface SegmentRefundAllocation {
  segmentIndex: number;
  amountCents: number;
  quantities: Record<string, number>;
}

/** Largest-remainder allocation uses integer arithmetic and stable segment ordering. */
export function allocateCents(total: number, weights: number[]): number[] {
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    weights.some((w) => !Number.isSafeInteger(w) || w < 0)
  )
    throw new Error("Invalid monetary allocation");
  const sum = weights.reduce((a, b) => a + BigInt(b), BigInt(0));
  if (!sum) throw new Error("Refund allocation has no financial basis");
  const fractions = weights.map((weight, index) => ({
    index,
    numerator: BigInt(total) * BigInt(weight),
  }));
  const result = fractions.map((row) => Number(row.numerator / sum));
  let remainder = total - result.reduce((a, b) => a + b, 0);
  fractions.sort((a, b) => {
    const left = a.numerator % sum,
      right = b.numerator % sum;
    return left === right ? a.index - b.index : left > right ? -1 : 1;
  });
  for (const row of fractions) if (remainder-- > 0) result[row.index]++;
  return result;
}
const cents = (amount: string) => {
  const value = Math.round(Number(amount) * 100);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid refund source amount");
  return value;
};

export function allocateSegmentRefund(
  stored: StoredPlan,
  order: RefundOrder,
  refund: ShopifyRefundPayload,
  amountCents: number,
  previous: SegmentRefundAllocation[]
): SegmentRefundAllocation[] {
  const segments = [...stored.plan.segments].sort((a, b) => a.index - b.index);
  const allocations = segments.map((segment) => ({
    segmentIndex: segment.index,
    amountCents: 0,
    quantities: {} as Record<string, number>,
  }));
  const weights = segments.map(() => 0);
  const seen = new Set<string>();
  for (const line of refund.refund_line_items) {
    const id = String(line.line_item_id);
    if (seen.has(id) || !Number.isSafeInteger(line.quantity) || line.quantity <= 0)
      throw new Error("Invalid or duplicate refund line");
    seen.add(id);
    let remaining = line.quantity;
    for (const [index, segment] of segments.entries()) {
      const source = segment.lines.find((item) => item.lineItemId === id);
      const used = previous
        .filter((row) => row.segmentIndex === segment.index)
        .reduce((sum, row) => sum + (row.quantities[id] ?? 0), 0);
      const available = (source?.quantity ?? 0) - used;
      if (available < 0) throw new Error("Refund reservations exceed segment quantity");
      const quantity = Math.min(remaining, available);
      if (quantity) {
        allocations[index].quantities[id] = quantity;
        remaining -= quantity;
      }
    }
    if (remaining) throw new Error("Refund quantity exceeds unrefunded segment quantity");
    const values = allocateCents(
      cents(line.subtotal) + cents(line.total_tax),
      allocations.map((row) => row.quantities[id] ?? 0)
    );
    values.forEach((value, index) => (weights[index] += value));
  }
  // Amount-only adjustments follow the original segment net merchandise values.
  // Freight, tax and nonphysical lines are owned by segment zero in the persisted plan.
  if (!refund.refund_line_items.length || weights.every((weight) => weight === 0)) {
    for (const [index, segment] of segments.entries()) {
      for (const line of segment.lines) {
        const source = order.line_items.find((item) => String(item.id) === line.lineItemId);
        if (!source || source.quantity <= 0) throw new Error("Refund source line missing");
        weights[index] += Math.max(
          0,
          Math.round(
            ((cents(source.price) * source.quantity - cents(source.total_discount || "0")) *
              line.quantity) /
              source.quantity
          )
        );
      }
    }
    weights[0] +=
      (order.shipping_lines ?? []).reduce((sum, line) => sum + cents(line.price), 0) +
      cents(order.total_tax || "0");
  }
  const amounts = allocateCents(amountCents, weights);
  allocations.forEach((row, index) => (row.amountCents = amounts[index]));
  // Keep quantity reservations even when currency rounding gives a zero-cent segment.
  return allocations.filter((row) => row.amountCents > 0 || Object.keys(row.quantities).length > 0);
}
