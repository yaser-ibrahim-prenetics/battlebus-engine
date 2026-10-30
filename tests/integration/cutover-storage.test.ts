import { expect, it } from "vitest";
import { Pool } from "pg";
import { cutoverEvidenceQueries as evidence } from "@/lib/db/queries/cutover-evidence";
import { workflowHealthQueries as health } from "@/lib/db/queries/workflow-health";
import { evaluateSlo } from "@/lib/domain/cutover/slo";

const connectionString = process.env.CUTOVER_TEST_DATABASE_URL;
it.skipIf(!connectionString)(
  "evaluates real PostgreSQL evidence and terminal-run queries",
  async () => {
    const url = new URL(connectionString!);
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      throw new Error("Disposable local database required");
    const pool = new Pool({ connectionString, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE battle_bus_replay_writer");
      const revision = "f".repeat(40);
      const insert = (id: string, status: string, input: string) =>
        client.query(evidence.insert, [
          id,
          "fixture",
          "shopify:orders/paid",
          "historical",
          "production",
          "fixture:opaque",
          new Date().toISOString(),
          input.repeat(64),
          revision,
          revision,
          status,
          status === "matched" ? "[]" : '["orders"]',
          "a".repeat(64),
          (status === "matched" ? "a" : "b").repeat(64),
          new Date().toISOString(),
          new Date().toISOString(),
        ]);
      await insert("00000000-0000-0000-0000-000000000101", "matched", "a");
      await insert("00000000-0000-0000-0000-000000000102", "matched", "a");
      await insert("00000000-0000-0000-0000-000000000103", "mismatch", "b");
      await client.query("RESET ROLE");
      await client.query("SET LOCAL ROLE service_role");
      const result = await client.query(evidence.summary, [revision, revision]);
      expect(result.rows[0]).toMatchObject({ samples: 1, production_samples: 1, failures: 1 });
      await client.query(health.start, [
        "query-test-run",
        "query-test-function",
        "fixture",
        revision,
        null,
      ]);
      await client.query(health.start, [
        "query-test-run",
        "query-test-function",
        "fixture",
        revision,
        null,
      ]);
      await client.query(health.retry, ["query-test-run", 2]);
      await client.query(health.finish, ["query-test-run", "failed", 3, false]);
      await client.query(health.finish, ["query-test-run", "completed", 4, false]);
      await client.query(health.start, [
        "skipped-run",
        "query-test-function",
        "fixture",
        revision,
        null,
      ]);
      await client.query(health.finish, ["skipped-run", "completed", 1, true]);
      const report = await client.query(health.report, [revision]);
      expect(report.rows[0]).toMatchObject({ completed: 1, failed: 1, backlog: 0 });
      const oldRevision = "e".repeat(40);
      await client.query(health.start, [
        "old-running",
        "query-test-function",
        "fixture",
        oldRevision,
        new Date(Date.now() - 7200000).toISOString(),
      ]);
      await client.query(health.start, [
        "old-finished",
        "query-test-function",
        "fixture",
        oldRevision,
        null,
      ]);
      await client.query(health.finish, ["old-finished", "completed", 1, false]);
      const afterDeploy = (await client.query(health.report, [revision])).rows[0];
      expect(afterDeploy).toMatchObject({ completed: 1, failed: 1, backlog: 1 });
      expect(Number(afterDeploy.backlog_age_seconds)).toBeGreaterThan(7100);
      expect(evaluateSlo(afterDeploy).blockers).toContain("backlog age");
      expect((await client.query(health.outbox)).rows[0]).toHaveProperty("dead_letters");
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  }
);
