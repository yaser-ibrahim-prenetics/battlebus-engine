import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock("@/lib/db/database", () => ({ getDatabasePool: getPool }));
import {
  executeFulfillmentAction,
  ConfirmedActionFailure,
  UncertainActionError,
} from "@/lib/services/fulfillment-actions/ledger";
import { actionKeys, type ActionIdentity } from "@/lib/services/fulfillment-actions/identity";

const identity: ActionIdentity = {
  provider: "gps",
  scope: "fixture",
  sourceOrderId: "ledger-test",
  sourceLineIds: ["line-1", "line-2"],
  action: "create",
};
const request = { sku: "fixture", quantity: 1 };

describe.skipIf(!process.env.FULFILLMENT_TEST_DATABASE_URL)("PostgreSQL fulfillment ledger", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.FULFILLMENT_TEST_DATABASE_URL });
  });
  beforeEach(async () => {
    getPool.mockResolvedValue(pool);
    await pool.query("DELETE FROM public.fulfillment_actions WHERE scope='fixture'");
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("executes once under concurrent workers and replays the saved provider result", async () => {
    const execute = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return "GPS-123";
    });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => executeFulfillmentAction(identity, request, execute))
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(await executeFulfillmentAction(identity, request, execute)).toBe("GPS-123");
    expect(execute).toHaveBeenCalledTimes(1);
    const rows = (
      await pool.query("SELECT status FROM public.fulfillment_actions WHERE scope='fixture'")
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "succeeded")).toBe(true);
  });

  it("blocks timed-out operations, including changed event IDs on the same lines", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("timeout after acceptance"));
    await expect(executeFulfillmentAction(identity, request, execute)).rejects.toBeInstanceOf(
      UncertainActionError
    );
    await expect(executeFulfillmentAction(identity, request, execute)).rejects.toBeInstanceOf(
      UncertainActionError
    );
    await expect(
      executeFulfillmentAction({ ...identity, action: "another-event" }, request, execute)
    ).rejects.toBeInstanceOf(UncertainActionError);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      (
        await pool.query(
          "SELECT DISTINCT status FROM public.fulfillment_actions WHERE scope='fixture'"
        )
      ).rows
    ).toEqual([{ status: "uncertain" }]);
  });

  it("permits a confirmed rejection to retry with a corrected request", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new ConfirmedActionFailure("out of stock"))
      .mockResolvedValue("GPS-456");
    await expect(executeFulfillmentAction(identity, request, execute)).rejects.toThrow(
      "out of stock"
    );
    expect(
      await executeFulfillmentAction(identity, { ...request, channel: "fallback" }, execute)
    ).toBe("GPS-456");
    expect(
      (
        await pool.query(
          "SELECT DISTINCT attempts FROM public.fulfillment_actions WHERE scope='fixture'"
        )
      ).rows
    ).toEqual([{ attempts: 2 }]);
  });

  it("never steals pending rows left by a crashed process", async () => {
    await executeFulfillmentAction(identity, request, async () => "GPS");
    await pool.query(
      "UPDATE public.fulfillment_actions SET status='pending', result=NULL, updated_at=now()-interval '7 days' WHERE scope='fixture'"
    );
    const execute = vi.fn();
    await expect(executeFulfillmentAction(identity, request, execute)).rejects.toBeInstanceOf(
      UncertainActionError
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not post again when completion persistence fails after provider success", async () => {
    const execute = vi.fn(async () => {
      // Force the atomic completion assertion to fail, like a fenced stale worker.
      await pool.query(
        "UPDATE public.fulfillment_actions SET attempt_id=gen_random_uuid() WHERE action_key=$1",
        [actionKeys(identity)[0]]
      );
      return "GPS-accepted";
    });
    await expect(executeFulfillmentAction(identity, request, execute)).rejects.toBeInstanceOf(
      UncertainActionError
    );
    expect(
      (
        await pool.query(
          "SELECT DISTINCT status FROM public.fulfillment_actions WHERE scope='fixture'"
        )
      ).rows
    ).toEqual([{ status: "pending" }]);
    await expect(executeFulfillmentAction(identity, request, execute)).rejects.toBeInstanceOf(
      UncertainActionError
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fails closed without a database and on conflicting or partial replay batches", async () => {
    const execute = vi.fn(async () => "GPS");
    getPool.mockResolvedValueOnce(null);
    await expect(executeFulfillmentAction(identity, request, execute)).rejects.toThrow("database");
    expect(execute).not.toHaveBeenCalled();
    await executeFulfillmentAction(identity, request, execute);
    await expect(
      executeFulfillmentAction(identity, { quantity: 9 }, execute)
    ).rejects.toBeInstanceOf(UncertainActionError);
    await expect(
      executeFulfillmentAction(
        { ...identity, sourceLineIds: ["line-1", "new-line"] },
        request,
        execute
      )
    ).rejects.toBeInstanceOf(UncertainActionError);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
