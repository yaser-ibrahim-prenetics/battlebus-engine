import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  acquireProviderCapacity,
  releaseProviderCapacity,
  withProviderCapacity,
} from "@/lib/services/provider-capacity";

const connectionString = process.env.PROVIDER_CAPACITY_TEST_DATABASE_URL;

describe.skipIf(!connectionString)("shared provider capacity PostgreSQL contract", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString });
  });

  afterEach(async () => {
    await pool.query(
      `UPDATE public.provider_capacity_leases
       SET lease_token = NULL, lease_owner = NULL, operation_digest = NULL,
         leased_at = NULL, lease_until = NULL`
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("serializes callers that share a provider limit", async () => {
    let firstEntered = false;
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withProviderCapacity(
      "d365",
      "integration:first",
      async () => {
        firstEntered = true;
        await firstCanFinish;
        return "first";
      },
      {
        enabled: true,
        pool,
        limit: 1,
        acquireTimeoutMs: 2_000,
        pollIntervalMs: 25,
      }
    );

    while (!firstEntered) await new Promise((resolve) => setTimeout(resolve, 5));
    let secondEntered = false;
    const second = withProviderCapacity(
      "d365",
      "integration:second",
      async () => {
        secondEntered = true;
        return "second";
      },
      {
        enabled: true,
        pool,
        limit: 1,
        acquireTimeoutMs: 2_000,
        pollIntervalMs: 25,
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(secondEntered).toBe(false);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
  });

  it("keeps capacity isolated between providers", async () => {
    let releaseGps!: () => void;
    const gpsCanFinish = new Promise<void>((resolve) => {
      releaseGps = resolve;
    });
    let gpsEntered = false;
    const gps = withProviderCapacity(
      "gps",
      "integration:gps",
      async () => {
        gpsEntered = true;
        await gpsCanFinish;
      },
      { enabled: true, pool, limit: 1 }
    );

    while (!gpsEntered) await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(
      withProviderCapacity("shopify", "integration:shopify", async () => "shopify", {
        enabled: true,
        pool,
        limit: 1,
      })
    ).resolves.toBe("shopify");
    releaseGps();
    await gps;
  });

  it("reclaims expired slots without allowing a stale owner to release them", async () => {
    const stale = await acquireProviderCapacity("loop", "integration:stale", {
      pool,
      limit: 1,
    });
    await pool.query(
      `UPDATE public.provider_capacity_leases
       SET leased_at = clock_timestamp() - interval '2 seconds',
         lease_until = clock_timestamp() - interval '1 second'
       WHERE provider = $1 AND slot = $2`,
      [stale.provider, stale.slot]
    );

    const current = await acquireProviderCapacity("loop", `integration:${randomUUID()}`, {
      pool,
      limit: 1,
    });
    expect(current.leaseToken).not.toBe(stale.leaseToken);
    await expect(releaseProviderCapacity(stale, pool)).resolves.toBe(false);
    await expect(releaseProviderCapacity(current, pool)).resolves.toBe(true);
  });
});
