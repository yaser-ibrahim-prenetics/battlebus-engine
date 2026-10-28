import { Middleware, type Inngest } from "inngest";
import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";
import {
  observeWorkflowSQL,
  waitWorkflowSQL,
  completeWorkflowSQL,
} from "@/lib/sql/operations/workflows";
import { waitingDeadline } from "@/lib/services/operations/workflow-waits";
async function record(sql: string, values: unknown[]) {
  if (!isDatabaseConfigured()) return;
  try {
    await queryDatabase(sql, values);
  } catch {
    console.error("[WorkflowHealth] Observation unavailable; inspect database readiness");
  }
}
export class WorkflowObservationMiddleware extends Middleware.BaseMiddleware {
  readonly id: string = "battle-bus:workflow-observation";
  constructor({ client }: { client: Inngest.Any }) { super({ client }); }
  async wrapFunctionHandler({ ctx, fn, next }: Middleware.WrapFunctionHandlerArgs): Promise<unknown> {
    await record(observeWorkflowSQL, [ctx.runId, fn.id(), ctx.event?.id ?? null]);
    const result = await next();
    await record(completeWorkflowSQL, [ctx.runId]);
    return result;
  }
  async wrapStep({ ctx, stepInfo, next }: Middleware.WrapStepArgs): Promise<unknown> {
    if (!stepInfo.memoized) {
      const wait = waitingDeadline(String(stepInfo.stepType), stepInfo.input);
      if (wait) await record(waitWorkflowSQL, [ctx.runId, wait.until, wait.until === null]);
    }
    return next();
  }
}
