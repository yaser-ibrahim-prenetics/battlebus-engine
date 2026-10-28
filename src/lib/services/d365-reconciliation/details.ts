import {
  readHeadersForReference,
  readLineEvidence,
  readSlipEvidence,
} from "@/lib/clients/dynamics/reconciliation";
import { companies, type Kind, type Window } from "./types";
import { inWindow } from "./window";
import { compareFinancialLines, type FinancialLine } from "./financial-comparison";
import { expectedOrderEvidence } from "./expected";

export async function compareOrderDetails(names: Set<string>, kind: Kind, window: Window) {
  if (names.size > 2000)
    throw new Error("Detailed reconciliation exceeds 2000 orders; use a smaller window");
  const differences = [];
  for (const name of [...names].sort()) {
    const expected = await expectedOrderEvidence(name, kind, window);
    const actual: FinancialLine[] = [];
    for (const company of companies) {
      const headers = await readHeadersForReference(company, name);
      const seen = new Set<string>();
      for (const header of headers) {
        if (!header.SalesOrderNumber || seen.has(header.SalesOrderNumber))
          throw new Error("Duplicate or incomplete D365 header evidence");
        seen.add(header.SalesOrderNumber);
        if (kind === "salesorder") {
          for (const line of await readLineEvidence(company, header.SalesOrderNumber)) {
            if (
              line.SalesOrderNumber !== header.SalesOrderNumber ||
              !line.CurrencyCode ||
              !Number.isFinite(Number(line.OrderedSalesQuantity)) ||
              !Number.isFinite(Number(line.SalesPrice)) ||
              !Number.isFinite(Number(line.LineDiscountAmount))
            )
              throw new Error("Incomplete D365 line evidence");
            // Refunds append negative financial lines; original sale reconciliation compares positive lines.
            if (Number(line.OrderedSalesQuantity) <= 0) continue;
            actual.push({
              company,
              item: line.ItemNumber,
              currency: line.CurrencyCode,
              quantity: Number(line.OrderedSalesQuantity),
              amountCents: Math.round(
                (Number(line.SalesPrice) - Number(line.LineDiscountAmount)) *
                  Number(line.OrderedSalesQuantity) *
                  100
              ),
            });
          }
        } else {
          for (const line of await readSlipEvidence(company, header.SalesOrderNumber)) {
            if (line.SalesId !== header.SalesOrderNumber || !Number.isFinite(Number(line.Qty)))
              throw new Error("Incomplete D365 packing-slip evidence");
            if (!inWindow(line.DeliveryDate, window) || Number(line.Qty) <= 0) continue;
            actual.push({
              company,
              item: line.ItemId,
              currency: "QUANTITY",
              quantity: Number(line.Qty),
              amountCents: 0,
            });
          }
        }
      }
    }
    const issues = compareFinancialLines(expected, actual);
    if (issues.length) differences.push({ orderName: name, issues });
  }
  return differences;
}
