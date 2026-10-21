import { expect, it, vi } from "vitest";
import { getCutoverReport } from "../evidence";
import registry from "../../../../../config/spock-workflows.json";
import { queryDatabase } from "@/lib/db/database";
vi.mock("@/lib/db/database", () => ({ queryDatabase: vi.fn() }));
it("cannot certify unsupported adapters even if imported counts are all positive", async () => {
  const rows = registry.workflows.flatMap((w) =>
    ["contract", "historical", "shadow", "recovery"].map((mode) => ({
      workflow_id: w.id,
      mode,
      samples: 100,
      failures: 0,
      production_samples: 100,
      shadow_days: 7,
      latest_at: new Date().toISOString(),
    }))
  );
  vi.mocked(queryDatabase)
    .mockResolvedValueOnce({ rows } as never)
    .mockResolvedValueOnce({ rows: [] } as never);
  const report = await getCutoverReport("a".repeat(40));
  expect(report.ready).toBe(false);
  expect(
    report.workflows.every((w) =>
      w.blockers.includes("paired workflow adapters not implemented and validated")
    )
  ).toBe(true);
});
