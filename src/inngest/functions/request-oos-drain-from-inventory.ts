import { inngest } from "../client";
import { config } from "@/lib/config";
import { submitOosDrainRequest } from "@/lib/services/oos-recovery/requests";

// Inventory owns stock synchronization. Battle Bus retains order recovery decisions.
export const requestOosDrainFromInventory = inngest.createFunction({
  id: "request-oos-drain-from-inventory", retries: 3,
  triggers: [{ event: "inventory/sync" }],
}, async ({ event, step }) => {
  if (!config.oosRecovery.enabled) return { status: "skipped" };
  const { source, payload } = event.data;
  const provider = source === "dynamics" ? "d365" : source === "gps" || source === "warehouse" ? "gps" : null;
  const quantity = payload.available ?? payload.quantity;
  const warehouse = provider === "d365" ? payload.dataAreaId : payload.warehouseName ?? payload.warehouseId;
  if (!provider || !payload.sku || !warehouse || !Number.isSafeInteger(quantity) || Number(quantity) <= 0) {
    return { status: "skipped" };
  }
  return step.run("queue-targeted-oos-drain", () => submitOosDrainRequest({
    mode: "inventory_event", dryRun: false, provider, warehouse: String(warehouse), sku: payload.sku!,
    observedQuantity: Number(quantity), observedAt: payload.timestamp ?? new Date().toISOString(),
    sourceEventId: String(event.id), batchLimit: config.oosRecovery.claimBatchSize,
  }));
});
