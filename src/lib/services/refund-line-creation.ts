import { createHash } from "crypto";

import * as dynamics from "@/lib/clients/dynamics";
import type { D365SalesOrderLineRequest } from "@/lib/types/dynamics";

import {
  beginRefundLineCreation,
  markRefundLineCreated,
  type RefundOperationClaim,
} from "./refund-operations";

export type RefundLineResult = {
  InventoryLotId: string;
  request: D365SalesOrderLineRequest;
  status: "created" | "reconciled" | "resumed";
};

export function buildRefundLineIdempotencyKey(refundId: string): string {
  const digest = createHash("sha256").update(refundId).digest("hex").slice(0, 24);
  return `SHOPIFY-REFUND-${digest}`;
}

async function findMarkedRefundLine(
  request: D365SalesOrderLineRequest,
  externalIdempotencyKey: string
) {
  const lines = await dynamics.getSalesOrderLines(request.salesOrderNumber!, request.dataAreaId);
  return lines.find((line) => line.LineDescription === externalIdempotencyKey) ?? null;
}

export async function ensureRefundLineCreated({
  refundId,
  claimToken,
  operation,
  request,
}: {
  refundId: string;
  claimToken: string;
  operation: RefundOperationClaim;
  request: D365SalesOrderLineRequest;
}): Promise<RefundLineResult> {
  if (!request.salesOrderNumber) {
    throw new Error(`Refund ${refundId} has no D365 sales order number`);
  }

  if (operation.state === "line_created") {
    if (!operation.inventoryLotId) {
      throw new Error(`Refund ${refundId} is line_created without an inventory lot ID`);
    }
    return {
      InventoryLotId: operation.inventoryLotId,
      request,
      status: "resumed",
    };
  }

  const externalIdempotencyKey =
    operation.externalIdempotencyKey || buildRefundLineIdempotencyKey(refundId);

  if (operation.state === "creating_line") {
    const existing = await findMarkedRefundLine(request, externalIdempotencyKey);
    if (!existing?.InventoryLotId) {
      throw new Error(
        `Refund ${refundId} line creation is unacknowledged; refusing a duplicate D365 write`
      );
    }
    await markRefundLineCreated({
      refundId,
      claimToken,
      d365OrderNumber: request.salesOrderNumber,
      inventoryLotId: existing.InventoryLotId,
    });
    return {
      InventoryLotId: existing.InventoryLotId,
      request,
      status: "reconciled",
    };
  }

  if (operation.state !== "processing") {
    throw new Error(`Refund ${refundId} cannot create a D365 line from ${operation.state}`);
  }

  // Read before entering creating_line. If this lookup fails, a normal retry is
  // still allowed because no database checkpoint or external write occurred.
  const existing = await findMarkedRefundLine(request, externalIdempotencyKey);
  const creation = await beginRefundLineCreation({
    refundId,
    claimToken,
    externalIdempotencyKey,
  });

  if (!creation.claimed) {
    if (creation.state === "line_created" && creation.inventoryLotId) {
      return {
        InventoryLotId: creation.inventoryLotId,
        request,
        status: "resumed",
      };
    }
    throw new Error(`Refund ${refundId} line creation is already ${creation.state}`);
  }

  if (existing?.InventoryLotId) {
    await markRefundLineCreated({
      refundId,
      claimToken,
      d365OrderNumber: request.salesOrderNumber,
      inventoryLotId: existing.InventoryLotId,
    });
    return {
      InventoryLotId: existing.InventoryLotId,
      request,
      status: "reconciled",
    };
  }

  const result = await dynamics.createSalesOrderLine({
    ...request,
    lineDescription: externalIdempotencyKey,
  });
  await markRefundLineCreated({
    refundId,
    claimToken,
    d365OrderNumber: request.salesOrderNumber,
    inventoryLotId: result.InventoryLotId,
  });

  return {
    InventoryLotId: result.InventoryLotId,
    request: { ...request, lineDescription: externalIdempotencyKey },
    status: "created",
  };
}
