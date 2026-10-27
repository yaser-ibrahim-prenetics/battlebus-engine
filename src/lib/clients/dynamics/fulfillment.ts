import { config } from "@/lib/config";
import {
  assertThkFulfilmentSucceeded,
  buildThkFulfilmentRequestBody,
} from "@/lib/helpers/d365-thk-fulfilment";
import {
  executeFulfillmentAction,
  ConfirmedActionFailure,
} from "@/lib/services/fulfillment-actions/ledger";
import type { D365FulfilmentRequest, D365ThkApiResponse } from "@/lib/types/dynamics";

type Transport = { authenticate: () => Promise<string>; fetch: typeof fetch };

export async function postDurableFulfilment(req: D365FulfilmentRequest, transport: Transport) {
  const lines = [...req.lines].sort((a, b) => String(a.lotId).localeCompare(String(b.lotId)));
  if (!lines.length || lines.some((line) => !line.lotId?.trim())) {
    throw new Error("D365 fulfillment requires a stable InventoryLotId for every line");
  }
  const body = buildThkFulfilmentRequestBody({ ...req, lines });
  if (config.features.dryRunMode)
    return {
      request: body,
      response: {
        status: 1,
        Message: "DRY RUN SUCCESS",
        Result: "DRY_RUN_RESULT",
        $id: "DRY_RUN_ID",
      } as D365ThkApiResponse,
    };

  // Tracking provides a shared identity for Shopify and GPS representations of a
  // shipment. Without tracking callers must supply their stable source event ID.
  const tracking = [
    ...new Set(lines.map((line) => line.trackingNumber?.trim()).filter(Boolean)),
  ].sort();
  const shipment = tracking.length ? `tracking:${JSON.stringify(tracking)}` : req.fulfillmentId;
  if (!shipment)
    throw new Error("D365 fulfillment requires a stable fulfillmentId when tracking is absent");
  const token = await transport.authenticate();
  const result = await executeFulfillmentAction(
    {
      provider: "dynamics",
      scope: `${config.dynamics.baseUrl}:${req.dataAreaId.toUpperCase()}`,
      sourceOrderId: req.salesOrderNumber,
      sourceLineIds: lines.map((line) => line.lotId!),
      action: `${req.type}:${shipment}`,
    },
    body,
    async () => {
      const response = await transport.fetch(
        `${config.dynamics.baseUrl}/api/services/THK_APISyncServiceGroup/THK_APISyncService_Shopify/fulfilment`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        }
      );
      if (response.status === 401 || response.status === 403)
        throw new ConfirmedActionFailure("D365 authorization rejected");
      if (!response.ok) throw new Error("D365 fulfillment outcome not confirmed");
      const result: D365ThkApiResponse = await response.json();
      // Over-quantity / already-invoiced / partial errors are not proof that THIS
      // operation succeeded. Preserve them as uncertain instead of posting again.
      assertThkFulfilmentSucceeded(result, req.salesOrderNumber);
      if (result.status !== 1) throw new Error("D365 fulfillment outcome not confirmed");
      return {
        status: result.status,
        Message: result.Message,
        Result: result.Result,
        $id: result.$id,
      };
    }
  );
  return { request: body, response: result };
}
