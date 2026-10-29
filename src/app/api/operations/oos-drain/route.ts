import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { requireServiceAuth } from "@/lib/auth/service-auth";
import { config } from "@/lib/config";
import { executeOosDrain } from "@/lib/services/oos-recovery/drain";
import { logRecoveryFailure } from "@/lib/services/operations/diagnostics";
import {
  createOosDrainPreviewRequest,
  finishOosDrainPreviewCommand,
  OosDrainCommandConflictError,
  OosDrainCommandInProgressError,
  reserveOosDrainPreviewCommand,
  submitOosDrainRequest,
} from "@/lib/services/oos-recovery/requests";

export const dynamic = "force-dynamic";

const requestSchema = z
  .object({
    requestId: z.uuid(),
    reason: z.string().trim().min(10).max(1000),
    mode: z.literal("manual").default("manual"),
    dryRun: z.boolean().default(false),
    provider: z.enum(["gps", "d365"]).optional(),
    warehouse: z.string().trim().min(1).max(100).optional(),
    sku: z.string().trim().min(1).max(200).optional(),
    orderId: z
      .string()
      .trim()
      .regex(/^\d{1,30}$/)
      .optional(),
    shopifyStore: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9.-]{1,252}$/i)
      .optional(),
    parkedFrom: z.iso.datetime({ offset: true }).optional(),
    parkedTo: z.iso.datetime({ offset: true }).optional(),
    observedQuantity: z.number().int().nonnegative().optional(),
    observedAt: z.iso.datetime({ offset: true }).optional(),
    batchLimit: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = requireServiceAuth(request, { envVars: ["BATTLE_BUS_OPERATIONS_API_KEY"] });
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  if (!config.oosRecovery.enabled) {
    return NextResponse.json({ error: "oos_targeted_drain_disabled" }, { status: 403 });
  }
  try {
    const body = requestSchema.parse(await request.json());
    const { requestId, reason, ...parameters } = body;
    const command = {
      requestId,
      reason,
      actor: "service:battle-bus-operations",
    };
    const input = {
      ...parameters,
      requestedBy: command.actor,
      requestReason: reason,
      batchLimit: body.batchLimit ?? config.oosRecovery.claimBatchSize,
    };
    if (input.dryRun) {
      const reservation = await reserveOosDrainPreviewCommand(input, command);
      if (reservation.status === "completed") {
        return NextResponse.json(
          {
            requestId,
            laneKey: createOosDrainPreviewRequest(input).laneKey,
            status: "previewed",
            dryRun: true,
            result: reservation.result,
          },
          { status: 200 }
        );
      }
      const preview = createOosDrainPreviewRequest(input);
      let result: Awaited<ReturnType<typeof executeOosDrain>>;
      try {
        result = await executeOosDrain(preview);
      } catch (error) {
        await finishOosDrainPreviewCommand({
          requestId,
          errorCode: "preview_execution_failed",
        });
        throw error;
      }
      const evidence = {
        examinedOrders: result.examinedOrders,
        selectedOrders: result.selectedOrders,
        selectedDependencies: result.selectedDependencies,
        manualReviewExpired: result.manualReviewExpired,
        queuedKeys: result.queuedKeys,
      };
      await finishOosDrainPreviewCommand({ requestId, result: evidence });
      return NextResponse.json(
        {
          requestId,
          laneKey: preview.laneKey,
          status: "previewed",
          dryRun: true,
          result: evidence,
        },
        { status: 200 }
      );
    }
    const result = await submitOosDrainRequest(input, command);
    return NextResponse.json(
      {
        requestId: result.request.id,
        laneKey: result.request.laneKey,
        status: result.created ? "queued" : "coalesced",
        dryRun: result.request.dryRun,
      },
      { status: 202 }
    );
  } catch (error) {
    if (!(error instanceof ZodError)) {
      logRecoveryFailure({ operation: "oos_drain_request" }, error);
    }
    return NextResponse.json(
      {
        error:
          error instanceof ZodError
            ? "Invalid OOS drain request or operator identity"
            : "OOS drain request rejected; check the target or reuse the original request unchanged",
      },
      {
        status:
          error instanceof ZodError
            ? 400
            : error instanceof OosDrainCommandConflictError ||
                error instanceof OosDrainCommandInProgressError
              ? 409
              : 503,
      }
    );
  }
}
