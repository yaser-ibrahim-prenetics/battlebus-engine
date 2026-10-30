import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { requireServiceAuth } from "@/lib/auth/service-auth";
import { config } from "@/lib/config";
import { inngest } from "@/inngest/client";
import { channelLiftDateRange } from "@/lib/services/channel-lift/schedule";

export const dynamic = "force-dynamic";

const requestSchema = z
  .object({
    requestId: z.uuid(),
    reason: z.string().trim().min(10).max(1_000),
    date: z.iso.date().optional(),
    startDate: z.iso.date().optional(),
    endDate: z.iso.date().optional(),
    live: z.boolean().default(false),
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = requireServiceAuth(request, { envVars: ["BATTLE_BUS_OPERATIONS_API_KEY"] });
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  if (!config.channelLift.enabled) {
    return NextResponse.json({ error: "channel_lift_disabled" }, { status: 403 });
  }

  try {
    const body = requestSchema.parse(await request.json());
    if (body.live && !config.channelLift.sendEnabled) {
      return NextResponse.json({ error: "channel_lift_live_send_disabled" }, { status: 403 });
    }
    const reportingDates = channelLiftDateRange({
      date: body.date,
      startDate: body.startDate,
      endDate: body.endDate,
      maxDays: config.channelLift.maxBackfillDays,
    });
    const mode = body.live ? "live" : "dry_run";
    await Promise.all(
      reportingDates.map((reportingDate) =>
        inngest.send({
          id: `channel-lift:manual:${body.requestId}:${reportingDate}:${mode}`,
          name: "meta.channel-lift/run.requested",
          data: {
            requestId: body.requestId,
            reportingDate,
            mode,
            source: "manual",
            requestedBy: "service:battle-bus-operations",
            requestReason: body.reason,
          },
        })
      )
    );
    return NextResponse.json(
      {
        requestId: body.requestId,
        status: "queued",
        mode,
        reportingDates,
        count: reportingDates.length,
      },
      { status: 202 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof ZodError ? "invalid_request" : "channel_lift_request_failed" },
      { status: error instanceof ZodError ? 400 : 409 }
    );
  }
}
