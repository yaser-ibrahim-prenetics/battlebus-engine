import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  gpsQuery: vi.fn(),
  graphql: vi.fn(),
  location: vi.fn(),
  setInventory: vi.fn(),
}));

vi.mock("@/lib/services/reconciliation-history/record", () => ({
  recordReconciliation: async <T>(
    _context: unknown,
    execute: () => Promise<T>
  ): Promise<T> => execute(),
}));
vi.mock("@/lib/clients/gps-inventory", () => ({
  queryProductInventory: mocks.gpsQuery,
  getInventorySnapshot: vi.fn(),
}));
vi.mock("@/lib/clients/dynamics", () => ({
  authenticate: mocks.authenticate,
}));
vi.mock("@/lib/clients/gps", () => ({}));
vi.mock("@/lib/clients/shopify", () => ({
  shopifyAdminGraphql: mocks.graphql,
}));
vi.mock("@/lib/clients/shopify-inventory", () => ({
  setSkuInventoryAtLocation: mocks.setInventory,
  shopifyGid: (kind: string, value: string) =>
    value.startsWith("gid://shopify/") ? value : `gid://shopify/${kind}/${value}`,
}));
vi.mock("@/lib/transformers/sku", () => ({
  mapShopifySkuToDynamicsForOrderLine: (sku: string) => sku,
}));
vi.mock("@/lib/services/location-routing", () => ({
  getLocationIdForWarehouse: mocks.location,
}));

import { calculateDiscrepancies, runReconciliation } from "../inventory-sync";
import { config } from "@/lib/config";

describe("regional inventory reconciliation", () => {
  const originalDryRun = config.features.dryRunMode;
  const originalInventorySync = config.features.enableInventorySync;

  beforeEach(() => {
    vi.resetAllMocks();
    config.features.dryRunMode = false;
    config.features.enableInventorySync = true;
    mocks.authenticate.mockResolvedValue({ access_token: "token" });
    mocks.location.mockImplementation(async (warehouse: string) =>
      warehouse === "GPS UK Warehouse" ? "uk-location" : "us-location"
    );
    mocks.gpsQuery.mockImplementation(async ({ region }: { region: "US" | "UK" }) => [
      {
        sku: "SKU-1",
        availableQty: region === "UK" ? 20 : 10,
        lockedQty: 0,
        transitQty: 0,
      },
    ]);
    mocks.graphql.mockResolvedValue({
      data: {
        productVariants: {
          edges: [
            {
              node: {
                sku: "SKU-1",
                inventoryItem: {
                  inventoryLevels: {
                    edges: [
                      {
                        node: {
                          location: { id: "gid://shopify/Location/us-location" },
                          quantities: [{ name: "available", quantity: 5 }],
                        },
                      },
                      {
                        node: {
                          location: { id: "gid://shopify/Location/uk-location" },
                          quantities: [{ name: "available", quantity: 6 }],
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    });
    mocks.setInventory.mockResolvedValue({
      updated: 1,
      inventoryItemIds: ["gid://shopify/InventoryItem/1"],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const decodedUrl = decodeURIComponent(String(input));
        const available = decodedUrl.includes("dataAreaId eq 'H007'") ? 20 : 10;
        return {
          ok: true,
          json: async () => ({
            value: [
              {
                ItemNumber: "SKU-1",
                AvailablePhysical: available,
                ReservedOrdered: 0,
                OrderedInTotal: 0,
              },
            ],
          }),
          text: async () => "",
        } as Response;
      })
    );
  });

  afterAll(() => {
    config.features.dryRunMode = originalDryRun;
    config.features.enableInventorySync = originalInventorySync;
    vi.unstubAllGlobals();
  });

  it("compares and writes each warehouse with its own D365 company and Shopify location", async () => {
    await expect(calculateDiscrepancies(["SKU-1"])).resolves.toMatchObject([
      {
        sku: "SKU-1",
        warehouseName: "GPS Warehouse",
        dataAreaId: "U001",
        shopifyLocationId: "us-location",
        gpsLevel: 10,
        d365Level: 10,
        shopifyLevel: 5,
      },
      {
        sku: "SKU-1",
        warehouseName: "GPS UK Warehouse",
        dataAreaId: "H007",
        shopifyLocationId: "uk-location",
        gpsLevel: 20,
        d365Level: 20,
        shopifyLevel: 6,
      },
    ]);

    const result = await runReconciliation(["SKU-1"], undefined, true, "run-1");

    expect(result.skusChecked).toBe(2);
    expect(result.errors).toEqual([]);
    expect(mocks.setInventory).toHaveBeenCalledTimes(2);
    expect(mocks.setInventory.mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({
        sku: "SKU-1",
        locationId: "us-location",
        quantity: 10,
        idempotencyToken: "run-1:U001:SKU-1",
      }),
      expect.objectContaining({
        sku: "SKU-1",
        locationId: "uk-location",
        quantity: 20,
        idempotencyToken: "run-1:H007:SKU-1",
      }),
    ]);
  });
});
