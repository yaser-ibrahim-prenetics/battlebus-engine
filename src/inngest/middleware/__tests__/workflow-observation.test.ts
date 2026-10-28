import { beforeEach, expect, it, vi } from "vitest";

const { queryDatabase } = vi.hoisted(() => ({ queryDatabase: vi.fn() }));
vi.mock("@/lib/db/database", () => ({
  isDatabaseConfigured: () => true,
  queryDatabase,
}));

import { WorkflowObservationMiddleware } from "../workflow-observation";
import { clearWorkflowWaitSQL, waitWorkflowSQL } from "@/lib/sql/operations/workflows";

beforeEach(() => queryDatabase.mockReset());

const middleware = new WorkflowObservationMiddleware({ client: {} as never });
const args = (memoized: boolean) =>
  ({
    ctx: { runId: "run-1" },
    stepInfo: { memoized, stepType: "waitForEvent", input: [{ timeout: "7 days" }] },
    next: vi.fn().mockResolvedValue({ id: "event" }),
  }) as never;

it("records a future wait when the wait step is first scheduled", async () => {
  await middleware.wrapStep(args(false));
  expect(queryDatabase).toHaveBeenCalledWith(waitWorkflowSQL, ["run-1", expect.any(String), false]);
});

it("clears the wait deadline when the wait step resumes from memoized state", async () => {
  await middleware.wrapStep(args(true));
  expect(queryDatabase).toHaveBeenCalledExactlyOnceWith(clearWorkflowWaitSQL, ["run-1"]);
});
