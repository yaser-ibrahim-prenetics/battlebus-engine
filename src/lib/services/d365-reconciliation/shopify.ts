import { config } from "@/lib/config";
import { shopifyAdminGraphql } from "@/lib/clients/shopify";
import { paidOrdersQuery, fulfillmentEventsQuery } from "@/lib/queries/d365-reconciliation/shopify";
import { days, inWindow } from "./window";
import type { Kind, Window } from "./types";

type Node = {
  name?: string;
  createdAt: string;
  cancelledAt?: string | null;
  displayFinancialStatus?: string;
  action?: string;
  subjectType?: string;
  subject?: { name?: string } | null;
};
type Page = { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

export async function shopifyOrderNames(
  kind: Kind,
  window: Window,
  now = new Date()
): Promise<Set<string>> {
  const oldestEvent = new Date(now);
  oldestEvent.setUTCFullYear(oldestEvent.getUTCFullYear() - 1);
  if (kind === "fulfillment" && Date.parse(window.start) < oldestEvent.getTime())
    throw new Error("Shopify fulfillment events outside the one-year retention window");
  const names = new Set<string>();
  for (const day of days(window)) {
    const search =
      `created_at:>='${day.start}' created_at:<'${day.end}' ` +
      (kind === "salesorder"
        ? "(financial_status:paid OR financial_status:refunded OR financial_status:partially_refunded) -status:cancelled"
        : "action:fulfillment_success subject_type:ORDER");
    let cursor: string | null = null;
    const visited = new Set<string>();
    for (let pageNumber = 0; ; pageNumber++) {
      if (pageNumber >= 1000) throw new Error("Shopify reconciliation page limit exceeded");
      const response: { data?: { orders?: Page; events?: Page } } = await shopifyAdminGraphql(
        kind === "salesorder" ? paidOrdersQuery : fulfillmentEventsQuery,
        { search, cursor },
        { apiVersion: config.reconciliation.shopifyApiVersion }
      );
      const page = kind === "salesorder" ? response.data?.orders : response.data?.events;
      if (!page || !Array.isArray(page.nodes) || typeof page.pageInfo?.hasNextPage !== "boolean")
        throw new Error("Incomplete Shopify reconciliation page");
      for (const node of page.nodes) {
        if (!inWindow(node.createdAt, day)) continue;
        if (
          kind === "salesorder" &&
          (node.cancelledAt ||
            !["PAID", "REFUNDED", "PARTIALLY_REFUNDED"].includes(node.displayFinancialStatus || ""))
        )
          throw new Error("Shopify paid-order query returned an unexpected financial state");
        if (
          kind === "fulfillment" &&
          (node.action !== "fulfillment_success" || node.subjectType !== "ORDER")
        )
          throw new Error("Shopify returned an unexpected fulfillment event");
        const name = kind === "salesorder" ? node.name : node.subject?.name;
        if (!name) throw new Error("Shopify reconciliation record missing order name");
        if (name.startsWith(config.reconciliation.orderPrefix)) names.add(name);
      }
      if (!page.pageInfo.hasNextPage) break;
      const next = page.pageInfo.endCursor;
      if (!next || visited.has(next))
        throw new Error("Shopify pagination missing or repeated cursor");
      visited.add(next);
      cursor = next;
    }
  }
  return names;
}
