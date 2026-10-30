import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { requireServiceAuth } from "@/lib/auth/service-auth";
import { ChannelLiftError } from "@/lib/channel-lift/model";
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
  const traceId = request.headers.get("x-request-id") || crypto.randomUUID();
  const auth = requireServiceAuth(request, { envVars: ["BATTLE_BUS_OPERATIONS_API_KEY"] });
  if (!auth.ok) {
    console.warn(`[ChannelLift] request rejected traceId=${traceId} errorCode=unauthorized`);
    return NextResponse.json(auth.body, { status: auth.status });
  }
  if (!config.channelLift.enabled) {
    return NextResponse.json(
      { error: "channel_lift_disabled", message: "Channel lift is disabled" },
      { status: 403 }
    );
  }

  try {
    const body = requestSchema.parse(await request.json());
    if (body.live && !config.channelLift.sendEnabled) {
      return NextResponse.json(
        {
          error: "channel_lift_live_send_disabled",
          message: "Channel-lift live sending is disabled",
        },
        { status: 403 }
      );
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
    console.info(
      `[ChannelLift] request queued traceId=${traceId} requestId=${body.requestId} mode=${mode} dates=${reportingDates.length}`
    );
    return NextResponse.json(
      {
        requestId: body.requestId,
        status: "queued",
        mode,
        reportingDates,
        count: reportingDates.length,
        message: "Channel-lift run request queued",
      },
      { status: 202 }
    );
  } catch (error) {
    const validationFailure = error instanceof ZodError || error instanceof ChannelLiftError;
    const code =
      error instanceof ZodError
        ? "invalid_request"
        : error instanceof ChannelLiftError
          ? error.code
          : "channel_lift_request_failed";
    console.error(`[ChannelLift] request failed traceId=${traceId} errorCode=${code}`);
    return NextResponse.json(
      {
        error: code,
        message: validationFailure
          ? "Channel-lift request validation failed"
          : "Channel-lift request could not be queued",
      },
      { status: validationFailure ? 400 : 503 }
    );
  }
}
