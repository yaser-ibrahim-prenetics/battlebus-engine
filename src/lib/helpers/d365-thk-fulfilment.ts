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
  return getThkFulfilmentBlockingIssue(m) !== null;
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
