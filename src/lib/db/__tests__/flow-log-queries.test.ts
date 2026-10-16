import { describe, expect, it } from "vitest";
import { createFlowLogQueries } from "@/lib/db/queries/flow-logs";

describe("flow log queries", () => {
  it("stores order timeline entries in the same statement as flow logs", () => {
    const queries = createFlowLogQueries("flow_logs", "workflow_timeline_events");
    const sql = queries.insert(
      [
        "ts",
        "level",
        "flow",
        "step",
        "client",
        "run_id",
        "request_id",
        "shopify_order_id",
        "shopify_order_name",
        "d365_order_number",
        "status",
        "duration_ms",
        "error_type",
        "error_message",
        "payload",
      ],
      2
    );

    expect(sql).toContain('WITH inserted AS (\n        INSERT INTO "flow_logs"');
    expect(sql).toContain('INSERT INTO "workflow_timeline_events"');
    expect(sql).toContain("concat('flow-log:', id::text)");
    expect(sql).toContain("WHERE shopify_order_id IS NOT NULL OR shopify_order_name IS NOT NULL");
    expect(sql).toContain("$30");
  });
});
