import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  config: {
    gps: {
      baseUrl: "https://gps-us.example",
      apiKey: "us-key",
      apiSecret: "us-secret",
      warehouseCode: "US-WH",
    },
    gpsUk: {
      baseUrl: "https://gps-uk.example",
      apiKey: "uk-key",
      apiSecret: "uk-secret",
      warehouseCode: "UK-WH",
    },
  },
}));

function successfulPage(products: Array<Record<string, unknown>>, total: number): Response {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({
      code: 200,
      data: { list: products, total },
    }),
  } as unknown as Response;
}

describe("GPS product inventory pagination", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.OMS_CLIENT_MIN_INTERVAL_MS = "0";
    process.env.OMS_MAX_INVENTORY_PAGE_SIZE = "100";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OMS_CLIENT_MIN_INTERVAL_MS;
    delete process.env.OMS_MAX_INVENTORY_PAGE_SIZE;
  });

  it("loads every page when an unfiltered inventory contains more than 100 products", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      sku: `SKU-${index + 1}`,
      availableQty: index + 1,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(successfulPage(firstPage, 101))
      .mockResolvedValueOnce(successfulPage([{ sku: "SKU-101", availableQty: 101 }], 101));
    vi.stubGlobal("fetch", fetchMock);
    const { queryProductInventory } = await import("../gps-inventory");

    const products = await queryProductInventory({ region: "US" });

    expect(products).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestPages = fetchMock.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body));
      return body.data.page;
    });
    expect(requestPages).toEqual([1, 2]);
  });

  it("fails instead of returning a partial inventory when pagination ends early", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      sku: `SKU-${index + 1}`,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(successfulPage(firstPage, 101))
      .mockResolvedValueOnce(successfulPage([], 101));
    vi.stubGlobal("fetch", fetchMock);
    const { queryProductInventory } = await import("../gps-inventory");

    await expect(queryProductInventory({ region: "US" })).rejects.toThrow(
      "pagination ended after 100 of 101 products"
    );
  });
});
