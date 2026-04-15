import { describe, it, expect, vi, afterEach } from "vitest";

describe("resolveShopifyWebhookSecret", () => {
  const envSnapshot = { ...process.env };

  afterEach(() => {
    vi.resetModules();
    process.env = { ...envSnapshot };
  });

  it("uses PROD webhook secret when shop domain matches SHOPIFY_PROD_SHOP_DOMAIN", async () => {
    process.env.SHOPIFY_STORE_MODE = "test";
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_PROD_SHOP_DOMAIN = "fixture-prod.myshopify.com";
    process.env.SHOPIFY_PROD_WEBHOOK_SECRET = "secret-prod";
    process.env.SHOPIFY_TEST_SHOP_DOMAIN = "dev.myshopify.com";
    process.env.SHOPIFY_TEST_WEBHOOK_SECRET = "secret-test";
    process.env.SHOPIFY_TEST_ACCESS_TOKEN = "x";
    process.env.SHOPIFY_PROD_ACCESS_TOKEN = "y";

    const { resolveShopifyWebhookSecret } = await import("../shopify");
    expect(resolveShopifyWebhookSecret("fixture-prod.myshopify.com")).toBe("secret-prod");
    expect(resolveShopifyWebhookSecret("FIXTURE-PROD.myshopify.com")).toBe("secret-prod");
  });

  it("uses TEST secret when shop matches test domain", async () => {
    process.env.SHOPIFY_STORE_MODE = "production";
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_PROD_SHOP_DOMAIN = "prod.myshopify.com";
    process.env.SHOPIFY_PROD_WEBHOOK_SECRET = "secret-prod";
    process.env.SHOPIFY_TEST_SHOP_DOMAIN = "dev.myshopify.com";
    process.env.SHOPIFY_TEST_WEBHOOK_SECRET = "secret-test";
    process.env.SHOPIFY_PROD_ACCESS_TOKEN = "x";
    process.env.SHOPIFY_TEST_ACCESS_TOKEN = "y";

    const { resolveShopifyWebhookSecret } = await import("../shopify");
    expect(resolveShopifyWebhookSecret("dev.myshopify.com")).toBe("secret-test");
  });

  it("when PROD and TEST shop domains are identical, uses SHOPIFY_STORE_MODE to pick secret", async () => {
    process.env.SHOPIFY_PROD_SHOP_DOMAIN = "same.myshopify.com";
    process.env.SHOPIFY_TEST_SHOP_DOMAIN = "same.myshopify.com";
    process.env.SHOPIFY_PROD_WEBHOOK_SECRET = "secret-prod";
    process.env.SHOPIFY_TEST_WEBHOOK_SECRET = "secret-test";
    process.env.SHOPIFY_PROD_ACCESS_TOKEN = "x";
    process.env.SHOPIFY_TEST_ACCESS_TOKEN = "y";

    process.env.SHOPIFY_STORE_MODE = "test";
    process.env.NODE_ENV = "production";
    const modTest = await import("../shopify");
    expect(modTest.resolveShopifyWebhookSecret("same.myshopify.com")).toBe("secret-test");

    vi.resetModules();
    process.env = { ...envSnapshot };
    process.env.SHOPIFY_PROD_SHOP_DOMAIN = "same.myshopify.com";
    process.env.SHOPIFY_TEST_SHOP_DOMAIN = "same.myshopify.com";
    process.env.SHOPIFY_PROD_WEBHOOK_SECRET = "secret-prod";
    process.env.SHOPIFY_TEST_WEBHOOK_SECRET = "secret-test";
    process.env.SHOPIFY_PROD_ACCESS_TOKEN = "x";
    process.env.SHOPIFY_TEST_ACCESS_TOKEN = "y";
    process.env.SHOPIFY_STORE_MODE = "production";
    process.env.NODE_ENV = "production";
    const modProd = await import("../shopify");
    expect(modProd.resolveShopifyWebhookSecret("same.myshopify.com")).toBe("secret-prod");
  });
});
