import { inngest } from "../client";
import { queryDatabase } from "@/lib/db/database";
import { queuedCommandsSQL, readCommandSQL, finishCommandSQL } from "@/lib/sql/operations/commands";
import { executeRecoveryCommand } from "@/lib/services/operations/execute";
import type { RecoveryCommand } from "@/lib/services/operations/commands";
export const processAdministrativeRecovery = inngest.createFunction(
  {
    id: "process-administrative-recovery",
    name: "Restricted administrative recovery",
    retries: 3,
    concurrency: { limit: 1 },
    triggers: [{ event: "operations/recovery.requested" }, { cron: "*/5 * * * *" }],
  },
  async ({ event, step }) => {
    const ids = await step.run("load-commands", async () => {
      if (event.name === "operations/recovery.requested") {
        const requestId = String(event.data.requestId ?? "");
        if (!/^[a-f0-9-]{36}$/i.test(requestId))
          throw new Error("Invalid recovery command identity");
        return [requestId];
      }
      return (await queryDatabase<{ id: string }>(queuedCommandsSQL)).rows.map((row) => row.id);
    });
    const outcomes = [];
    for (const id of ids)
      outcomes.push(
        await step.run(`execute-${id}`, async () => {
          const row = (await queryDatabase<RecoveryCommand>(readCommandSQL, [id])).rows[0];
          if (!row || row.status !== "queued") return { id, status: row?.status ?? "missing" };
          try {
            const result = await executeRecoveryCommand(row);
            const saved = await queryDatabase(finishCommandSQL, [
              id,
              "succeeded",
              JSON.stringify(result),
              null,
            ]);
            if (saved.rowCount !== 1) throw new Error("Recovery completion could not be saved");
            return { id, status: "succeeded" };
          } catch {
            // Unknown provider outcomes remain blocked by their own action ledger.
            // A new operator request is required after investigation; no blind write replay.
            await queryDatabase(finishCommandSQL, [id, "failed", null, "recovery_requires_review"]);
            return { id, status: "failed" };
          }
        })
      );
    return { outcomes };
  }
);
