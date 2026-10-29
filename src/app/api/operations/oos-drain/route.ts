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
  .strict()
  .superRefine((value, context) => {
    const inventoryFields = [value.provider, value.warehouse, value.sku];
    const hasInventoryField = inventoryFields.some((field) => field !== undefined);
    const hasInventoryTarget = inventoryFields.every((field) => field !== undefined);
    const hasOrderField = value.orderId !== undefined || value.shopifyStore !== undefined;
    const hasOrderTarget = value.orderId !== undefined && value.shopifyStore !== undefined;
    if (hasInventoryField && !hasInventoryTarget) {
      context.addIssue({
        code: "custom",
        message: "provider, warehouse and sku must be supplied together",
      });
    }
    if (hasOrderField && !hasOrderTarget) {
      context.addIssue({
        code: "custom",
        message: "orderId and shopifyStore must be supplied together",
      });
    }
    if (!hasInventoryTarget && !hasOrderTarget) {
      context.addIssue({ code: "custom", message: "a bounded drain target is required" });
    }
    if (
      value.parkedFrom &&
      value.parkedTo &&
      new Date(value.parkedFrom).getTime() > new Date(value.parkedTo).getTime()
    ) {
      context.addIssue({ code: "custom", message: "parkedFrom must be before parkedTo" });
    }
  });

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
      const executionToken = reservation.executionToken;
      let result: Awaited<ReturnType<typeof executeOosDrain>>;
      try {
        result = await executeOosDrain(preview);
      } catch (error) {
        await finishOosDrainPreviewCommand({
          requestId,
          executionToken,
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
      const saved = await finishOosDrainPreviewCommand({
        requestId,
        executionToken,
        result: evidence,
      });
      if (!saved) {
        throw new OosDrainCommandInProgressError("OOS preview execution lease was superseded");
      }
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
        requestId,
        drainRequestId: result.request.id,
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
