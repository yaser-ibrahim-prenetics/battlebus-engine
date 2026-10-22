import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireServiceAuth } from "@/lib/auth/service-auth";
import { sendHubWebhook, readHubLocationMappings } from "@/lib/clients/hub-transport";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Connectivity only: never publishes an Inngest event or changes business data. */
export async function GET(request: NextRequest) {
  const auth = requireServiceAuth(request);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  if (!config.csPlatform.enabled) return NextResponse.json({ ok: false, error: "Hub delivery is disabled" }, { status: 503 });
  try {
    const id = randomUUID();
    const response = await sendHubWebhook("/api/webhooks/probe", { event: "integration.probe", id });
    if (!response.ok) throw new Error("Hub rejected probe");
    const result = await response.json();
    if (result.ok !== true || result.id !== id || result.event !== "integration.probe" || result.writes !== false) {
      throw new Error("Invalid Hub probe acknowledgement");
    }
    const mappings = await readHubLocationMappings();
    const mappingResult = await mappings.json();
    if (!mappings.ok || mappingResult.success !== true || !Array.isArray(mappingResult.locations)) {
      throw new Error("Hub mapping read failed");
    }
    return NextResponse.json({ ok: true, connection: "hub-bus-hub", database: "reachable", locationMappings: "reachable", writes: false, dryRun: config.features.dryRunMode });
  } catch {
    return NextResponse.json({ ok: false, error: "Authenticated Hub callback failed" }, { status: 503 });
  }
}
