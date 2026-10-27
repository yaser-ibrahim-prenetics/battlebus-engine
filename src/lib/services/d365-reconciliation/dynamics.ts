import { config } from "@/lib/config";
import { authenticate } from "@/lib/clients/dynamics";
import { odataRows } from "@/lib/clients/dynamics/odata-pages";
import {
  dynamicsQuery,
  salesIdsFilter,
  timeFilter,
} from "@/lib/queries/d365-reconciliation/dynamics";
import { companies, type Company, type CompanyOrders, type Kind, type Window } from "./types";
import { inWindow } from "./window";

type Header = {
  dataAreaId: string;
  SalesOrderNumber: string;
  THK_ShopifyReference: string | null;
  OrderCreationDateTime: string;
};
type Slip = { dataAreaId: string; SalesId: string; DeliveryDate: string };
function assertCompany(row: { dataAreaId: string }, company: Company) {
  if (row.dataAreaId?.toUpperCase() !== company)
    throw new Error("Dynamics returned an unexpected company");
}

async function packingSlipReferences(
  company: Company,
  ids: string[],
  token: string
): Promise<Set<string>> {
  const names = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 30) {
    const batch = ids.slice(offset, offset + 30);
    const headers = new Map<string, string | null>();
    const url = dynamicsQuery(
      config.dynamics.baseUrl,
      "SalesOrderHeadersV3",
      company,
      salesIdsFilter(batch),
      "SalesOrderNumber,THK_ShopifyReference"
    );
    for await (const header of odataRows<Header>(url, token)) {
      assertCompany(header, company);
      headers.set(header.SalesOrderNumber, header.THK_ShopifyReference);
    }
    for (const id of batch) {
      if (!headers.has(id))
        throw new Error("Dynamics packing slip has no corresponding sales-order header");
      const reference = headers.get(id);
      if (reference?.startsWith(config.reconciliation.orderPrefix)) names.add(reference);
    }
  }
  return names;
}

export async function dynamicsOrderNames(kind: Kind, window: Window): Promise<CompanyOrders> {
  const { access_token: token } = await authenticate();
  if (!token) throw new Error("Dynamics authentication returned no access token");
  const names: CompanyOrders = { U001: new Set(), H007: new Set() };
  for (const company of companies) {
    if (kind === "salesorder") {
      const url = dynamicsQuery(
        config.dynamics.baseUrl,
        "SalesOrderHeadersV3",
        company,
        timeFilter("OrderCreationDateTime", window),
        "SalesOrderNumber,THK_ShopifyReference,OrderCreationDateTime"
      );
      for await (const header of odataRows<Header>(url, token)) {
        assertCompany(header, company);
        if (!header.SalesOrderNumber) throw new Error("Dynamics header missing sales-order number");
        if (
          inWindow(header.OrderCreationDateTime, window) &&
          header.THK_ShopifyReference?.startsWith(config.reconciliation.orderPrefix)
        )
          names[company].add(header.THK_ShopifyReference);
      }
    } else {
      const ids = new Set<string>();
      const url = dynamicsQuery(
        config.dynamics.baseUrl,
        "CustPackingSlipTransBiEntities",
        company,
        timeFilter("DeliveryDate", window),
        "SalesId,DeliveryDate"
      );
      for await (const slip of odataRows<Slip>(url, token)) {
        assertCompany(slip, company);
        if (!slip.SalesId) throw new Error("Dynamics packing slip missing sales-order number");
        if (inWindow(slip.DeliveryDate, window)) ids.add(slip.SalesId);
      }
      names[company] = await packingSlipReferences(company, [...ids], token);
    }
  }
  return names;
}
