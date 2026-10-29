import { describe, expect, it } from "vitest";
import type * as dynamics from "@/lib/clients/dynamics";
import {
  d365FulfillmentEvidenceCodec,
  gpsOutboundOrderEvidenceCodec,
} from "../mutation-evidence";
import {
  MAX_OOS_MUTATION_FAILURE_BYTES,
  serializeOosRecoveryMutationFailure,
} from "../outcomes";

describe("OOS mutation evidence", () => {
  it("normalizes arbitrarily large D365 responses into a bounded semantic projection", () => {
    const result = {
      response: {
        status: 1,
        Message:
          `${"customer detail ".repeat(2_000)} dimension warehouse is still specified; ` +
          "number of vouchers posted to the journal: 7",
        Result: "provider result ".repeat(2_000),
        $id: "provider-id-".repeat(2_000),
      },
      request: {},
    } satisfies Awaited<ReturnType<typeof dynamics.createFulfilment>>;

    const evidence = d365FulfillmentEvidenceCodec.encode(result);
    expect(new TextEncoder().encode(JSON.stringify(evidence)).length).toBeLessThan(4_096);
    expect(JSON.stringify(evidence)).not.toContain("customer detail");
    expect(d365FulfillmentEvidenceCodec.decode(evidence).response).toMatchObject({
      status: 1,
      Message:
        "Dimension warehouse is still specified;Number of vouchers posted to the journal: 1",
    });
  });

  it("round-trips only the GPS provider order identifier", () => {
    const evidence = gpsOutboundOrderEvidenceCodec.encode({
      response: { code: 0, message: "accepted", data: [{ orderNo: "GPS-123" }] },
      request: {},
    } as Parameters<typeof gpsOutboundOrderEvidenceCodec.encode>[0]);
    expect(evidence).toEqual({ orderNo: "GPS-123" });
    expect(gpsOutboundOrderEvidenceCodec.decode(evidence).response.data?.[0]?.orderNo).toBe(
      "GPS-123"
    );
  });

  it("keeps 500 maximum-size ordinary dependency references within the durable cap", () => {
    const payload = serializeOosRecoveryMutationFailure({
      provider: "d365",
      category: "inventory_insufficient",
      blockedItems: Array.from({ length: 500 }, (_, index) => ({
        provider: "d365" as const,
        warehouse: "D365-WAREHOUSE",
        sku: `SKU-${String(index).padStart(4, "0")}-${"X".repeat(80)}`,
        orderLineId: `gid://shopify/LineItem/${String(index).padStart(4, "0")}-${"9".repeat(48)}`,
        quantityNeeded: 1,
      })),
      providerOrderNumber: "SO-123",
      providerWarehouse: "D365-WAREHOUSE",
    });
    const bytes = new TextEncoder().encode(payload).length;
    expect(bytes).toBeGreaterThan(65_536);
    expect(bytes).toBeLessThanOrEqual(MAX_OOS_MUTATION_FAILURE_BYTES);
  });
});
