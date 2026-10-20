import { beforeEach, expect, it, vi } from "vitest";
import { Inngest, type Middleware } from "inngest";
import { WorkflowHealthMiddleware } from "../workflow-health";
import { queryDatabase } from "@/lib/db/database";
import { workflowHealthQueries as queries } from "@/lib/db/queries/workflow-health";
vi.mock("@/lib/db/database", () => ({ queryDatabase: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const middleware = new WorkflowHealthMiddleware({ client: new Inngest({ id: "health-test" }) });
const args = {
  ctx: { runId: "run1", attempt: 2, event: { name: "test", ts: 1234567890000 } },
  fn: { id: () => "order-workflow" },
};
it("persists one idempotent run-start identity", async () => {
  await middleware.onRunStart(args as unknown as Middleware.OnRunStartArgs);
  expect(queryDatabase).toHaveBeenCalledWith(queries.start, [
    "run1", "order-workflow", "test", expect.any(String), "2009-02-13T23:31:30.000Z",
  ]);
});
it("records returned business failures, including runs missing their initial observation", async () => {
  await middleware.onRunComplete({ ...args, output: { status: "failed" } } as unknown as Middleware.OnRunCompleteArgs);
  expect(queryDatabase).toHaveBeenNthCalledWith(1, queries.start, expect.any(Array));
  expect(queryDatabase).toHaveBeenLastCalledWith(queries.finish, ["run1", "failed", 3]);
});
it("counts only terminal failures, not retry attempts", async () => {
  await middleware.onRunError({ ...args, isFinalAttempt: false } as unknown as Middleware.OnRunErrorArgs);
  expect(queryDatabase).toHaveBeenLastCalledWith(queries.retry, ["run1", 3]);
  await middleware.onRunError({ ...args, isFinalAttempt: true } as unknown as Middleware.OnRunErrorArgs);
  expect(queryDatabase).toHaveBeenLastCalledWith(queries.finish, ["run1", "failed", 3]);
});
