import { NextResponse } from "next/server";
import { config } from "@/lib/config";

/**
 * Lightweight runtime diagnostics for why D365 may be skipped.
 * Safe to expose: includes only non-sensitive flags/metadata.
 */
export async function GET() {
  const rawEnableDynamicsSync = process.env.ENABLE_DYNAMICS_SYNC ?? null;
  const rawDryRunMode = process.env.DRY_RUN_MODE ?? null;

  const enableDynamicsSync = config.features.enableDynamicsSync;
  const dryRunMode = config.features.dryRunMode;

  let likelySkipReason = "none";
  if (dryRunMode) likelySkipReason = "DRY_RUN_MODE=true (entire order flow is skipped)";
  else if (!enableDynamicsSync)
    likelySkipReason = "ENABLE_DYNAMICS_SYNC=false (D365 steps are skipped)";

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    flags: {
      ENABLE_DYNAMICS_SYNC: rawEnableDynamicsSync,
      DRY_RUN_MODE: rawDryRunMode,
    },
    effective: {
      enableDynamicsSync,
      dryRunMode,
    },
    diagnostics: {
      likelySkipReason,
      notes: [
        "enableDynamicsSync is true unless ENABLE_DYNAMICS_SYNC is exactly 'false'",
        "dryRunMode is true only when DRY_RUN_MODE is exactly 'true'",
      ],
    },
  });
}

