import { describe, expect, it } from "vitest";

import {
  getSubscriptionRefillQuantity,
  getSubscriptionRewards,
  isSubscriptionRewardLineItemId,
  subscriptionRewardLineItemId,
} from "../subscription-rewards";
import type { ShopifyOrderPayload } from "@/inngest/events";

function rewardOrder(tags: string, quantity = 3) {
  return {
    id: 123,
    tags,
    line_items: [{ sku: "IM8-FG-000035", quantity }],
  } as Pick<ShopifyOrderPayload, "id" | "tags" | "line_items">;
}

describe("subscription rewards", () => {
  it("generates one reward per refill unit for the configured recurrence", () => {
    const order = rewardOrder("Recurring subscription order, Subscription order 3");
    expect(getSubscriptionRefillQuantity(order)).toBe(3);
    expect(getSubscriptionRewards(order, true)).toEqual([
      { sku: "IM8-FG-000022", quantity: 3, recurrence: "3" },
    ]);
  });

  it("does not generate rewards without matching refill items or when disabled", () => {
    expect(
      getSubscriptionRewards(
        { ...rewardOrder("Subscription order 3"), line_items: [{ sku: "OTHER", quantity: 3 }] },
        true
      )
    ).toEqual([]);
    expect(getSubscriptionRewards(rewardOrder("Subscription order 3"), false)).toEqual([]);
  });

  it("uses stable synthetic line item identifiers", () => {
    expect(subscriptionRewardLineItemId("im8-fg-000022")).toBe(
      "subscription-reward:IM8-FG-000022"
    );
    expect(isSubscriptionRewardLineItemId("subscription-reward:IM8-FG-000022")).toBe(true);
  });
});
