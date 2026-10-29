import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  acquireProviderCapacity,
  ProviderCapacityDatabaseTimeoutError,
  ProviderCapacityStoreError,
  ProviderCapacityTimeoutError,
  releaseProviderCapacity,
  withProviderCapacity,
} from "../provider-capacity";

describe("shared provider capacity", () => {
  it("performs no database work while the rollout gate is disabled", async () => {
    const execute = vi.fn(async () => "ok");

    await expect(
      withProviderCapacity("d365", "test:disabled", execute, { enabled: false })
    ).resolves.toBe("ok");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fails safely before provider work when capacity cannot be acquired", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const execute = vi.fn(async () => "must-not-run");

    await expect(
      withProviderCapacity("gps", "test:exhausted", execute, {
        enabled: true,
        pool: { query } as unknown as Pool,
        limit: 1,
        acquireTimeoutMs: 1,
        pollIntervalMs: 25,
      })
    ).rejects.toBeInstanceOf(ProviderCapacityTimeoutError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not release a slot when exact lease ownership no longer matches", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    await expect(
      releaseProviderCapacity(
        {
          provider: "shopify",
          slot: 1,
          leaseToken: "00000000-0000-4000-8000-000000000001",
          leaseOwner: "00000000-0000-4000-8000-000000000002",
          leaseUntil: "2026-10-29T00:00:00.000Z",
        },
        { query } as unknown as Pool
      )
    ).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("contains renewal failure and still releases after provider work completes", async () => {
    vi.useFakeTimers();
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            provider: "shopify",
            slot: 1,
            lease_token: "00000000-0000-4000-8000-000000000001",
            lease_owner: "00000000-0000-4000-8000-000000000002",
            lease_until: "2026-10-29T00:02:00.000Z",
          },
        ],
        rowCount: 1,
      })
      .mockRejectedValueOnce(new Error("transient database failure"))
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    let finishProvider!: () => void;
    const providerFinished = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = withProviderCapacity(
      "shopify",
      "test:renewal-failure",
      async () => {
        await providerFinished;
        return "confirmed";
      },
      { enabled: true, pool: { query } as unknown as Pool, leaseSeconds: 120 }
    );

    await vi.advanceTimersByTimeAsync(40_000);
    finishProvider();
    await expect(result).resolves.toBe("confirmed");
    expect(query).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith(
      "[ProviderCapacity] Lost shopify capacity lease 1 cause=Error"
    );
    error.mockRestore();
    vi.useRealTimers();
  });

  it("bounds each stalled capacity claim before the overall acquisition deadline", async () => {
    vi.useFakeTimers();
    const query = vi.fn(() => new Promise(() => undefined));
    const startedAt = Date.now();

    const result = acquireProviderCapacity("gps", "test:stalled-claim", {
      pool: { query } as unknown as Pool,
      acquireTimeoutMs: 5_000,
    });
    const expectation = expect(result).rejects.toBeInstanceOf(ProviderCapacityDatabaseTimeoutError);
    await vi.advanceTimersByTimeAsync(2_000);
    await expectation;
    const queryConfig = query.mock.calls[0][0] as {
      text: string;
      values: unknown[];
    };
    expect(queryConfig.text).toContain("clock_timestamp() < $7::timestamptz");
    const attemptDeadline = Date.parse(String(queryConfig.values[6]));
    expect(attemptDeadline).toBeGreaterThanOrEqual(startedAt);
    expect(attemptDeadline).toBeLessThanOrEqual(startedAt + 2_000);
    vi.useRealTimers();
  });

  it("preserves a safe database cause when capacity acquisition fails", async () => {
    const databaseError = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const query = vi.fn().mockRejectedValue(databaseError);

    const result = acquireProviderCapacity("d365", "test:store-failure", {
      pool: { query } as unknown as Pool,
    });

    await expect(result).rejects.toMatchObject({
      name: "ProviderCapacityStoreError",
      message: "Shared d365 provider capacity store is unavailable",
      cause: databaseError,
      causeCode: "42P01",
    } satisfies Partial<ProviderCapacityStoreError>);
  });

  it("returns confirmed provider work after a bounded stalled release", async () => {
    vi.useFakeTimers();
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            provider: "d365",
            slot: 1,
            lease_token: "00000000-0000-4000-8000-000000000003",
            lease_owner: "00000000-0000-4000-8000-000000000004",
            lease_until: "2026-10-29T00:02:00.000Z",
          },
        ],
        rowCount: 1,
      })
      .mockImplementationOnce(() => new Promise(() => undefined));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = withProviderCapacity("d365", "test:stalled-release", async () => "confirmed", {
      enabled: true,
      pool: { query } as unknown as Pool,
    });
    const expectation = expect(result).resolves.toBe("confirmed");
    await vi.advanceTimersByTimeAsync(2_000);
    await expectation;
    expect(error).toHaveBeenCalledWith(
      "[ProviderCapacity] Failed to release d365 capacity lease 1 cause=ProviderCapacityDatabaseTimeoutError"
    );
    error.mockRestore();
    vi.useRealTimers();
  });
});
