import { afterEach, describe, expect, it, vi } from "vitest";
const { graphql, auth } = vi.hoisted(() => ({
  graphql: vi.fn(),
  auth: vi.fn(async () => ({ access_token: "token" })),
}));
vi.mock("@/lib/clients/shopify", () => ({ shopifyAdminGraphql: graphql }));
vi.mock("@/lib/clients/dynamics", () => ({ authenticate: auth }));
vi.mock("@/lib/config", () => ({
  config: {
    dynamics: { baseUrl: "https://d365.example" },
    reconciliation: { orderPrefix: "IM8-", shopifyApiVersion: "2026-07" },
  },
}));
import { shopifyOrderNames } from "../shopify";
import { dynamicsOrderNames } from "../dynamics";
import { compareOrders } from "../compare";
import { reconciliationWindow } from "../window";
import { odataRows } from "@/lib/clients/dynamics/odata-pages";
const window = { start: "2026-10-20T00:00:00.000Z", end: "2026-10-21T00:00:00.000Z" };
const now = new Date("2026-10-27T12:00:00Z");
const page = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage, endCursor },
});
afterEach(() => {
  vi.restoreAllMocks();
  graphql.mockReset();
});

describe("direct provider reconciliation", () => {
  it("validates complete UTC days, leap dates, inverted and bounded ranges", () => {
    expect(reconciliationWindow(undefined, undefined, now)).toEqual({
      start: "2026-10-26T00:00:00.000Z",
      end: "2026-10-27T00:00:00.000Z",
    });
    for (const range of [
      ["2026-02-30", "2026-03-01"],
      ["2026-10-20", "2026-10-19"],
      ["2026-10-27", "2026-10-27"],
      ["2026-01-01", "2026-03-01"],
    ])
      expect(() => reconciliationWindow(range[0], range[1], now)).toThrow();
  });

  it("reports discrepancies in both directions and preserves company attribution", () => {
    expect(
      compareOrders(new Set(["IM8-1", "IM8-2"]), {
        U001: new Set(["IM8-1", "IM8-US"]),
        H007: new Set(["IM8-UK"]),
      })
    ).toEqual({
      shopifyCount: 2,
      dynamicsCount: 3,
      missingInDynamics: ["IM8-2"],
      missingInShopify: { U001: ["IM8-US"], H007: ["IM8-UK"] },
    });
  });

  it("reads fulfillment EVENT dates even for orders created outside the window", async () => {
    graphql
      .mockResolvedValueOnce({
        data: {
          events: page(
            [
              {
                createdAt: window.start,
                action: "fulfillment_success",
                subjectType: "ORDER",
                subject: { name: "IM8-old-order" },
              },
            ],
            true,
            "next"
          ),
        },
      })
      .mockResolvedValueOnce({
        data: {
          events: page([
            {
              createdAt: window.end,
              action: "fulfillment_success",
              subjectType: "ORDER",
              subject: { name: "IM8-outside" },
            },
          ]),
        },
      });
    expect([...(await shopifyOrderNames("fulfillment", window, now))]).toEqual(["IM8-old-order"]);
    expect(graphql.mock.calls[1][1].cursor).toBe("next");
    expect(graphql.mock.calls[0][1].search).toContain("action:fulfillment_success");
  });

  it("fails on missing pages, invalid dates, and repeated Shopify cursors", async () => {
    graphql.mockResolvedValue({ data: { orders: page([], true, "same") } });
    await expect(shopifyOrderNames("salesorder", window)).rejects.toThrow("repeated cursor");
    graphql.mockResolvedValue({ data: {} });
    await expect(shopifyOrderNames("salesorder", window)).rejects.toThrow("Incomplete");
    graphql.mockResolvedValue({ data: { orders: page([{ createdAt: "invalid" }]) } });
    await expect(shopifyOrderNames("salesorder", window)).rejects.toThrow("timestamp");
  });

  it("filters paid/refunded orders within the exact window", async () => {
    graphql.mockResolvedValue({
      data: {
        orders: page([
          {
            name: "IM8-paid",
            createdAt: window.start,
            cancelledAt: null,
            displayFinancialStatus: "PAID",
          },
          {
            name: "IM8-refunded",
            createdAt: window.start,
            cancelledAt: null,
            displayFinancialStatus: "REFUNDED",
          },
          { name: "IM8-outside", createdAt: window.end, displayFinancialStatus: "PAID" },
        ]),
      },
    });
    expect([...(await shopifyOrderNames("salesorder", window))]).toEqual([
      "IM8-paid",
      "IM8-refunded",
    ]);
  });

  it("reads packing slips and resolves their headers independently in both companies", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      const company = url.searchParams.get("$filter")!.includes("'u001'") ? "u001" : "h007";
      const value = url.pathname.includes("CustPackingSlip")
        ? [{ dataAreaId: company, SalesId: `${company}-SO`, DeliveryDate: window.start }]
        : [
            {
              dataAreaId: company,
              SalesOrderNumber: `${company}-SO`,
              THK_ShopifyReference: `IM8-${company}`,
            },
          ];
      return Response.json({ value });
    });
    const result = await dynamicsOrderNames("fulfillment", window);
    expect([...result.U001]).toEqual(["IM8-u001"]);
    expect([...result.H007]).toEqual(["IM8-h007"]);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[0][1]?.headers).toEqual({ Authorization: "Bearer token" });
    for (const call of fetch.mock.calls)
      expect(new URL(String(call[0])).searchParams.get("cross-company")).toBe("true");
  });

  it("fails when a packing slip cannot be mapped to a header", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      Response.json({
        value: String(input).includes("CustPackingSlip")
          ? [{ dataAreaId: "u001", SalesId: "lost", DeliveryDate: window.start }]
          : [],
      })
    );
    await expect(dynamicsOrderNames("fulfillment", window)).rejects.toThrow("no corresponding");
  });

  it("never forwards credentials to a foreign continuation or follows redirects", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ value: [], "@odata.nextLink": "https://attacker.example/data/Orders" })
      );
    const read = async () => {
      for await (const row of odataRows(new URL("https://d365.example/data/Orders"), "token"))
        void row;
    };
    await expect(read()).rejects.toThrow("Unsafe");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.redirect).toBe("error");
  });

  it("fails on repeated and malformed Dynamics pages", async () => {
    const url = new URL("https://d365.example/data/Orders");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ value: [], "@odata.nextLink": url.href }));
    const read = async () => {
      for await (const row of odataRows(url, "token")) void row;
    };
    await expect(read()).rejects.toThrow("repeated");
    fetch.mockResolvedValue(Response.json({}));
    await expect(read()).rejects.toThrow("Incomplete");
  });
});
