import { describe, expect, it } from "vitest";

import { createGpsIndividualBatchId } from "../stable-id";

describe("stable webhook operation identities", () => {
  it("uses the same GPS batch identity for equivalent retries", () => {
    const first = createGpsIndividualBatchId("us", ["order-2", "order-1", "order-1"]);
    const retry = createGpsIndividualBatchId("US", ["order-1", "order-2"]);

    expect(first).toBe(retry);
    expect(first).toMatch(/^GPSB-[a-f0-9]{32}$/);
  });

  it("changes the GPS batch identity when its semantic scope changes", () => {
    expect(createGpsIndividualBatchId("US", ["order-1"])).not.toBe(
      createGpsIndividualBatchId("UK", ["order-1"])
    );
    expect(createGpsIndividualBatchId("US", ["order-1"])).not.toBe(
      createGpsIndividualBatchId("US", ["order-2"])
    );
  });
});
