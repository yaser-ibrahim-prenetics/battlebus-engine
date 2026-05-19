/**
 * THK fulfilment API can return status=1 while Message contains blocking warnings
 * (e.g. warehouse dimension on inventory transactions). Those must not be treated
 * as invoiced / fulfilled — callers should fail and route to fulfilment backlog.
 */

/** Substrings (lowercase) that indicate D365 did not fully invoice / close fulfilment. */
export const THK_FULFILMENT_BLOCKING_MESSAGE_HINTS = [
  "dimension warehouse is still specified",
  "dimension site is still specified",
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
