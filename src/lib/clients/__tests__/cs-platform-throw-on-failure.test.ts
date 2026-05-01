import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

describe("cs-platform sendOrderEvent rethrows on failure", () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.CS_PLATFORM_ENABLED = "true";
    process.env.CS_PLATFORM_URL = "https://hub.example.com";
    process.env.CS_PLATFORM_WEBHOOK_SECRET = "test-secret";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    process.env = { ...envSnapshot };
  });

  it("throws when the Hub webhook returns a non-2xx", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("simulated 500", { status: 500, statusText: "Server Error" })
      );

    const { sendOrderUpdate } = await import("../cs-platform");

    await expect(
      sendOrderUpdate({
        shopifyOrderId: "1",
        shopifyOrderName: "IM8-TEST",
        status: "backorder",
      })
    ).rejects.toThrow(/CS Platform webhook failed/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws when fetch itself rejects (network blip)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));

    const { sendOrderUpdate } = await import("../cs-platform");

    await expect(
      sendOrderUpdate({
        shopifyOrderId: "1",
        shopifyOrderName: "IM8-TEST",
        status: "backorder",
      })
    ).rejects.toThrow(/ECONNRESET/);
  });

  it("does not throw when CS Platform is disabled (no-op short-circuit)", async () => {
    process.env.CS_PLATFORM_ENABLED = "false";
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const { sendOrderUpdate } = await import("../cs-platform");

    await expect(
      sendOrderUpdate({ shopifyOrderId: "1", shopifyOrderName: "IM8-TEST" })
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
