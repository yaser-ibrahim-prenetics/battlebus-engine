import type { OrderAccounting } from "../../order-accounting/types";
import { segmentOrder } from "../planner";
import { toD365SalesOrderLines, calculateOrderCost } from "@/lib/transformers/order";
import type { ShopifyOrderPayload, ShopifyRefundPayload } from "@/inngest/events";
import type { StoredPlan } from "../types";

type OptionalMetadata = "cancel_reason" | "source_name" | "app_id" | "note_attributes";
export type RefundOrder = Omit<ShopifyOrderPayload, OptionalMetadata> &
  Partial<Pick<ShopifyOrderPayload, OptionalMetadata>> & {
    presentment_currency?: string;
    transactions?: ShopifyRefundPayload["transactions"];
  };

export function refundProjectionOrder(order: RefundOrder): ShopifyOrderPayload {
  return {
    ...order,
    cancel_reason: order.cancel_reason ?? null,
    source_name: order.source_name ?? null,
    app_id: order.app_id ?? null,
    note_attributes: order.note_attributes ?? [],
  };
}

export function requiresRefundAccounting(stored: StoredPlan, order: RefundOrder) {
  return stored.plan.segments.some(
    (segment) =>
      stored.progress[String(segment.index)]?.postedAmountCents == null &&
      segment.lines.some((selected) =>
        order.line_items.some((line) => String(line.id) === selected.lineItemId && line.gift_card)
      )
  );
}

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
  if (!sum) {
    if (!total) return weights.map(() => 0);
    throw new Error("Refund allocation has no financial basis");
  }
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
  previous: SegmentRefundAllocation[],
  accounting?: OrderAccounting
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
      cents(line.subtotal),
      allocations.map((row) => row.quantities[id] ?? 0)
    );
    values.forEach((value, index) => (weights[index] += value));
    weights[0] += cents(line.total_tax);
  }
  // Original monetary ownership mirrors segmentOrder: tax and freight belong to zero.
  // Allocation values and remaining balances are in the D365 USD posting currency.
  if ((order.currency || "USD").toUpperCase() !== "USD")
    throw new Error("Segment refund allocation requires USD shop-money evidence");
  if (!accounting && requiresRefundAccounting(stored, order))
    throw new Error("Original gift-card accounting is required for refund capacity");
  const remainingBalances = segments.map(
    (segment) =>
      stored.progress[String(segment.index)]?.postedAmountCents ??
      Math.round(
        calculateOrderCost(
          toD365SalesOrderLines(
            segmentOrder(refundProjectionOrder(order), stored.plan, segment.index),
            "refund-capacity",
            segment.warehouse,
            true,
            segment.dataAreaId,
            accounting
          )
        ) * 100
      )
  );
  for (const [index, segment] of segments.entries()) {
    remainingBalances[index] = Math.max(
      0,
      remainingBalances[index] -
        previous
          .filter((row) => row.segmentIndex === segment.index)
          .reduce((sum, row) => sum + row.amountCents, 0)
    );
  }
  if (!refund.refund_line_items.length || weights.every((weight) => weight === 0)) {
    const shippingOnly =
      refund.order_adjustments?.length &&
      refund.order_adjustments.every((row) => row.kind === "shipping_refund");
    weights.splice(
      0,
      weights.length,
      ...remainingBalances.map((balance, index) => (shippingOnly && index !== 0 ? 0 : balance))
    );
    if (amountCents > weights.reduce((sum, amount) => sum + amount, 0))
      throw new Error("Refund amount exceeds remaining segment balances");
  } else {
    // Non-line adjustments (including freight) belong to the segment-zero header.
    const lineTotal = weights.reduce((sum, amount) => sum + amount, 0);
    if (amountCents > lineTotal) weights[0] += amountCents - lineTotal;
  }
  const amounts = allocateCents(amountCents, weights);
  if (amounts.some((amount, index) => amount > remainingBalances[index]))
    throw new Error("Refund amount exceeds remaining segment balances");
  allocations.forEach((row, index) => (row.amountCents = amounts[index]));
  // Keep quantity reservations even when currency rounding gives a zero-cent segment.
  return allocations.filter((row) => row.amountCents > 0 || Object.keys(row.quantities).length > 0);
}
