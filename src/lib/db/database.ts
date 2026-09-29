import {
  AuthTypes,
  Connector,
  IpAddressTypes,
  type DriverOptions,
} from "@google-cloud/cloud-sql-connector";
import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";

type DatabaseEnvironment = Record<string, string | undefined>;

export type DatabaseConfig =
  | {
      mode: "url";
      connectionString: string;
      maxConnections: number;
      idleTimeoutMs: number;
      connectionTimeoutMs: number;
    }
  | {
      mode: "cloud-sql-iam";
      instanceConnectionName: string;
      database: string;
      user: string;
      ipType: IpAddressTypes;
      maxConnections: number;
      idleTimeoutMs: number;
      connectionTimeoutMs: number;
    }
  | { mode: "disabled" };

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getDatabaseConfig(env: DatabaseEnvironment = process.env): DatabaseConfig {
  const maxConnections = positiveInteger(env.DB_MAX_CONNECTIONS, 5);
  const idleTimeoutMs = positiveInteger(env.DB_IDLE_TIMEOUT_MS, 30_000);
  const connectionTimeoutMs = positiveInteger(env.DB_CONNECTION_TIMEOUT_MS, 10_000);

  if (env.DATABASE_URL) {
    return {
      mode: "url",
      connectionString: env.DATABASE_URL,
      maxConnections,
      idleTimeoutMs,
      connectionTimeoutMs,
    };
  }

  const instanceConnectionName = env.CLOUD_SQL_INSTANCE_CONNECTION_NAME?.trim();
  const database = env.DB_NAME?.trim();
  const user = env.DB_USER?.trim();
  if (!instanceConnectionName || !database || !user) {
    return { mode: "disabled" };
  }

  const ipType =
    env.CLOUD_SQL_IP_TYPE?.toUpperCase() === "PRIVATE"
      ? IpAddressTypes.PRIVATE
      : env.CLOUD_SQL_IP_TYPE?.toUpperCase() === "PSC"
        ? IpAddressTypes.PSC
        : IpAddressTypes.PUBLIC;

  return {
    mode: "cloud-sql-iam",
    instanceConnectionName,
    database,
    user,
    ipType,
    maxConnections,
    idleTimeoutMs,
    connectionTimeoutMs,
  };
}

export function isDatabaseConfigured(env: DatabaseEnvironment = process.env): boolean {
  return getDatabaseConfig(env).mode !== "disabled";
}

let poolPromise: Promise<Pool | null> | null = null;
let connector: Connector | null = null;
let warnedMissingConfig = false;

async function createPool(config: DatabaseConfig): Promise<Pool | null> {
  if (config.mode === "disabled") {
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      console.warn(
        "[Database] Direct PostgreSQL access is disabled. Set DATABASE_URL, or set CLOUD_SQL_INSTANCE_CONNECTION_NAME, DB_NAME, and DB_USER for Cloud SQL IAM authentication."
      );
    }
    return null;
  }

  const shared: PoolConfig = {
    max: config.maxConnections,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    application_name: process.env.K_SERVICE || "battle-bus",
  };

  if (config.mode === "url") {
    return new Pool({
      ...shared,
      connectionString: config.connectionString,
    });
  }

  connector = new Connector();
  const driverOptions: DriverOptions = await connector.getOptions({
    instanceConnectionName: config.instanceConnectionName,
    authType: AuthTypes.IAM,
    ipType: config.ipType,
  });

  return new Pool({
    ...shared,
    ...driverOptions,
    database: config.database,
    user: config.user,
  });
}

export async function getDatabasePool(): Promise<Pool | null> {
  if (!poolPromise) {
    poolPromise = createPool(getDatabaseConfig());
  }
  return poolPromise;
}

export async function queryDatabase<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = []
): Promise<QueryResult<Row>> {
  const pool = await getDatabasePool();
  if (!pool) {
    throw new Error("Database is not configured");
  }
  return pool.query<Row>(text, [...values]);
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export async function closeDatabase(): Promise<void> {
  const pool = poolPromise ? await poolPromise : null;
  poolPromise = null;
  if (pool) await pool.end();
  connector?.close();
  connector = null;
}
