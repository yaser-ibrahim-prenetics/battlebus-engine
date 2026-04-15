/**
 * E2E (no network): production vs development Shopify stores
 *
 * Verifies:
 *   1. SHOPIFY_STORE_MODE selects config.shopify.im8 (API/token domain)
 *   2. Webhook HMAC uses the secret for x-shopify-shop-domain (PROD vs TEST hostname)
 *   3. Static location fallback IDs follow the active store's SHOPIFY_*_LOCATION_* vars
 *
 * Store hostnames — keep in sync with Vercel + Shopify:
 *   - Production: im8health.myshopify.com
 *   - Development / testing: testing-im8store.myshopify.com (store slug in Admin URL)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import crypto from "crypto";

/** Production storefront (live). */
const SHOPIFY_PRODUCTION_HOST = "im8health.myshopify.com";

/** Dev / QA storefront — must match webhooks' x-shopify-shop-domain. */
const SHOPIFY_TESTING_HOST = "testing-im8store.myshopify.com";

function hmacSha256Base64(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

describe("E2E: im8health vs testing-im8store (config + webhook HMAC + locations)", () => {
  const envSnapshot = { ...process.env };

  afterEach(() => {
    vi.resetModules();
    process.env = { ...envSnapshot };
  });

  it("im8health: SHOPIFY_STORE_MODE=production + webhook signed with PROD secret passes", async () => {
    process.env.SHOPIFY_STORE_MODE = "production";
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_PROD_SHOP_DOMAIN = SHOPIFY_PRODUCTION_HOST;
    process.env.SHOPIFY_PROD_ACCESS_TOKEN = "shpat_prod_placeholder";
    process.env.SHOPIFY_PROD_WEBHOOK_SECRET = "whsec_prod_e2e";
    process.env.SHOPIFY_TEST_SHOP_DOMAIN = SHOPIFY_TESTING_HOST;
    process.env.SHOPIFY_TEST_ACCESS_TOKEN = "shpat_test_placeholder";
    process.env.SHOPIFY_TEST_WEBHOOK_SECRET = "whsec_test_e2e";
    process.env.SHOPIFY_PROD_LOCATION_GPS = "prod-gps-loc";
    process.env.SHOPIFY_TEST_LOCATION_GPS = "test-gps-loc";

    const { verifyWebhookSignature, resolveShopifyWebhookSecret } = await import(
      "@/lib/clients/shopify"
    );
    const { config } = await import("@/lib/config");

    expect(config.shopify.storeMode).toBe("production");
    expect(config.shopify.im8.shopDomain).toBe(SHOPIFY_PRODUCTION_HOST);
    expect(resolveShopifyWebhookSecret(SHOPIFY_PRODUCTION_HOST)).toBe("whsec_prod_e2e");

    const body = JSON.stringify({
      id: 57_627_600_123,
      name: "#E2E-PROD",
      line_items: [],
    });
    const goodHmac = hmacSha256Base64(body, "whsec_prod_e2e");
    expect(verifyWebhookSignature(body, goodHmac, SHOPIFY_PRODUCTION_HOST)).toBe(true);

    const wrongHmac = hmacSha256Base64(body, "whsec_test_e2e");
    expect(verifyWebhookSignature(body, wrongHmac, SHOPIFY_PRODUCTION_HOST)).toBe(false);
  });

  it("testing-im8store: SHOPIFY_STORE_MODE=test + webhook signed with TEST secret passes", async () => {
    process.env.SHOPIFY_STORE_MODE = "test";
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_PROD_SHOP_DOMAIN = SHOPIFY_PRODUCTION_HOST;
    process.env.SHOPIFY_PROD_ACCESS_TOKEN = "shpat_prod_placeholder";
    process.env.SHOPIFY_PROD_WEBHOOK_SECRET = "whsec_prod_e2e";
    process.env.SHOPIFY_TEST_SHOP_DOMAIN = SHOPIFY_TESTING_HOST;
    process.env.SHOPIFY_TEST_ACCESS_TOKEN = "shpat_test_placeholder";
    process.env.SHOPIFY_TEST_WEBHOOK_SECRET = "whsec_test_e2e";
    process.env.SHOPIFY_PROD_LOCATION_GPS = "prod-gps-loc";
    process.env.SHOPIFY_TEST_LOCATION_GPS = "test-gps-loc";

    const { verifyWebhookSignature, resolveShopifyWebhookSecret } = await import(
      "@/lib/clients/shopify"
    );
    const { config } = await import("@/lib/config");

    expect(config.shopify.storeMode).toBe("test");
    expect(config.shopify.im8.shopDomain).toBe(SHOPIFY_TESTING_HOST);
    expect(resolveShopifyWebhookSecret(SHOPIFY_TESTING_HOST)).toBe("whsec_test_e2e");

    const body = JSON.stringify({
      id: 57_627_600_456,
      name: "#E2E-TEST",
      line_items: [],
    });
    const goodHmac = hmacSha256Base64(body, "whsec_test_e2e");
    expect(verifyWebhookSignature(body, goodHmac, SHOPIFY_TESTING_HOST)).toBe(true);

    const wrongHmac = hmacSha256Base64(body, "whsec_prod_e2e");
    expect(verifyWebhookSignature(body, wrongHmac, SHOPIFY_TESTING_HOST)).toBe(false);
  });

  it("webhook from production hostname still verifies when SHOPIFY_STORE_MODE=test (API uses test store)", async () => {
    process.env.SHOPIFY_STORE_MODE = "test";
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_PROD_SHOP_DOMAIN = SHOPIFY_PRODUCTION_HOST;
    process.env.SHOPIFY_PROD_WEBHOOK_SECRET = "whsec_prod_e2e";
    process.env.SHOPIFY_TEST_SHOP_DOMAIN = SHOPIFY_TESTING_HOST;
    process.env.SHOPIFY_TEST_WEBHOOK_SECRET = "whsec_test_e2e";
    process.env.SHOPIFY_PROD_ACCESS_TOKEN = "p";
    process.env.SHOPIFY_TEST_ACCESS_TOKEN = "t";

    const { verifyWebhookSignature, resolveShopifyWebhookSecret } = await import(
      "@/lib/clients/shopify"
    );
    const { config } = await import("@/lib/config");

    expect(config.shopify.im8.shopDomain).toBe(SHOPIFY_TESTING_HOST);
    expect(resolveShopifyWebhookSecret(SHOPIFY_PRODUCTION_HOST)).toBe("whsec_prod_e2e");

    const body = '{"id":1,"name":"#X","line_items":[]}';
    const hmac = hmacSha256Base64(body, "whsec_prod_e2e");
    expect(verifyWebhookSignature(body, hmac, SHOPIFY_PRODUCTION_HOST)).toBe(true);
  });

  it("resolveShopifyAdminCredentials: production hostname uses PROD token even when SHOPIFY_STORE_MODE=test", async () => {
    process.env.SHOPIFY_STORE_MODE = "test";
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_PROD_SHOP_DOMAIN = SHOPIFY_PRODUCTION_HOST;
    process.env.SHOPIFY_PROD_ACCESS_TOKEN = "token_prod";
    process.env.SHOPIFY_PROD_API_VERSION = "2024-01";
    process.env.SHOPIFY_TEST_SHOP_DOMAIN = SHOPIFY_TESTING_HOST;
    process.env.SHOPIFY_TEST_ACCESS_TOKEN = "token_test";
    process.env.SHOPIFY_TEST_API_VERSION = "2024-01";
    process.env.SHOPIFY_PROD_WEBHOOK_SECRET = "w";
    process.env.SHOPIFY_TEST_WEBHOOK_SECRET = "w";

    const { resolveShopifyAdminCredentials } = await import("@/lib/clients/shopify");
    const prod = resolveShopifyAdminCredentials(SHOPIFY_PRODUCTION_HOST);
    expect(prod.shopDomain).toBe(SHOPIFY_PRODUCTION_HOST);
    expect(prod.accessToken).toBe("token_prod");

    const test = resolveShopifyAdminCredentials(SHOPIFY_TESTING_HOST);
    expect(test.shopDomain).toBe(SHOPIFY_TESTING_HOST);
    expect(test.accessToken).toBe("token_test");
  });

  it("resolveShopifyAdminCredentials: no hostname uses active store (SHOPIFY_STORE_MODE)", async () => {
    process.env.SHOPIFY_STORE_MODE = "test";
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_PROD_SHOP_DOMAIN = SHOPIFY_PRODUCTION_HOST;
    process.env.SHOPIFY_PROD_ACCESS_TOKEN = "token_prod";
    process.env.SHOPIFY_PROD_API_VERSION = "2024-01";
    process.env.SHOPIFY_TEST_SHOP_DOMAIN = SHOPIFY_TESTING_HOST;
    process.env.SHOPIFY_TEST_ACCESS_TOKEN = "token_test";
    process.env.SHOPIFY_TEST_API_VERSION = "2024-01";
    process.env.SHOPIFY_PROD_WEBHOOK_SECRET = "w";
    process.env.SHOPIFY_TEST_WEBHOOK_SECRET = "w";

    const { resolveShopifyAdminCredentials } = await import("@/lib/clients/shopify");
    const active = resolveShopifyAdminCredentials(undefined);
    expect(active.shopDomain).toBe(SHOPIFY_TESTING_HOST);
    expect(active.accessToken).toBe("token_test");
  });

  it("static location mappings use TEST location env when mode is test", async () => {
    process.env.SHOPIFY_STORE_MODE = "test";
    process.env.NODE_ENV = "test";
    process.env.SHOPIFY_PROD_SHOP_DOMAIN = SHOPIFY_PRODUCTION_HOST;
    process.env.SHOPIFY_PROD_ACCESS_TOKEN = "p";
    process.env.SHOPIFY_TEST_SHOP_DOMAIN = SHOPIFY_TESTING_HOST;
    process.env.SHOPIFY_TEST_ACCESS_TOKEN = "t";
    process.env.SHOPIFY_TEST_LOCATION_GPS = "test-loc-gps";
    process.env.SHOPIFY_TEST_LOCATION_GPS_UK = "test-loc-gps-uk";
    process.env.SHOPIFY_TEST_LOCATION_STORD = "test-loc-stord";
    process.env.SHOPIFY_TEST_LOCATION_HK = "";

    const { PRODUCTION_LOCATION_MAPPINGS } = await import("@/lib/mappings/production-location-ids");
    const gps = PRODUCTION_LOCATION_MAPPINGS.find((m) => m.warehouseName === "GPS Warehouse");
    const uk = PRODUCTION_LOCATION_MAPPINGS.find((m) => m.warehouseName === "GPS UK Warehouse");
    expect(gps?.shopifyLocationId).toBe("test-loc-gps");
    expect(uk?.shopifyLocationId).toBe("test-loc-gps-uk");
    expect(PRODUCTION_LOCATION_MAPPINGS.some((m) => m.warehouseName === "HK Warehouse")).toBe(
      false
    );
  });

  it("static location mappings use PROD location env when mode is production", async () => {
    process.env.SHOPIFY_STORE_MODE = "production";
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_PROD_SHOP_DOMAIN = SHOPIFY_PRODUCTION_HOST;
    process.env.SHOPIFY_PROD_ACCESS_TOKEN = "p";
    process.env.SHOPIFY_TEST_SHOP_DOMAIN = SHOPIFY_TESTING_HOST;
    process.env.SHOPIFY_TEST_ACCESS_TOKEN = "t";
    process.env.SHOPIFY_PROD_LOCATION_GPS = "prod-loc-gps";
    process.env.SHOPIFY_PROD_LOCATION_GPS_UK = "prod-loc-gps-uk";
    process.env.SHOPIFY_PROD_LOCATION_STORD = "prod-loc-stord";
    process.env.SHOPIFY_PROD_LOCATION_HK = "prod-loc-hk";

    const { PRODUCTION_LOCATION_MAPPINGS } = await import("@/lib/mappings/production-location-ids");
    expect(PRODUCTION_LOCATION_MAPPINGS).toHaveLength(4);
    const ids = new Set(PRODUCTION_LOCATION_MAPPINGS.map((m) => m.shopifyLocationId));
    expect(ids.has("prod-loc-gps")).toBe(true);
    expect(ids.has("prod-loc-hk")).toBe(true);
  });
});
