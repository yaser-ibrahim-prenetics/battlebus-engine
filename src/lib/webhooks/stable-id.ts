import { createHash } from "node:crypto";

/**
 * Derive the GPS manual-batch operation identity from semantic inputs so an
 * authenticated retry of the same request cannot enqueue a second operation.
 */
export function createGpsIndividualBatchId(warehouse: string, gpsOrderIds: string[]): string {
  const canonical = JSON.stringify({
    warehouse: warehouse.trim().toUpperCase(),
    gpsOrderIds: [...new Set(gpsOrderIds.map((id) => id.trim()))].sort(),
  });
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  return `GPSB-${digest}`;
}
