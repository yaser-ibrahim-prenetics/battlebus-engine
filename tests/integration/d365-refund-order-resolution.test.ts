import { describe, it, expect, vi, beforeEach } from "vitest";
import * as dynamics from "@/lib/clients/dynamics";
import * as supabaseLookup from "@/lib/services/supabase-order-lookup";

vi.mock("@/lib/clients/dynamics", async () => {
  const actual = await vi.importActual<typeof dynamics>("@/lib/clients/dynamics");
  return {
    ...actual,
    getSalesOrderByShopifyId: vi.fn(),
    getSalesOrderByNumber: vi.fn(),
  };
});

vi.mock("@/lib/services/supabase-order-lookup", async () => {
  const actual = await vi.importActual<typeof supabaseLookup>(
    "@/lib/services/supabase-order-lookup"
  );
  return {
    ...actual,
    fetchD365HintByShopifyOrderId: vi.fn(),
  };
});

describe("resolveD365OrderHeaderForRefund (Supabase fallback)", () => {
  beforeEach(() => {
    vi.mocked(dynamics.getSalesOrderByShopifyId).mockReset();
    vi.mocked(dynamics.getSalesOrderByNumber).mockReset();
    vi.mocked(supabaseLookup.fetchD365HintByShopifyOrderId).mockReset();
    vi.mocked(dynamics.getSalesOrderByShopifyId).mockResolvedValue(null);
    vi.mocked(dynamics.getSalesOrderByNumber).mockResolvedValue(null);
    vi.mocked(supabaseLookup.fetchD365HintByShopifyOrderId).mockResolvedValue(null);
  });

  it("returns order from Shopify reference when D365 finds THK_ShopifyReference", async () => {
    vi.mocked(dynamics.getSalesOrderByShopifyId).mockImplementation(async (ref) =>
      ref === "#IM8-100" ? { SalesOrderNumber: "U001-SO-1", dataAreaId: "U001" } : null
    );

    const { resolveD365OrderHeaderForRefund } = await import(
      "@/lib/services/d365-refund-order-resolution"
    );

    const result = await resolveD365OrderHeaderForRefund({
      shopifyOrderId: "999",
      shopifyOrder: { name: "#IM8-100", shipping_address: { country_code: "US" } },
    });

    expect(result?.SalesOrderNumber).toBe("U001-SO-1");
    expect(supabaseLookup.fetchD365HintByShopifyOrderId).toHaveBeenCalledWith("999", "#IM8-100");
  });

  it("falls back to Supabase d365_order_number + getSalesOrderByNumber when ref lookup misses", async () => {
    vi.mocked(supabaseLookup.fetchD365HintByShopifyOrderId).mockResolvedValue({
      d365OrderNumber: "U001-SO-999",
      warehouse: "GPS Warehouse",
    });

    vi.mocked(dynamics.getSalesOrderByNumber).mockImplementation(async (so, area) => {
      if (so === "U001-SO-999" && area === "U001") {
        return { SalesOrderNumber: "U001-SO-999", dataAreaId: "U001" };
      }
      return null;
    });

    const { resolveD365OrderHeaderForRefund } = await import(
      "@/lib/services/d365-refund-order-resolution"
    );

    const result = await resolveD365OrderHeaderForRefund({
      shopifyOrderId: "6993154474216",
      shopifyOrder: { name: "#IM8-19171", shipping_address: { country_code: "US" } },
    });

    expect(result?.SalesOrderNumber).toBe("U001-SO-999");
    expect(supabaseLookup.fetchD365HintByShopifyOrderId).toHaveBeenCalledWith(
      "6993154474216",
      "#IM8-19171"
    );
    expect(dynamics.getSalesOrderByNumber).toHaveBeenCalled();
  });

  it("returns null when both ref lookup and Supabase SO number lookup miss", async () => {
    const { resolveD365OrderHeaderForRefund } = await import(
      "@/lib/services/d365-refund-order-resolution"
    );

    const result = await resolveD365OrderHeaderForRefund({
      shopifyOrderId: "1",
      shopifyOrder: { name: "#NONE", shipping_address: { country_code: "US" } },
    });

    expect(result).toBeNull();
  });
});
