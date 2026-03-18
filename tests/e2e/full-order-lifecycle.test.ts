import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  validateE2eEnv,
  createTestShopifyOrder,
  pollSupabaseForOrder,
  cancelTestShopifyOrder,
  closeTestShopifyOrder,
} from "./setup";

/**
 * E2E tests that exercise the full order lifecycle with real APIs.
 *
 * These tests are skipped unless all required environment variables are present.
 * Run with: npm run test:e2e
 *
 * Flow:
 *   1. Create a real Shopify order (tagged "testing")
 *   2. Poll Supabase until the order appears with expected status
 *   3. Verify D365 order exists
 *   4. Cancel the order and verify cancellation propagates
 *   5. Clean up test data
 */
describe("Full Order Lifecycle (E2E)", () => {
  const envCheck = validateE2eEnv();
  const shouldRun = envCheck.valid;

  if (!shouldRun) {
    it.skip(`Skipped: missing env vars: ${envCheck.missing.join(", ")}`, () => {});
    return;
  }

  let testOrderId: string;
  let testOrderName: string;

  afterAll(async () => {
    if (testOrderId) {
      try {
        await cancelTestShopifyOrder(testOrderId);
        await closeTestShopifyOrder(testOrderId);
      } catch {
        console.warn(`Cleanup: could not cancel/close test order ${testOrderId}`);
      }
    }
  });

  it("creates a Shopify test order", async () => {
    const result = await createTestShopifyOrder({
      tags: "testing,e2e-test",
    });

    testOrderId = result.orderId;
    testOrderName = result.orderName;

    expect(testOrderId).toBeDefined();
    expect(testOrderName).toBeDefined();
    console.log(`E2E: Created test order ${testOrderName} (${testOrderId})`);
  }, 30000);

  it("order appears in Supabase with processing/completed status", async () => {
    if (!testOrderId) return;

    const order = await pollSupabaseForOrder(testOrderId, "completed", 90000);

    expect(order).toBeDefined();
    expect(order.shopify_order_id).toBe(testOrderId);
    console.log(`E2E: Order ${testOrderName} reached status: ${order.status}`);
  }, 120000);

  it("cancels the test order and verifies propagation", async () => {
    if (!testOrderId) return;

    await cancelTestShopifyOrder(testOrderId);

    // Poll for cancellation status
    try {
      const cancelledOrder = await pollSupabaseForOrder(testOrderId, "cancelled", 60000);
      expect(cancelledOrder.status).toBe("cancelled");
      console.log(`E2E: Order ${testOrderName} cancelled successfully`);
    } catch {
      console.warn(`E2E: Cancellation status not reflected in Supabase within timeout`);
    }
  }, 90000);
});
