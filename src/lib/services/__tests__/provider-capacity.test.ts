import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
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
});
