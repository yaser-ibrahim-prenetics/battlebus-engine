import { describe, expect, it } from "vitest";
import { getDatabaseConfig, isDatabaseConfigured, quoteIdentifier } from "../database";

describe("database configuration", () => {
  it("prefers an explicit database URL for local and migration tooling", () => {
    expect(
      getDatabaseConfig({
        DATABASE_URL: "postgresql://app:secret@localhost:5432/battle_platform",
        CLOUD_SQL_INSTANCE_CONNECTION_NAME: "ignored:region:instance",
        DB_NAME: "ignored",
        DB_USER: "ignored",
      })
    ).toMatchObject({
      mode: "url",
      connectionString: "postgresql://app:secret@localhost:5432/battle_platform",
    });
  });

  it("uses passwordless Cloud SQL IAM authentication in GCP", () => {
    expect(
      getDatabaseConfig({
        CLOUD_SQL_INSTANCE_CONNECTION_NAME: "battle-bus-509406:asia-east1:postgres",
        DB_NAME: "battle_platform",
        DB_USER: "battle-bus-runtime@battle-bus-509406.iam",
      })
    ).toMatchObject({
      mode: "cloud-sql-iam",
      database: "battle_platform",
      user: "battle-bus-runtime@battle-bus-509406.iam",
      maxConnections: 5,
    });
  });

  it("stays disabled when the IAM tuple is incomplete", () => {
    expect(
      isDatabaseConfigured({
        CLOUD_SQL_INSTANCE_CONNECTION_NAME: "battle-bus-509406:asia-east1:postgres",
        DB_NAME: "battle_platform",
      })
    ).toBe(false);
  });
});

describe("quoteIdentifier", () => {
  it("quotes trusted identifiers and rejects SQL fragments", () => {
    expect(quoteIdentifier("flow_logs")).toBe('"flow_logs"');
    expect(() => quoteIdentifier("flow_logs; drop table orders")).toThrow("Unsafe SQL identifier");
  });
});
