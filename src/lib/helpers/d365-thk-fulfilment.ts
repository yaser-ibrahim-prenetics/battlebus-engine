/**
 * THK fulfilment API often returns status=1 with informational Message text
 * (e.g. warehouse dimension on inventory transactions). Those are success when
 * status=1 — same as spock-store / historical Hub behaviour.
 */

import type { D365FulfilmentLine, D365FulfilmentRequest } from "@/lib/types/dynamics";

/** Informational THK text on status=1 — do not fail fulfilment or queue backorders. */
export const THK_FULFILMENT_INFORMATIONAL_WARNING_HINTS = [
  "dimension warehouse is still specified",
  "dimension site is still specified",
  "number of vouchers posted to the journal",
] as const;

/** Substrings that indicate D365 did not fully invoice / close fulfilment. */
export const THK_FULFILMENT_BLOCKING_MESSAGE_HINTS = [
  "not fully invoiced",
  "failed to invoice",
  "could not be invoiced",
  "cannot be invoiced",
] as const;

const BENIGN_THK_MESSAGES = new Set([
  "fulfilment_already_processed",
  "dry run success",
  "mock_success",
]);

export function isThkFulfilmentInformationalWarning(
  message: string | null | undefined
): boolean {
  const normalized = String(message || "").trim().toLowerCase();
  if (!normalized) return false;
  return THK_FULFILMENT_INFORMATIONAL_WARNING_HINTS.some((hint) =>
    normalized.includes(hint)
  );
}

/** Non-blocking THK warning text to surface in logs/Hub when status=1. */
export function getThkFulfilmentWarningMessage(
  message: string | null | undefined
): string | null {
  const trimmed = String(message || "").trim();
  if (!trimmed || BENIGN_THK_MESSAGES.has(trimmed.toLowerCase())) {
    return null;
  }
  return isThkFulfilmentInformationalWarning(trimmed) ? trimmed : null;
}

/**
 * Returns the matched blocking hint, or null when the THK message is acceptable.
 */
export function getThkFulfilmentBlockingIssue(
  message: string | null | undefined
): string | null {
  const normalized = String(message || "").trim().toLowerCase();
  if (!normalized || BENIGN_THK_MESSAGES.has(normalized)) {
    return null;
  }
  if (isThkFulfilmentInformationalWarning(normalized)) {
    return null;
  }
  for (const hint of THK_FULFILMENT_BLOCKING_MESSAGE_HINTS) {
    if (normalized.includes(hint)) {
      return hint;
    }
  }
  return null;
}

export function isThkFulfilmentIncompleteError(message: string): boolean {
  const m = String(message || "");
  if (m.includes("[D365] THK fulfilment incomplete")) {
    return true;
  }
  if (m.includes("Deposit shipment missing Standard invoice")) {
    return true;
  }
  if (m.includes("no invoice voucher posted for deposit shipment")) {
    return true;
  }
  return getThkFulfilmentBlockingIssue(m) !== null;
}

/** THK embeds this when a customer invoice voucher was posted during fulfilment. */
export function hasThkInvoiceVoucherPosted(
  message: string | null | undefined
): boolean {
  return /number of vouchers posted to the journal:\s*\d+/i.test(String(message || ""));
}

export function normalizeSalesOrderProcessingStatus(
  processingStatus: string | null | undefined
): string {
  return String(processingStatus || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

export function isSalesOrderPartiallyInvoiced(
  processingStatus: string | null | undefined
): boolean {
  const normalized = normalizeSalesOrderProcessingStatus(processingStatus);
  return normalized.includes("partiallyinvoiced") || normalized.includes("partially");
}

export function isSalesOrderFullyInvoiced(
  processingStatus: string | null | undefined
): boolean {
  const normalized = normalizeSalesOrderProcessingStatus(processingStatus);
  if (!normalized || normalized.includes("partially")) {
    return false;
  }
  return normalized === "invoiced" || normalized.includes("fullyinvoiced");
}

/** Deposit lane: prepayment posted at order create — header should be PartiallyInvoiced. */
export function isDepositFulfillmentOrder(fields: {
  depositFulfillment?: string | null;
  processingStatus?: string | null;
}): boolean {
  if (String(fields.depositFulfillment || "").trim().toLowerCase() === "yes") {
    return true;
  }
  return isSalesOrderPartiallyInvoiced(fields.processingStatus);
}

/**
 * Deposit-fulfillment orders must post a Standard invoice voucher on shipment.
 * THK often returns status=1 with only an OPS-WH02 warehouse warning and no voucher
 * count — packing slip posts but Standard invoice does not.
 */
export function assertDepositShipmentThkInvoiced(
  response: { Message?: string | null },
  salesOrderNumber: string
): void {
  assertThkFulfilmentSucceeded(response, salesOrderNumber);
  const msg = String(response.Message || "").trim();
  if (!msg || BENIGN_THK_MESSAGES.has(msg.toLowerCase())) {
    return;
  }
  if (/^success$/i.test(msg)) {
    return;
  }
  if (isThkFulfilmentInformationalWarning(msg) && !hasThkInvoiceVoucherPosted(msg)) {
    throw new Error(
      `[D365] THK fulfilment incomplete for ${salesOrderNumber}: ${msg} (no invoice voucher posted for deposit shipment)`
    );
  }
}

/**
 * Throws when THK status is success but Message indicates incomplete invoicing.
 * Warehouse dimension warnings on status=1 are ignored (informational only).
 */
export function assertThkFulfilmentSucceeded(
  response: { Message?: string | null },
  salesOrderNumber: string
): void {
  const issue = getThkFulfilmentBlockingIssue(response.Message);
  if (!issue) {
    return;
  }
  const detail = String(response.Message || "").trim();
  throw new Error(
    `[D365] THK fulfilment incomplete for ${salesOrderNumber}: ${detail}`
  );
}

export interface BuildThkFulfilmentRequestBodyInput {
  dataAreaId: string;
  type: D365FulfilmentRequest["type"];
  salesOrderNumber: string;
  confirmedShippedDate: string;
  lines: D365FulfilmentLine[];
}

/**
 * Builds the THK `_dataContract` body for `/fulfilment`.
 *
 * - `shipment`: Site + Lotid only (warehouse from SO line reservation).
 * - `return` (refunds): Site + Lotid + Warehouse + Location from return profile;
 *   U001 sends empty Warehouse/Location strings (spock-store parity).
 */
export function buildThkFulfilmentRequestBody(input: BuildThkFulfilmentRequestBodyInput): {
  _dataContract: {
    DataAreaId: string;
    Type: D365FulfilmentRequest["type"];
    D365FOSalesOrder: string;
    ConfirmedShippedDate: string;
    Lines: Record<string, unknown>[];
  };
} {
  const normalizedDataAreaId = String(input.dataAreaId || "").toUpperCase();
  const isReturn = input.type === "return";

  return {
    _dataContract: {
      DataAreaId: input.dataAreaId,
      Type: input.type,
      D365FOSalesOrder: input.salesOrderNumber,
      ConfirmedShippedDate: input.confirmedShippedDate,
      Lines: input.lines.map((line) => {
        const fulfilmentLine: Record<string, unknown> = {
          ItemNumber: line.itemNumber,
          Quantity: line.quantity,
          Site: line.shippingSiteId,
          TrackingNumber: line.trackingNumber,
          Lotid: line.lotId,
        };

        if (isReturn && line.shippingWarehouseId && line.shippingWarehouseLocationId) {
          if (normalizedDataAreaId === "U001") {
            fulfilmentLine["Warehouse"] = "";
            fulfilmentLine["Location"] = "";
          } else {
            fulfilmentLine["Warehouse"] = line.shippingWarehouseId;
            fulfilmentLine["Location"] = line.shippingWarehouseLocationId;
          }
        }

        return fulfilmentLine;
      }),
    },
  };
}
