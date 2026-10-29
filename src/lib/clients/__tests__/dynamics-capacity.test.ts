import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.D365_CLIENT_MIN_INTERVAL_MS = "0";
});

const capacity = vi.hoisted(() => {
  class ProviderCapacityTimeoutError extends Error {
    constructor() {
      super("Shared d365 provider capacity is temporarily exhausted");
      this.name = "ProviderCapacityTimeoutError";
    }
  }
  class ProviderCapacityDatabaseTimeoutError extends Error {
    constructor() {
      super("Shared provider capacity database query timed out");
      this.name = "ProviderCapacityDatabaseTimeoutError";
    }
  }
  return {
    ProviderCapacityDatabaseTimeoutError,
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

  it("re-arms a half-open probe when local capacity is exhausted", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const providerFailure = new Error("provider unavailable");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(providerFailure));
    capacity.withProviderCapacity.mockImplementation(
      async (_provider: string, _operation: string, execute: () => Promise<Response>) => execute()
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(pacedFetch("https://d365.example/data/test")).rejects.toBe(providerFailure);
    }
    expect(getCircuitState().state).toBe("OPEN");

    now += 30_001;
    capacity.withProviderCapacity.mockRejectedValueOnce(
      new capacity.ProviderCapacityDatabaseTimeoutError()
    );
    await expect(pacedFetch("https://d365.example/data/probe")).rejects.toBeInstanceOf(
      capacity.ProviderCapacityDatabaseTimeoutError
    );
    expect(getCircuitState().state).toBe("OPEN");

    capacity.withProviderCapacity.mockImplementation(
      async (_provider: string, _operation: string, execute: () => Promise<Response>) => execute()
    );
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await expect(pacedFetch("https://d365.example/data/probe")).resolves.toBeInstanceOf(Response);
    expect(getCircuitState()).toMatchObject({ state: "CLOSED", consecutiveFailures: 0 });

    clock.mockRestore();
    vi.unstubAllGlobals();
  });
});
