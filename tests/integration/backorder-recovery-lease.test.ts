import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  acquireBackorderRecoveryLeaseSQL,
  releaseBackorderRecoveryLeaseSQL,
  renewBackorderRecoveryLeaseSQL,
} from "@/lib/sql/backorder-recovery/lease";

const connectionString = process.env.BACKORDER_RECOVERY_TEST_DATABASE_URL;

describe.skipIf(!connectionString)("backorder recovery PostgreSQL lease", () => {
  let pool: Pool;
  const orderPrefix = "backorder-recovery-contract-";

  beforeAll(() => {
    pool = new Pool({ connectionString });
  });

  afterEach(async () => {
    await pool.query("DELETE FROM public.backorder_recovery_leases WHERE order_id LIKE $1", [
      `${orderPrefix}%`,
    ]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  function acquire(orderId: string, token: string, operationKey: string) {
    return pool.query(acquireBackorderRecoveryLeaseSQL, [
      "lease-test.myshopify.com",
      orderId,
      token,
      600,
      operationKey,
      `worker:${operationKey}`,
    ]);
  }

  it("allows only one concurrent recovery attempt for an order", async () => {
    const orderId = `${orderPrefix}concurrent`;
    const [first, second] = await Promise.all([
      acquire(orderId, randomUUID(), "retry:first"),
      acquire(orderId, randomUUID(), "retry:second"),
    ]);

    expect([first.rowCount, second.rowCount].sort()).toEqual([0, 1]);
  });

  it("releases only the exact lease token", async () => {
    const orderId = `${orderPrefix}release`;
    const token = randomUUID();
    expect((await acquire(orderId, token, "retry:release")).rowCount).toBe(1);

    const wrongRelease = await pool.query(releaseBackorderRecoveryLeaseSQL, [
      "lease-test.myshopify.com",
      orderId,
      randomUUID(),
      "retry:wrong-release",
      "worker:retry:wrong-release",
    ]);
    expect(wrongRelease.rowCount).toBe(0);

    const release = await pool.query(releaseBackorderRecoveryLeaseSQL, [
      "lease-test.myshopify.com",
      orderId,
      token,
      "retry:release",
      "worker:retry:release",
    ]);
    expect(release.rowCount).toBe(1);

    const replayedRelease = await pool.query(releaseBackorderRecoveryLeaseSQL, [
      "lease-test.myshopify.com",
      orderId,
      token,
      "retry:release",
      "worker:retry:release",
    ]);
    expect(replayedRelease.rowCount).toBe(1);

    const newerToken = randomUUID();
    expect((await acquire(orderId, newerToken, "retry:new-owner")).rowCount).toBe(1);
    const staleRelease = await pool.query(releaseBackorderRecoveryLeaseSQL, [
      "lease-test.myshopify.com",
      orderId,
      token,
      "retry:release",
      "worker:retry:release",
    ]);
    expect(staleRelease.rowCount).toBe(0);
    const active = await pool.query<{ lease_token: string }>(
      `SELECT lease_token
       FROM public.backorder_recovery_leases
       WHERE shopify_store = $1 AND order_id = $2`,
      ["lease-test.myshopify.com", orderId]
    );
    expect(active.rows[0].lease_token).toBe(newerToken);
  });

  it("renews or reacquires only the replay-stable lease owner", async () => {
    const orderId = `${orderPrefix}renew`;
    const token = randomUUID();
    const operationKey = "retry:renew";
    const owner = `worker:${operationKey}`;
    expect((await acquire(orderId, token, operationKey)).rowCount).toBe(1);

    const wrongRenewal = await pool.query(renewBackorderRecoveryLeaseSQL, [
      "lease-test.myshopify.com",
      orderId,
      randomUUID(),
      600,
      operationKey,
      owner,
    ]);
    expect(wrongRenewal.rowCount).toBe(0);

    const renewal = await pool.query(renewBackorderRecoveryLeaseSQL, [
      "lease-test.myshopify.com",
      orderId,
      token,
      600,
      operationKey,
      owner,
    ]);
    expect(renewal.rowCount).toBe(1);

    expect(
      (
        await pool.query(releaseBackorderRecoveryLeaseSQL, [
          "lease-test.myshopify.com",
          orderId,
          token,
          operationKey,
          owner,
        ])
      ).rowCount
    ).toBe(1);

    const replayRenewal = await pool.query(renewBackorderRecoveryLeaseSQL, [
      "lease-test.myshopify.com",
      orderId,
      token,
      600,
      operationKey,
      owner,
    ]);
    expect(replayRenewal.rowCount).toBe(1);
  });

  it("recovers a lease after its bounded expiry", async () => {
    const orderId = `${orderPrefix}expired`;
    expect((await acquire(orderId, randomUUID(), "retry:expired:first")).rowCount).toBe(1);
    await pool.query(
      `UPDATE public.backorder_recovery_leases
       SET acquired_at = now() - interval '20 minutes',
           lease_expires_at = now() - interval '10 minutes'
       WHERE shopify_store = $1 AND order_id = $2`,
      ["lease-test.myshopify.com", orderId]
    );

    const reclaimed = await acquire(orderId, randomUUID(), "retry:expired:second");
    expect(reclaimed.rowCount).toBe(1);
  });
});
