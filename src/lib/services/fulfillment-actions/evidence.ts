import { isSalesOrderFullyInvoiced } from "@/lib/helpers/d365-thk-fulfilment";
import type { FulfillmentRecoveryContext } from "./recovery-context";
import type { HeaderEvidence, SlipEvidence } from "@/lib/clients/dynamics/reconciliation";
import { fingerprint } from "./identity";

/** A unique full packing slip plus a fully invoiced header proves shipment completion.
 * Partial/uninvoiced orders remain uncertain; a packing slip alone does not prove finance.
 */
export function matchShipmentEvidence(
  context: FulfillmentRecoveryContext,
  headers: HeaderEvidence[],
  slips: SlipEvidence[]
) {
  if (context.version !== 1 || context.kind !== "d365_shipment" || headers.length !== 1)
    return null;
  const header = headers[0];
  if (
    header.dataAreaId.toUpperCase() !== context.company ||
    header.SalesOrderNumber !== context.salesOrderNumber ||
    !isSalesOrderFullyInvoiced(header.SalesOrderProcessingStatus)
  )
    return null;
  const normalize = (lines: FulfillmentRecoveryContext["lines"]) => {
    const values = new Map<string, number>();
    for (const line of lines) {
      if (!line.lotId || !line.itemNumber || !Number.isFinite(line.quantity) || line.quantity <= 0)
        return null;
      const key = JSON.stringify([line.lotId, line.itemNumber]);
      values.set(key, (values.get(key) ?? 0) + line.quantity);
    }
    return [...values].sort(([a], [b]) => a.localeCompare(b));
  };
  const expected = normalize(context.lines);
  if (!expected?.length) return null;
  const documents = new Map<string, FulfillmentRecoveryContext["lines"]>();
  for (const slip of slips) {
    if (
      slip.dataAreaId?.toUpperCase() !== context.company ||
      slip.SalesId !== context.salesOrderNumber
    )
      return null;
    if (!slip.PackingSlipId || !slip.DeliveryDate) return null;
    if (slip.DeliveryDate.slice(0, 10) !== context.postingDate.slice(0, 10)) continue;
    const lines = documents.get(slip.PackingSlipId) ?? [];
    lines.push({ lotId: slip.InventTransId, itemNumber: slip.ItemId, quantity: Number(slip.Qty) });
    documents.set(slip.PackingSlipId, lines);
  }
  const matches = [...documents].filter(
    ([, lines]) => fingerprint(normalize(lines)) === fingerprint(expected)
  );
  if (matches.length !== 1) return null;
  return {
    documentId: matches[0][0],
    company: context.company,
    salesOrderNumber: context.salesOrderNumber,
    postingDate: context.postingDate,
    lines: expected,
    processingStatus: header.SalesOrderProcessingStatus,
  };
}
