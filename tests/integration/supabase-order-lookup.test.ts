import { describe, it, expect, vi } from "vitest";
import { fetchD365HintByShopifyOrderId } from "@/lib/services/supabase-order-lookup";

const hasSupabase = !!(
  (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL) &&
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

describe.skipIf(!hasSupabase)("fetchD365HintByShopifyOrderId (live Supabase)", () => {
  it("returns d365_order_number row when Hub has synced the order", async () => {
    const shopifyOrderId =
      process.env.TEST_REFUND_SHOPIFY_ORDER_ID ||
      process.env.TEST_SHOPIFY_ORDER_ID ||
      "6993154474216";

    const hint = await fetchD365HintByShopifyOrderId(shopifyOrderId);

    if (!hint) {
      console.warn(
        `[supabase-order-lookup test] No row with d365_order_number for shopify_order_id=${shopifyOrderId}. ` +
          "Set TEST_REFUND_SHOPIFY_ORDER_ID to an id that exists in orders."
      );
    }

    expect(hint).toBeDefined();
    expect(hint?.d365OrderNumber).toBeTruthy();
    expect(typeof hint?.d365OrderNumber).toBe("string");
  });
});

describe("fetchD365HintByShopifyOrderId (no credentials)", () => {
  it("returns null when Supabase is not configured", async () => {
    vi.resetModules();
    const prevUrl = process.env.SUPABASE_URL;
    const prevVite = process.env.VITE_SUPABASE_URL;
    const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const { fetchD365HintByShopifyOrderId: fetchHint } =
      await import("@/lib/services/supabase-order-lookup");
    const result = await fetchHint("123");
    expect(result).toBeNull();

    process.env.SUPABASE_URL = prevUrl;
    process.env.VITE_SUPABASE_URL = prevVite;
    process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  });
});
