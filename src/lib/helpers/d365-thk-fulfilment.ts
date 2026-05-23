/**
 * THK fulfilment API often returns status=1 with informational Message text
 * (e.g. warehouse dimension on inventory transactions). Those are success when
 * status=1 — same as spock-store / historical Hub behaviour.
 */

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

export function isSalesOrderFullyInvoiced(
  processingStatus: string | null | undefined
): boolean {
  const normalized = String(processingStatus || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (!normalized || normalized.includes("partially")) {
    return false;
  }
  return normalized === "invoiced" || normalized.includes("fullyinvoiced");
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
