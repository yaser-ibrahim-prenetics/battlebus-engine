import { config } from "@/lib/config";
import { authenticate } from "@/lib/clients/dynamics";
import { dynamicsQuery } from "@/lib/queries/d365-reconciliation/dynamics";
import {
  headerEvidenceFields,
  lineEvidenceFields,
  slipEvidenceFields,
  literal,
} from "@/lib/queries/d365-reconciliation/evidence";
import type { Company } from "@/lib/services/d365-reconciliation/types";
import { odataRows } from "./odata-pages";
export interface HeaderEvidence {
  dataAreaId: string;
  SalesOrderNumber: string;
  THK_ShopifyReference: string;
  CurrencyCode: string;
  SalesOrderProcessingStatus: string;
}
export interface LineEvidence {
  dataAreaId: string;
  SalesOrderNumber: string;
  ItemNumber: string;
  InventoryLotId: string;
  OrderedSalesQuantity: number;
  SalesPrice: number;
  LineDiscountAmount: number;
  CurrencyCode: string;
}
export interface SlipEvidence {
  dataAreaId: string;
  SalesId: string;
  PackingSlipId: string;
  InventTransId: string;
  ItemId: string;
  Qty: number;
  DeliveryDate: string;
}
async function rows<T extends { dataAreaId: string }>(
  company: Company,
  entity: string,
  filter: string,
  select: string,
  limit?: number
): Promise<T[]> {
  const { access_token } = await authenticate();
  if (!access_token) throw new Error("Dynamics authentication returned no access token");
  const result: T[] = [];
  const url = dynamicsQuery(config.dynamics.baseUrl, entity, company, filter, select);
  if (limit) url.searchParams.set("$top", String(limit));
  for await (const row of odataRows<T>(url, access_token)) {
    if (row.dataAreaId?.toUpperCase() !== company)
      throw new Error("Dynamics evidence company mismatch");
    result.push(row);
    if (limit && result.length >= limit) break;
  }
  return result;
}
export const readHeadersForReference = (company: Company, reference: string) =>
  rows<HeaderEvidence>(
    company,
    "SalesOrderHeadersV3",
    `THK_ShopifyReference eq ${literal(reference)}`,
    headerEvidenceFields
  );
export const readHeaderEvidence = (company: Company, order: string) =>
  rows<HeaderEvidence>(
    company,
    "SalesOrderHeadersV3",
    `SalesOrderNumber eq ${literal(order)}`,
    headerEvidenceFields
  );
export const readLineEvidence = (company: Company, order: string) =>
  rows<LineEvidence>(
    company,
    "SalesOrderLines",
    `SalesOrderNumber eq ${literal(order)}`,
    lineEvidenceFields
  );
export const readSlipEvidence = (company: Company, order: string) =>
  rows<SlipEvidence>(
    company,
    "CustPackingSlipTransBiEntities",
    `SalesId eq ${literal(order)}`,
    slipEvidenceFields
  );

/** Require a company-scoped header plus schema access; empty/unknown companies fail closed. */
export async function probeDynamicsEvidence(company: Company) {
  const headers = await rows<HeaderEvidence>(
    company,
    "SalesOrderHeadersV3",
    "1 eq 1",
    headerEvidenceFields,
    1
  );
  if (!headers[0]?.SalesOrderNumber)
    throw new Error("Dynamics company identity has no verifiable order evidence");
  for (const [entity, select] of [
    ["SalesOrderHeadersV3", headerEvidenceFields],
    ["SalesOrderLines", lineEvidenceFields],
    ["CustPackingSlipTransBiEntities", slipEvidenceFields],
  ])
    await rows(company, entity, "1 eq 0", select);
  return { company, origin: new URL(config.dynamics.baseUrl).origin, schema: "verified" as const };
}
