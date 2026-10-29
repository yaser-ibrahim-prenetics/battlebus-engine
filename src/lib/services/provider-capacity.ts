import { createHash, randomUUID } from "node:crypto";
import type { Pool, QueryConfig, QueryResult, QueryResultRow } from "pg";
import { config } from "@/lib/config";
import { getDatabasePool } from "@/lib/db/database";

export type CapacityProvider = "d365" | "gps" | "shopify" | "stord" | "loop";

export type ProviderCapacityLease = {
  provider: CapacityProvider;
  slot: number;
  leaseToken: string;
  leaseOwner: string;
  leaseUntil: string;
};

type ProviderCapacityOverrides = {
  enabled?: boolean;
  limit?: number;
  leaseSeconds?: number;
  acquireTimeoutMs?: number;
  pollIntervalMs?: number;
  pool?: Pool;
};

const defaultLimits: Record<CapacityProvider, number> = {
  d365: 4,
  gps: 4,
  shopify: 8,
  stord: 4,
  loop: 4,
};
const CAPACITY_QUERY_TIMEOUT_MS = 2_000;

export class ProviderCapacityTimeoutError extends Error {
  constructor(provider: CapacityProvider) {
    super(`Shared ${provider} provider capacity is temporarily exhausted`);
    this.name = "ProviderCapacityTimeoutError";
  }
}

export class ProviderCapacityStoreError extends Error {
  constructor(message = "Shared provider capacity store is unavailable") {
    super(message);
    this.name = "ProviderCapacityStoreError";
  }
}

export class ProviderCapacityDatabaseTimeoutError extends ProviderCapacityStoreError {
  constructor() {
    super("Shared provider capacity database query timed out");
    this.name = "ProviderCapacityDatabaseTimeoutError";
  }
}

async function capacityQuery<Row extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  text: string,
  values: readonly unknown[],
  timeoutMs: number
): Promise<QueryResult<Row>> {
  const boundedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  // node-postgres supports per-query query_timeout at runtime, although its
  // QueryConfig declaration currently exposes the field only on ClientConfig.
  const queryConfig = {
    text,
    values: [...values],
    query_timeout: boundedTimeoutMs,
  } as QueryConfig;
  const query: Promise<QueryResult<Row>> = pool.query<Row>(queryConfig);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    try {
      return await Promise.race([
        query,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ProviderCapacityDatabaseTimeoutError()),
            boundedTimeoutMs
          );
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      if (error instanceof ProviderCapacityDatabaseTimeoutError) throw error;
      if (error instanceof Error && /query.*timeout|timeout.*query/i.test(error.message)) {
        throw new ProviderCapacityDatabaseTimeoutError();
      }
      throw error;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function operationDigest(operation: string): string {
  return createHash("sha256").update(operation).digest("hex");
}

function providerLimit(provider: CapacityProvider): number {
  return config.providerCapacity?.limits?.[provider] ?? defaultLimits[provider];
}

async function claimProviderCapacity(
  pool: Pool,
  provider: CapacityProvider,
  operation: string,
  options: Required<Pick<ProviderCapacityOverrides, "limit" | "leaseSeconds">>,
  leaseOwner: string,
  deadline: Date,
  queryTimeoutMs: number
): Promise<ProviderCapacityLease | null> {
  const leaseToken = randomUUID();
  const result = await capacityQuery<{
    provider: CapacityProvider;
    slot: number;
    lease_token: string;
    lease_owner: string;
    lease_until: string;
  }>(
    pool,
    `WITH candidate AS (
       SELECT provider, slot
       FROM public.provider_capacity_leases
       WHERE provider = $1 AND slot <= $2
         AND (lease_until IS NULL OR lease_until <= clock_timestamp())
         AND clock_timestamp() < $7::timestamptz
       ORDER BY slot
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE public.provider_capacity_leases AS capacity
     SET lease_token = $3::uuid, lease_owner = $4::uuid, operation_digest = $5,
       leased_at = clock_timestamp(),
       lease_until = clock_timestamp() + make_interval(secs => $6)
     FROM candidate
     WHERE capacity.provider = candidate.provider AND capacity.slot = candidate.slot
       AND clock_timestamp() < $7::timestamptz
     RETURNING capacity.provider, capacity.slot, capacity.lease_token,
       capacity.lease_owner, capacity.lease_until`,
    [
      provider,
      options.limit,
      leaseToken,
      leaseOwner,
      operationDigest(operation),
      options.leaseSeconds,
      deadline.toISOString(),
    ],
    queryTimeoutMs
  );
  const row = result.rows[0];
  return row
    ? {
        provider: row.provider,
        slot: Number(row.slot),
        leaseToken: row.lease_token,
        leaseOwner: row.lease_owner,
        leaseUntil: row.lease_until,
      }
    : null;
}

export async function acquireProviderCapacity(
  provider: CapacityProvider,
  operation: string,
  overrides: ProviderCapacityOverrides = {}
): Promise<ProviderCapacityLease> {
  const pool = overrides.pool ?? (await getDatabasePool());
  if (!pool)
    throw new Error("Shared provider capacity requires the configured PostgreSQL database");
  const limit = clamp(overrides.limit ?? providerLimit(provider), 1, 100);
  const leaseSeconds = clamp(
    overrides.leaseSeconds ?? config.providerCapacity?.leaseSeconds ?? 120,
    120,
    600
  );
  const acquireTimeoutMs = clamp(
    overrides.acquireTimeoutMs ?? config.providerCapacity?.acquireTimeoutMs ?? 30_000,
    1,
    60_000
  );
  const pollIntervalMs = clamp(
    overrides.pollIntervalMs ?? config.providerCapacity?.pollIntervalMs ?? 250,
    25,
    2_000
  );
  const leaseOwner = randomUUID();
  const deadline = Date.now() + acquireTimeoutMs;

  while (true) {
    let lease: ProviderCapacityLease | null;
    try {
      lease = await claimProviderCapacity(
        pool,
        provider,
        operation,
        { limit, leaseSeconds },
        leaseOwner,
        new Date(deadline),
        Math.min(CAPACITY_QUERY_TIMEOUT_MS, Math.max(1, deadline - Date.now()))
      );
    } catch (error) {
      if (error instanceof ProviderCapacityStoreError) throw error;
      throw new ProviderCapacityStoreError();
    }
    if (lease) return lease;
    if (Date.now() >= deadline) throw new ProviderCapacityTimeoutError(provider);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now()))
    );
  }
}

export async function renewProviderCapacity(
  lease: ProviderCapacityLease,
  leaseSeconds: number,
  poolOverride?: Pool
): Promise<boolean> {
  const pool = poolOverride ?? (await getDatabasePool());
  if (!pool) return false;
  const result = await capacityQuery(
    pool,
    `UPDATE public.provider_capacity_leases
     SET lease_until = clock_timestamp() + make_interval(secs => $5)
     WHERE provider = $1 AND slot = $2 AND lease_token = $3::uuid AND lease_owner = $4::uuid
       AND lease_until > clock_timestamp()`,
    [lease.provider, lease.slot, lease.leaseToken, lease.leaseOwner, clamp(leaseSeconds, 120, 600)],
    CAPACITY_QUERY_TIMEOUT_MS
  );
  return result.rowCount === 1;
}

export async function releaseProviderCapacity(
  lease: ProviderCapacityLease,
  poolOverride?: Pool
): Promise<boolean> {
  const pool = poolOverride ?? (await getDatabasePool());
  if (!pool) return false;
  const result = await capacityQuery(
    pool,
    `UPDATE public.provider_capacity_leases
     SET lease_token = NULL, lease_owner = NULL, operation_digest = NULL,
       leased_at = NULL, lease_until = NULL
     WHERE provider = $1 AND slot = $2 AND lease_token = $3::uuid AND lease_owner = $4::uuid`,
    [lease.provider, lease.slot, lease.leaseToken, lease.leaseOwner],
    CAPACITY_QUERY_TIMEOUT_MS
  );
  return result.rowCount === 1;
}

export async function withProviderCapacity<T>(
  provider: CapacityProvider,
  operation: string,
  execute: () => Promise<T>,
  overrides: ProviderCapacityOverrides = {}
): Promise<T> {
  const enabled = overrides.enabled ?? config.providerCapacity?.enabled ?? false;
  if (!enabled) return execute();
  const pool = overrides.pool ?? (await getDatabasePool());
  if (!pool)
    throw new Error("Shared provider capacity requires the configured PostgreSQL database");
  const leaseSeconds = clamp(
    overrides.leaseSeconds ?? config.providerCapacity?.leaseSeconds ?? 120,
    120,
    600
  );
  const lease = await acquireProviderCapacity(provider, operation, { ...overrides, pool });
  let renewal = Promise.resolve();
  const timer = setInterval(
    () => {
      renewal = renewal
        .then(async () => {
          if (!(await renewProviderCapacity(lease, leaseSeconds, pool))) {
            console.error(`[ProviderCapacity] Lost ${provider} capacity lease ${lease.slot}`);
          }
        })
        .catch(() => {
          console.error(`[ProviderCapacity] Lost ${provider} capacity lease ${lease.slot}`);
        });
    },
    Math.max(10_000, Math.floor((leaseSeconds * 1000) / 3))
  );
  timer.unref?.();

  try {
    return await execute();
  } finally {
    clearInterval(timer);
    try {
      await releaseProviderCapacity(lease, pool);
    } catch {
      // Never turn a confirmed provider response into a retryable failure. The bounded lease expires.
      console.error(
        `[ProviderCapacity] Failed to release ${provider} capacity lease ${lease.slot}`
      );
    }
  }
}
