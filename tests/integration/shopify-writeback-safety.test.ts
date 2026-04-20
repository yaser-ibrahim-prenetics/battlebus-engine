import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEY = "ENABLE_SHOPIFY_FULFILLMENT_WRITEBACK";
const originalValue = process.env[ENV_KEY];

async function loadConfigFresh() {
  vi.resetModules();
  const mod = await import("@/lib/config");
  return mod.config;
}

describe("Shopify fulfillment writeback safety gate", () => {
  afterEach(() => {
    if (originalValue === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalValue;
  });

  it("defaults to writeback OFF when env var is unset", async () => {
    delete process.env[ENV_KEY];
    const config = await loadConfigFresh();
    expect(config.features.enableShopifyFulfillmentWriteback).toBe(false);
  });

  it("enables writeback only when env var is true", async () => {
    process.env[ENV_KEY] = "true";
    const config = await loadConfigFresh();
    expect(config.features.enableShopifyFulfillmentWriteback).toBe(true);
  });

  it("keeps writeback OFF for non-true values", async () => {
    process.env[ENV_KEY] = "false";
    let config = await loadConfigFresh();
    expect(config.features.enableShopifyFulfillmentWriteback).toBe(false);

    process.env[ENV_KEY] = "1";
    config = await loadConfigFresh();
    expect(config.features.enableShopifyFulfillmentWriteback).toBe(false);
  });
});
