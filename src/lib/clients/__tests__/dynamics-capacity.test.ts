import { beforeEach, describe, expect, it, vi } from "vitest";

const capacity = vi.hoisted(() => {
  class ProviderCapacityTimeoutError extends Error {
    constructor() {
      super("Shared d365 provider capacity is temporarily exhausted");
      this.name = "ProviderCapacityTimeoutError";
    }
  }
  return {
    ProviderCapacityTimeoutError,
    withProviderCapacity: vi.fn(),
  };
});

vi.mock("@/lib/config", () => ({ config: { providerCapacity: { enabled: true } } }));
vi.mock("@/lib/services/provider-capacity", () => capacity);
vi.mock("@/lib/services/flow-logs", () => ({ logFlowEvent: vi.fn() }));

import { getCircuitState, pacedFetch } from "../dynamics";

describe("D365 shared capacity backpressure", () => {
  beforeEach(() => {
    capacity.withProviderCapacity.mockReset();
    capacity.withProviderCapacity.mockRejectedValue(new capacity.ProviderCapacityTimeoutError());
  });

  it("does not count local capacity exhaustion as a provider circuit failure", async () => {
    expect(getCircuitState()).toMatchObject({ state: "CLOSED", consecutiveFailures: 0 });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(pacedFetch("https://d365.example/data/test")).rejects.toBeInstanceOf(
        capacity.ProviderCapacityTimeoutError
      );
    }

    expect(getCircuitState()).toMatchObject({ state: "CLOSED", consecutiveFailures: 0 });
  });
});
