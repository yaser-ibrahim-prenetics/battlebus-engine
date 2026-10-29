import { randomUUID } from "node:crypto";

import { getDatabasePool } from "@/lib/db/database";
import {
  acquireBackorderRecoveryLeaseSQL,
  releaseBackorderRecoveryLeaseSQL,
} from "@/lib/sql/backorder-recovery/lease";

export type BackorderRecoveryLease = {
  shopifyStore: string;
  orderId: string;
  token: string;
  expiresAt: Date;
};

export class BackorderRecoveryBusyError extends Error {
  constructor(shopifyStore: string, orderId: string) {
    super(`Backorder recovery is already active for ${shopifyStore}:${orderId}`);
    this.name = "BackorderRecoveryBusyError";
  }
}

function required(value: string, label: string, maxLength: number): string {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} must contain between 1 and ${maxLength} characters`);
  }
  return normalized;
}

export async function acquireBackorderRecoveryLease(params: {
  shopifyStore: string;
  orderId: string;
  operationKey: string;
  owner: string;
  leaseSeconds: number;
}): Promise<BackorderRecoveryLease> {
  const shopifyStore = required(params.shopifyStore, "shopifyStore", 255);
  const orderId = required(params.orderId, "orderId", 255);
  const operationKey = required(params.operationKey, "operationKey", 1024);
  const owner = required(params.owner, "owner", 255);
  if (
    !Number.isInteger(params.leaseSeconds) ||
    params.leaseSeconds < 60 ||
    params.leaseSeconds > 3600
  ) {
    throw new Error("leaseSeconds must be an integer between 60 and 3600");
  }

  const pool = await getDatabasePool();
  if (!pool) throw new Error("Backorder recovery requires the configured PostgreSQL database");
  const token = randomUUID();
  const result = await pool.query<{
    shopify_store: string;
    order_id: string;
    lease_token: string;
    lease_expires_at: Date;
  }>(acquireBackorderRecoveryLeaseSQL, [
    shopifyStore,
    orderId,
    token,
    params.leaseSeconds,
    operationKey,
    owner,
  ]);

  if (result.rowCount !== 1) throw new BackorderRecoveryBusyError(shopifyStore, orderId);
  return {
    shopifyStore: result.rows[0].shopify_store,
    orderId: result.rows[0].order_id,
    token: result.rows[0].lease_token,
    expiresAt: result.rows[0].lease_expires_at,
  };
}

export async function releaseBackorderRecoveryLease(lease: BackorderRecoveryLease): Promise<void> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("Backorder recovery requires the configured PostgreSQL database");
  const result = await pool.query(releaseBackorderRecoveryLeaseSQL, [
    lease.shopifyStore,
    lease.orderId,
    lease.token,
  ]);
  if (result.rowCount !== 1) {
    throw new Error(
      `Backorder recovery lease is no longer owned for ${lease.shopifyStore}:${lease.orderId}`
    );
  }
}
