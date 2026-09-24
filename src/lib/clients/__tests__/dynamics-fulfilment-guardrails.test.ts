import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/supabase-flow-logs", () => ({
  logFlowEvent: vi.fn(),
}));

const tokenResponse = () =>
  new Response(
    JSON.stringify({
      access_token: "test-token",
      token_type: "Bearer",
      expires_in: 3600,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("D365 fulfilment guardrails", () => {
  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).__d365_token_cache__;
    delete (globalThis as Record<string, unknown>).__d365_token_inflight__;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not promote a mixed warehouse warning and invoice failure to success", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("login.microsoftonline.com")) {
        return tokenResponse();
      }
      if (url.includes("/fulfilment")) {
        return jsonResponse({
          status: 0,
          Message:
            "Dimension Warehouse is still specified on the inventory transaction; line failed to invoice",
          Result: "",
          $id: "test-response",
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { createFulfilment } = await import("../dynamics");

    await expect(
      createFulfilment({
        salesOrderNumber: "H007-SO-119969",
        dataAreaId: "h007",
        type: "shipment",
        confirmedShippedDate: "2026-09-21",
        lines: [
          {
            itemNumber: "IM8-FG-000219",
            quantity: 1,
            shippingSiteId: "H007",
            lotId: "LOT-001",
          },
        ],
      })
    ).rejects.toThrow(/failed to invoice/);
  });

  it("rejects a deposit shipment whose header remains partially invoiced", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("login.microsoftonline.com")) {
        return tokenResponse();
      }
      if (url.includes("SalesOrderHeadersV3")) {
        return jsonResponse({
          SalesOrderNumber: "H007-SO-119969",
          dataAreaId: "h007",
          THK_DepositFulfillment: "Yes",
          SalesOrderProcessingStatus: "PartiallyInvoiced",
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { assertDepositShipmentInvoicingComplete } = await import("../dynamics");

    await expect(
      assertDepositShipmentInvoicingComplete(
        "H007-SO-119969",
        "h007",
        {
          Message: "Dimension Warehouse is still specified on the inventory transaction",
        },
        { depositFulfillment: true }
      )
    ).rejects.toThrow(/missing Standard invoice.*PartiallyInvoiced/);
  });

  it("rejects a deposit shipment when OData verification fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("login.microsoftonline.com")) {
        return tokenResponse();
      }
      if (url.includes("SalesOrderHeadersV3")) {
        return new Response("service unavailable", { status: 503 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { assertDepositShipmentInvoicingComplete } = await import("../dynamics");

    await expect(
      assertDepositShipmentInvoicingComplete(
        "H007-SO-119969",
        "h007",
        { Message: "Number of vouchers posted to the journal: 1" },
        { depositFulfillment: true }
      )
    ).rejects.toThrow(/missing Standard invoice.*SalesOrderProcessingStatus=n\/a/);
  });
});
