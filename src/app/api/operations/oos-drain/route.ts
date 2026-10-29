import { NextRequest, NextResponse } from "next/server";
import { requireServiceAuth } from "@/lib/auth/service-auth";
import { config } from "@/lib/config";
import {
  submitOosDrainRequest,
  type OosDrainRequestInput,
} from "@/lib/services/oos-recovery/requests";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = requireServiceAuth(request);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  if (!config.oosRecovery.enabled) {
    return NextResponse.json({ error: "oos_targeted_drain_disabled" }, { status: 403 });
  }
  try {
    const input = (await request.json()) as OosDrainRequestInput;
    const result = await submitOosDrainRequest({
      ...input,
      mode: input.mode ?? "manual",
      requestedBy: request.headers.get("x-actor-id") ?? input.requestedBy,
      batchLimit: input.batchLimit ?? config.oosRecovery.claimBatchSize,
    });
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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "invalid_oos_drain_request" },
      { status: 400 }
    );
  }
}
