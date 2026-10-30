import { NextRequest, NextResponse } from "next/server";
import { requireServiceAuth } from "@/lib/auth/service-auth";
import { getCutoverReport } from "@/lib/services/cutover/evidence";
import { getWorkflowHealth } from "@/lib/services/workflow-health";
import { getDependencyHealth } from "@/lib/services/dependency-health";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const auth = requireServiceAuth(request);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  const revision =
    request.nextUrl.searchParams.get("revision") || process.env.BATTLE_BUS_VERSION || "";
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    return NextResponse.json({ error: "immutable_revision_required" }, { status: 400 });
  }
  try {
    const [parity, health, dependencies] = await Promise.all([
      getCutoverReport(revision),
      getWorkflowHealth(revision),
      getDependencyHealth(),
    ]);
    return NextResponse.json({
      ready:
        process.env.CUTOVER_HEALTH_ENABLED === "true" &&
        revision === process.env.BATTLE_BUS_VERSION &&
        parity.ready &&
        health.ok &&
        dependencies.ok,
      healthInstrumentationEnabled: process.env.CUTOVER_HEALTH_ENABLED === "true",
      candidateDeployed: revision === process.env.BATTLE_BUS_VERSION,
      parity,
      health,
      dependencies,
    });
  } catch {
    return NextResponse.json(
      { ready: false, error: "cutover_evidence_unavailable" },
      { status: 503 }
    );
  }
}
