import type { PoolClient } from "pg";

function oosRecoveryOrderLockKey(shopifyStore: string, orderId: string): string {
  return `${shopifyStore.trim().toLowerCase()}:${orderId}`;
}

export async function lockOosRecoveryOrder(
  client: PoolClient,
  shopifyStore: string,
  orderId: string
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    "oos-order",
    oosRecoveryOrderLockKey(shopifyStore, orderId),
  ]);
}

export async function tryLockOosRecoveryOrder(
  client: PoolClient,
  shopifyStore: string,
  orderId: string
): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS locked`,
    ["oos-order", oosRecoveryOrderLockKey(shopifyStore, orderId)]
  );
  return result.rows[0]?.locked === true;
}
