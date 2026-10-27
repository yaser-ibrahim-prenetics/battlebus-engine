import type { PoolClient } from "pg";
import { getDatabasePool } from "@/lib/db/database";
import { lockAllocationsSQL } from "@/lib/sql/order-segments/fulfillments";

/** Keep provider progress and Hub publications in order for a single parent order. */
export async function withSegmentPublication<T>(
  shop: string,
  orderId: string,
  publish: (client: PoolClient) => Promise<T>
) {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("Database required for segment publication");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(lockAllocationsSQL, [
      JSON.stringify([shop, orderId, "segment-fulfillment"]),
    ]);
    const result = await publish(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
