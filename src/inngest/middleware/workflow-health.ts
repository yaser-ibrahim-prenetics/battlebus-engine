import { Middleware, type Inngest } from "inngest";
import { queryDatabase } from "@/lib/db/database";
import { workflowHealthQueries as queries } from "@/lib/db/queries/workflow-health";
import { InngestApiRateLimitTerminalMiddleware } from "./inngest-api-rate-limit-terminal";

/** Hooks are terminal-run aware; replaying memoized steps does not inflate sample counts. */
export class WorkflowHealthMiddleware extends InngestApiRateLimitTerminalMiddleware {
  constructor({ client }: { client: Inngest.Any }) {
    super({ client });
  }

  async onRunStart({ ctx, fn }: Middleware.OnRunStartArgs) {
    const timestamp = typeof ctx.event.ts === "number" ? new Date(ctx.event.ts) : null;
    await queryDatabase(queries.start, [
      ctx.runId,
      fn.id(),
      ctx.event.name,
      process.env.BATTLE_BUS_VERSION || process.env.K_REVISION || "local",
      timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null,
    ]);
  }

  async onRunComplete({ ctx, fn, output }: Middleware.OnRunCompleteArgs) {
    // A run may have started before this instrumentation was deployed.
    await this.onRunStart({ ctx, fn });
    const result = output && typeof output === "object" ? (output as Record<string, unknown>) : {};
    const failed = result.success === false || ["failed", "error"].includes(String(result.status));
    await queryDatabase(queries.finish, [
      ctx.runId,
      failed ? "failed" : "completed",
      ctx.attempt + 1,
    ]);
  }

  async onRunError({ ctx, fn, isFinalAttempt }: Middleware.OnRunErrorArgs) {
    await this.onRunStart({ ctx, fn });
    if (isFinalAttempt) {
      await queryDatabase(queries.finish, [ctx.runId, "failed", ctx.attempt + 1]);
    } else {
      await queryDatabase(queries.retry, [ctx.runId, ctx.attempt + 1]);
    }
  }
}
